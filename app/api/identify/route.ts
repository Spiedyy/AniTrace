import { NextRequest } from "next/server";
import { fetchTikTokVideo } from "@/lib/tikwm";
import { searchByBuffer } from "@/lib/tracemoe";
import { bytesFromDataUrl, isValidSearchImage } from "@/lib/image-bytes";
import { getMediaByAnilistId, searchMediaByTitle, type AniListMedia } from "@/lib/anilist";
import { getAnimeById, searchAnimeByTitle, cleanSearchTitle, JikanAnime } from "@/lib/jikan";
import { extractFrames, framesForAiIdentification, type ExtractedFrame } from "@/lib/frame-extractor";
import { identifyAnimeFromImages, readAnimeNamesFromSlide } from "@/lib/ai-identify";
import {
  fetchComments,
  extractNameCandidates, extractCandidatesFromComments,
  collectReplyCandidates,
  type TikCommentCandidate,
} from "@/lib/tiktok-comments";
import { extractTitleCandidates } from "@/lib/title-parser";
import type { AnimeResult, TraceMoeResult, IdentifyResponse } from "@/types";
import { TIKTOK_URL_REGEX } from "@/lib/tiktok-url";

export const maxDuration = 60;

/** Leave headroom before Vercel's hard kill (maxDuration). */
const IDENTIFY_DEADLINE_MS = process.env.VERCEL ? 55_000 : 120_000;
const MAX_TRACE_MOE_SEARCHES = process.env.VERCEL ? 8 : 36;
/** Jikan sleep + fetch — reserve this much before starting a fallback batch. */
const JIKAN_CALL_BUDGET_MS = 800;
// TikTok clips often have text overlays and color grading that reduce trace.moe similarity by 5–10%.
// Single frame needs good confidence; consensus across 2+ frames is more reliable.
const MIN_SIMILARITY_SINGLE = 0.80;
const MIN_SIMILARITY_CONSENSUS = 0.70;

/** Extract hashtag words from a TikTok video title, lowercased and stripped of punctuation. */
function extractHashtags(title: string): Set<string> {
  const tags = new Set<string>();
  for (const match of title.matchAll(/#([a-zA-Z0-9_]+)/g)) {
    tags.add(match[1].toLowerCase().replace(/_/g, ""));
  }
  return tags;
}

/**
 * Returns true if any of the candidate title strings share a hashtag with the TikTok title.
 * Normalises by stripping spaces, punctuation, and lowercasing before comparing.
 */
function titleMatchesHashtag(
  hashtags: Set<string>,
  ...candidateTitles: (string | null | undefined)[]
): boolean {
  if (hashtags.size === 0) return false;
  for (const candidate of candidateTitles) {
    if (!candidate) continue;
    const norm = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const tag of hashtags) {
      if (norm.includes(tag) || tag.includes(norm.slice(0, Math.max(tag.length - 2, 4)))) {
        return true;
      }
    }
  }
  return false;
}

function mapJikanToAnimeResult(
  jikan: JikanAnime,
  traceMoeResult: TraceMoeResult
): AnimeResult {
  return {
    malId: jikan.mal_id,
    title: jikan.title,
    titleEnglish: jikan.title_english ?? null,
    titleJapanese: jikan.title_japanese ?? null,
    imageUrl:
      jikan.images?.jpg?.large_image_url ??
      jikan.images?.jpg?.image_url ??
      "",
    synopsis: jikan.synopsis ?? "",
    score: jikan.score ?? 0,
    episodes: jikan.episodes ?? null,
    status: jikan.status ?? "Unknown",
    rating: jikan.rating ?? "Unknown",
    season: jikan.season ?? null,
    year: jikan.year ?? null,
    genres: (jikan.genres ?? []).map((g: { name: string }) => g.name),
    studios: (jikan.studios ?? []).map((s: { name: string }) => s.name),
    malUrl: jikan.url ?? `https://myanimelist.net/anime/${jikan.mal_id}`,
    trailerUrl: jikan.trailer?.url ?? null,
    similarity: traceMoeResult.similarity,
    matchedEpisode: traceMoeResult.episode,
  };
}

function mapAniListToAnimeResult(
  media: AniListMedia,
  traceMoeResult: TraceMoeResult
): AnimeResult | null {
  if (!media.idMal) return null;
  const synopsis = (media.description ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
  return {
    malId: media.idMal,
    title: media.title.english ?? media.title.romaji,
    titleEnglish: media.title.english ?? null,
    titleJapanese: media.title.native ?? null,
    imageUrl: media.coverImage?.large ?? "",
    synopsis,
    score: media.averageScore ? media.averageScore / 10 : 0,
    episodes: media.episodes ?? null,
    status: media.status ?? "Unknown",
    rating: "Unknown",
    season: media.season?.toLowerCase() ?? null,
    year: media.seasonYear ?? null,
    genres: media.genres ?? [],
    studios: (media.studios?.nodes ?? []).map((s) => s.name),
    malUrl: `https://myanimelist.net/anime/${media.idMal}`,
    trailerUrl: null,
    similarity: traceMoeResult.similarity,
    matchedEpisode: traceMoeResult.episode,
  };
}

/**
 * Resolve a title to anime details — Jikan first, AniList fallback when MAL is down.
 */
async function resolveAnimeByTitle(
  title: string,
  seenMalIds: Set<number>
): Promise<{ animeResult: AnimeResult; source: "jikan" | "anilist" } | null> {
  const queries = [...new Set([title, cleanSearchTitle(title)].filter(Boolean))];

  for (const q of queries) {
    try {
      const jikanAnime = await searchAnimeByTitle(q);
      if (jikanAnime && !seenMalIds.has(jikanAnime.mal_id)) {
        const synthetic: TraceMoeResult = {
          anilist: 0, filename: q, episode: null,
          from: 0, to: 0, similarity: 0, video: "", image: "",
        };
        return {
          animeResult: mapJikanToAnimeResult(jikanAnime, synthetic),
          source: "jikan",
        };
      }
    } catch { /* try AniList */ }
  }

  for (const q of queries) {
    try {
      const media = await searchMediaByTitle(q);
      if (!media?.idMal || seenMalIds.has(media.idMal)) continue;
      // Prefer full Jikan details when we have a MAL id
      const jikanAnime = await getAnimeById(media.idMal);
      if (jikanAnime && !seenMalIds.has(jikanAnime.mal_id)) {
        const synthetic: TraceMoeResult = {
          anilist: 0, filename: q, episode: null,
          from: 0, to: 0, similarity: 0, video: "", image: "",
        };
        return {
          animeResult: mapJikanToAnimeResult(jikanAnime, synthetic),
          source: "jikan",
        };
      }
      const synthetic: TraceMoeResult = {
        anilist: 0, filename: q, episode: null,
        from: 0, to: 0, similarity: 0, video: "", image: "",
      };
      const animeResult = mapAniListToAnimeResult(media, synthetic);
      if (animeResult) return { animeResult, source: "anilist" };
    } catch { /* try next query */ }
  }

  return null;
}

interface TraceMoeGroup {
  anilistId: number;
  results: TraceMoeResult[];
  avgSimilarity: number;
  /** Filename from the highest-similarity result — used as Jikan title-search fallback. */
  bestFilename: string;
}

function getBestMatches(
  allResults: TraceMoeResult[],
  minSingle = MIN_SIMILARITY_SINGLE,
  minConsensus = MIN_SIMILARITY_CONSENSUS
): TraceMoeGroup[] {
  const grouped = new Map<number, TraceMoeResult[]>();
  for (const result of allResults) {
    const existing = grouped.get(result.anilist) ?? [];
    existing.push(result);
    grouped.set(result.anilist, existing);
  }

  const groups: TraceMoeGroup[] = [];
  for (const [anilistId, results] of grouped.entries()) {
    const best = results.reduce((a, b) => (a.similarity > b.similarity ? a : b));
    const avgSimilarity = results.reduce((s, r) => s + r.similarity, 0) / results.length;

    const hasConsensus = results.length >= 2 && best.similarity >= minConsensus;
    const isConfident = best.similarity >= minSingle;
    if (!hasConsensus && !isConfident) continue;

    groups.push({ anilistId, results, avgSimilarity, bestFilename: best.filename });
  }

  return groups.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
}

/**
 * Generic TikTok hashtags that are NOT anime titles and must be skipped in
 * the hashtag-based MAL fallback to avoid false positives.
 */
const GENERIC_TAGS = new Set([
  "anime", "edit", "fyp", "foryou", "foryoupage", "viral", "trending",
  "otaku", "manga", "tiktok", "animeedit", "animelover", "animetiktok",
  "amv", "shorts", "iceberg", "top", "best", "recommended", "recommendation",
  "underrated", "mustwatch", "watchlist", "tier", "tierlist", "clip", "clips",
]);

/**
 * Returns trace.moe matches that fell below the confidence thresholds
 * (50 %–80 % similarity band).  These are only surfaced when a TikTok hashtag
 * corroborates them — the visual + textual double-signal recovers the match.
 */
function getLowConfidenceMatches(
  allResults: TraceMoeResult[],
  minSingle = MIN_SIMILARITY_SINGLE,
  minConsensus = MIN_SIMILARITY_CONSENSUS,
  absoluteMin = 0.45
): TraceMoeGroup[] {
  const grouped = new Map<number, TraceMoeResult[]>();
  for (const result of allResults) {
    const existing = grouped.get(result.anilist) ?? [];
    existing.push(result);
    grouped.set(result.anilist, existing);
  }

  const groups: TraceMoeGroup[] = [];
  for (const [anilistId, results] of grouped.entries()) {
    const best = results.reduce((a, b) => (a.similarity > b.similarity ? a : b));
    const avgSimilarity = results.reduce((s, r) => s + r.similarity, 0) / results.length;

    // Skip anything already accepted by getBestMatches at the effective thresholds
    const hasConsensus = results.length >= 2 && best.similarity >= minConsensus;
    const isConfident = best.similarity >= minSingle;
    if (hasConsensus || isConfident) continue;
    if (best.similarity < absoluteMin) continue;

    groups.push({ anilistId, results, avgSimilarity, bestFilename: best.filename });
  }

  return groups.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
}

/**
 * Returns true when the candidate meaningfully overlaps the Jikan anime title.
 * Requires a distinctive word match — common adjectives like "cute" alone are not enough.
 */
function titleOverlap(candidate: string, jikanAnime: JikanAnime): boolean {
  const WEAK_WORDS = new Set([
    "cute", "pretty", "hot", "sexy", "beautiful", "funny", "sad", "good",
    "great", "best", "bad", "girl", "boy", "love", "dark", "blood", "new",
    "the", "and", "for", "with", "from", "this", "that", "she", "her", "him",
  ]);

  const words = candidate
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !WEAK_WORDS.has(w));

  if (words.length === 0) return false;

  const haystack = [
    jikanAnime.title,
    jikanAnime.title_english,
    ...(jikanAnime.title_synonyms ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  // Prefer longer distinctive tokens; one weak adjective must never pass.
  const strong = words.filter((w) => w.length >= 4);
  const pool = strong.length > 0 ? strong : words;
  return pool.some((w) => haystack.includes(w));
}

/** Common Japanese particles that creators omit when smushing titles into hashtags. */
const TITLE_PARTICLES = ["ga", "no", "wo", "wa", "to", "ni", "de", "mo", "ya", "of", "the"];

/**
 * Build MAL/AniList search queries for a concatenated hashtag.
 * e.g. "akamegakill" → "akame ga kill", "killblue" → "kill blue"
 */
function hashtagSearchQueries(tag: string, allowSplits: boolean): string[] {
  if (!allowSplits || tag.length < 5) return [tag];

  const particleQueries: string[] = [];
  const splitQueries: string[] = [];
  const lower = tag.toLowerCase();

  // Particle re-insertion first: "akamegakill" → "akame ga kill"
  for (const particle of TITLE_PARTICLES) {
    let from = 2;
    while (from < lower.length - particle.length - 1) {
      const idx = lower.indexOf(particle, from);
      if (idx < 0) break;
      const before = tag.slice(0, idx);
      const after = tag.slice(idx + particle.length);
      if (before.length >= 2 && after.length >= 2) {
        particleQueries.push(`${before} ${particle} ${after}`);
      }
      from = idx + 1;
    }
  }

  // Single space splits: "killblue" → "kill blue"
  if (tag.length <= 16) {
    for (let i = 2; i <= tag.length - 2; i++) {
      splitQueries.push(`${tag.slice(0, i)} ${tag.slice(i)}`);
    }
  }

  return [...new Set([tag, ...particleQueries, ...splitQueries])];
}

async function tryTitleCandidate(
  text: string,
  likes: number,
  seenMalIds: Set<number>,
  fromNamePattern: boolean,
  similarityForLikes: (likes: number, fromNamePattern: boolean) => number
): Promise<{ animeResult: AnimeResult; hashtagMatch: boolean } | null> {
  const jikanAnime = await searchAnimeByTitle(text);
  if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) return null;
  if (jikanAnime.rating === "Rx - Hentai") return null;
  if (!titleOverlap(text, jikanAnime)) return null;
  seenMalIds.add(jikanAnime.mal_id);
  const synthetic: TraceMoeResult = {
    anilist: 0, filename: text, episode: null,
    from: 0, to: 0, similarity: similarityForLikes(likes, fromNamePattern), video: "", image: "",
  };
  return {
    animeResult: mapJikanToAnimeResult(jikanAnime, synthetic),
    hashtagMatch: fromNamePattern,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  const hasTime = (reserveMs = 0) =>
    Date.now() - startedAt < IDENTIFY_DEADLINE_MS - reserveMs;

  try {
    const body = await request.json();
    const { url: tiktokUrl, excludeMalIds: rawExclude } = body;
    const excludeMalIds: number[] = Array.isArray(rawExclude)
      ? rawExclude.filter((n: unknown) => typeof n === "number")
      : [];

    if (!tiktokUrl || typeof tiktokUrl !== "string") {
      return Response.json(
        { success: false, results: [], error: "URL is required" } satisfies IdentifyResponse,
        { status: 400 }
      );
    }

    if (!TIKTOK_URL_REGEX.test(tiktokUrl.trim())) {
      return Response.json(
        {
          success: false,
          results: [],
          error: "Please provide a valid TikTok URL",
        } satisfies IdentifyResponse,
        { status: 400 }
      );
    }

    // Step 1: Fetch video info via TikWM
    let videoInfo;
    try {
      videoInfo = await fetchTikTokVideo(tiktokUrl.trim());
    } catch {
      return Response.json(
        {
          success: false,
          results: [],
          error:
            "Could not download TikTok video. The video may be private or the URL is invalid.",
        } satisfies IdentifyResponse,
        { status: 422 }
      );
    }

    // Extract hashtags from the TikTok title upfront — used later to boost matching results.
    const titleHashtags = extractHashtags(videoInfo.title);
    console.log("[identify] TikTok title:", videoInfo.title, "| hashtags:", [...titleHashtags]);

    const isSlideshow = !!videoInfo.images?.length;
    console.log(
      "[identify] TikWM ok — duration:", videoInfo.duration,
      "originCover:", !!videoInfo.originCoverUrl,
      "slideshow:", isSlideshow, isSlideshow ? `(${videoInfo.images!.length} slides)` : ""
    );

    // Step 1b: Text candidates from title prose; comments fetched in background.
    const titleCandidates = extractTitleCandidates(videoInfo.title);
    // Non-generic hashtags treated as potential anime titles (e.g. "#killblue" → "Kill Blue").
    // Searched always alongside strong comment candidates, not just as a last resort.
    const hashtagTitleCandidates = [...titleHashtags].filter(
      (tag) => !GENERIC_TAGS.has(tag) && tag.length >= 4 && tag.length <= 30
    );
    console.log("[identify] Title candidates:", titleCandidates, "| Hashtag candidates:", hashtagTitleCandidates);

    const videoSources = [
      videoInfo.hdVideoUrl,
      videoInfo.tikwmProxyUrl,
      videoInfo.videoUrl,
      videoInfo.wmVideoUrl,
    ].filter((u): u is string => !!u);
    const uniqueVideoSources = [...new Set(videoSources)];

    // Start slow I/O early so text early-exit and visual search overlap.
    // Leave ~18s for trace.moe + enrichment after frame extraction.
    const frameDeadlineAt = startedAt + IDENTIFY_DEADLINE_MS - 18_000;
    const framesPromise: Promise<ExtractedFrame[]> =
      !isSlideshow
        ? extractFrames(
            uniqueVideoSources[0],
            videoInfo.duration,
            uniqueVideoSources.slice(1),
            frameDeadlineAt
          )
        : Promise.resolve([]);

    const commentsPromise = fetchComments(tiktokUrl.trim()).then(async (comments) => {
      // 1. Direct "name: [title]" / "sauce: [title]" / "it's [title]" answers.
      const nameCandidates = extractNameCandidates(comments);

      // 2. Fetch replies under name/sauce questions AND high-reply threads.
      //    Answers often live under viral comments, not only under "name?".
      const replyNameCandidates = await collectReplyCandidates(
        tiktokUrl.trim(),
        comments,
        6
      );

      // 3. Heuristic fallback candidates from top-level comments.
      const heuristicCandidates = extractCandidatesFromComments(comments);

      // Merge: name-pattern / replies first (deduplicated), then heuristic.
      const seen = new Set<string>();
      const merged: TikCommentCandidate[] = [];
      for (const c of [...nameCandidates, ...replyNameCandidates, ...heuristicCandidates]) {
        const key = c.text.toLowerCase();
        if (!seen.has(key)) { seen.add(key); merged.push(c); }
      }

      console.log(
        "[identify] Comment candidates:",
        merged.map((c) => `${c.text} (${c.likes}${c.fromNamePattern ? ", name-pattern" : ""})`),
        `(from ${comments.length} comments, ${replyNameCandidates.length} from replies)`
      );
      return merged;
    });

    // Tracks which MAL IDs have already been used — pre-seeded with any user-excluded IDs
    // so "Not this anime" feedback causes them to be invisible to the entire pipeline.
    const seenMalIds = new Set<number>(excludeMalIds);

    // Steps 2 & 3: Text-based identification.
    // For regular (non-slideshow) videos: early-exit on the first confident match —
    // one anime per post is the norm and we avoid expensive visual search entirely.
    // For slideshows: skip early-exit — each slide may show a DIFFERENT anime, so
    // we need to process every slide and collect all matches.
    if (!isSlideshow) {
      for (const candidate of titleCandidates) {
        try {
          const jikanAnime = await searchAnimeByTitle(candidate);
          if (!jikanAnime) continue;
          if (!titleOverlap(candidate, jikanAnime)) {
            console.log(`[identify] Title candidate "${candidate}" → "${jikanAnime.title}" — no overlap, skipping`);
            continue;
          }
          if (seenMalIds.has(jikanAnime.mal_id)) {
            console.log(`[identify] Title candidate "${candidate}" → "${jikanAnime.title}" — excluded by user, skipping`);
            continue;
          }
          console.log(`[identify] Early exit via title: "${candidate}" → "${jikanAnime.title}"`);
          const synthetic: TraceMoeResult = {
            anilist: 0, filename: candidate, episode: null,
            from: 0, to: 0, similarity: 0.90, video: "", image: "",
          };
          return Response.json({
            success: true,
            results: [mapJikanToAnimeResult(jikanAnime, synthetic)],
          } satisfies IdentifyResponse);
        } catch { /* try next */ }
      }

      const commentCandidates = await commentsPromise;
      // Early exit only on strong signals (name:/sauce: answers + reply titles).
      // Weak heuristic comments wait for later fallbacks so they don't beat hashtags.
      const strongCommentCandidates = commentCandidates.filter((c) => c.fromNamePattern);
      for (const { text, likes, fromNamePattern } of strongCommentCandidates) {
        try {
          const jikanAnime = await searchAnimeByTitle(text);
          if (!jikanAnime) {
            // AniList fallback when Jikan is down / misspaced title
            const resolved = await resolveAnimeByTitle(text, seenMalIds);
            if (!resolved) continue;
            if (!titleOverlap(text, {
              title: resolved.animeResult.title,
              title_english: resolved.animeResult.titleEnglish,
              title_synonyms: [],
            })) continue;
            const similarity = fromNamePattern ? 0.93 : likes >= 50 ? 0.88 : 0.82;
            console.log(`[identify] Early exit via comment: "${text}" (${likes} likes) → "${resolved.animeResult.title}"`);
            resolved.animeResult.similarity = similarity;
            return Response.json({
              success: true,
              results: [resolved.animeResult],
            } satisfies IdentifyResponse);
          }
          if (!titleOverlap(text, jikanAnime)) {
            console.log(`[identify] Comment "${text}" (${likes}) → "${jikanAnime.title}" — no overlap, skipping`);
            continue;
          }
          if (seenMalIds.has(jikanAnime.mal_id)) {
            console.log(`[identify] Comment "${text}" (${likes}) → "${jikanAnime.title}" — excluded by user, skipping`);
            continue;
          }
          const similarity = fromNamePattern ? 0.93 : likes >= 50 ? 0.88 : 0.82;
          console.log(`[identify] Early exit via comment: "${text}" (${likes} likes) → "${jikanAnime.title}"`);
          const synthetic: TraceMoeResult = {
            anilist: 0, filename: text, episode: null,
            from: 0, to: 0, similarity, video: "", image: "",
          };
          return Response.json({
            success: true,
            results: [mapJikanToAnimeResult(jikanAnime, synthetic)],
          } satisfies IdentifyResponse);
        } catch { /* try next */ }
      }

      // Hashtag titles (e.g. "#akamegakill" → "Akame ga Kill") — before expensive visual search.
      // Prefer longer tags first; short ones are often character names ("esdeath", "tatsumi").
      const earlyHashtags = [...hashtagTitleCandidates].sort((a, b) => b.length - a.length);
      for (const tag of earlyHashtags.slice(0, 3)) {
        // Particle splits first (cheap + high hit rate), then a few single splits.
        const queries = hashtagSearchQueries(tag, true).slice(0, 6);
        for (const query of queries) {
          try {
            const resolved = await resolveAnimeByTitle(query, seenMalIds);
            if (!resolved) continue;
            if (resolved.animeResult.rating === "Rx - Hentai") continue;
            const isMatch =
              titleOverlap(query, {
                title: resolved.animeResult.title,
                title_english: resolved.animeResult.titleEnglish,
                title_synonyms: [],
              }) ||
              titleMatchesHashtag(
                new Set([tag]),
                resolved.animeResult.title,
                resolved.animeResult.titleEnglish
              );
            if (!isMatch) continue;
            console.log(
              `[identify] Early exit via hashtag: "#${tag}" (query: "${query}") → "${resolved.animeResult.title}"`
            );
            resolved.animeResult.similarity = 0.90;
            return Response.json({
              success: true,
              results: [resolved.animeResult],
            } satisfies IdentifyResponse);
          } catch { /* try next query */ }
        }
      }
    }

    // Steps 2 & 3 produced no early-exit — fall through to visual search.
    // Step 4: Build the list of images to search
    // coverOnly = true when video frame extraction failed and we fell back to cover images.
    // In that mode thresholds are relaxed because we have no better visual source.
    let coverOnly = false;
    const allTraceMoeResults: TraceMoeResult[] = [];
    const debugImages: string[] = [];
    let extractedFrames: ExtractedFrame[] = [];

    // Declared here (before slideshow block) so both slideshow and video paths share them.
    interface EnrichedResult { animeResult: AnimeResult; hashtagMatch: boolean; }
    const enriched: EnrichedResult[] = [];

    const BROWSER_HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://www.tiktok.com/",
    };

    async function searchImageUrl(url: string, label: string) {
      if (!hasTime()) return;
      try {
        const res = await fetch(url, { headers: BROWSER_HEADERS });
        console.log(`[identify] Fetch (${label}) status:`, res.status);
        if (!res.ok) return;
        const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (!isValidSearchImage(bytes)) {
          console.warn(`[identify] (${label}) invalid image — skipping trace.moe`);
          return;
        }
        debugImages.push(`data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
        const result = await searchByBuffer(bytes, mimeType);
        console.log(`[identify] (${label}) trace.moe results:`, result.result?.length ?? 0);
        if (result.result) allTraceMoeResults.push(...result.result);
      } catch (err) {
        console.warn(`[identify] Search failed (${label}):`, err);
      }
    }

    if (isSlideshow) {
      // Photo slideshow — process each slide independently.
      // Each slide may show a DIFFERENT anime, so we:
      //   1. Fetch the slide image
      //   2. If an AI key is set, read visible text (creators print the anime
      //      title on the slide itself) → Jikan lookup → collect unique matches
      //   3. Also send to trace.moe for visual fallback
      const slideSeenMalIds = new Set<number>();
      for (let i = 0; i < videoInfo.images!.length; i++) {
        const slideUrl = videoInfo.images![i];
        const label = `slide ${i + 1}`;
        try {
          const res = await fetch(slideUrl, { headers: BROWSER_HEADERS });
          if (!res.ok) { console.warn(`[identify] (${label}) fetch failed: ${res.status}`); continue; }
          const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
          debugImages.push(dataUrl);

          // Step A: read text printed on the slide
          const slideTextNames = await readAnimeNamesFromSlide(dataUrl);
          if (slideTextNames.length > 0) {
            console.log(`[identify] (${label}) AI read text: ${slideTextNames.join(", ")}`);
            for (const name of slideTextNames) {
              try {
                const jikanAnime = await searchAnimeByTitle(name);
                if (!jikanAnime || slideSeenMalIds.has(jikanAnime.mal_id)) continue;
                if (!titleOverlap(name, jikanAnime)) continue;
                slideSeenMalIds.add(jikanAnime.mal_id);
                seenMalIds.add(jikanAnime.mal_id);
                const synthetic: TraceMoeResult = {
                  anilist: 0, filename: name, episode: null,
                  from: 0, to: 0, similarity: 0.90, video: "", image: "",
                };
                enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: true });
                console.log(`[identify] (${label}) text match: "${jikanAnime.title}"`);
              } catch { /* skip */ }
            }
          }

          // Step B: trace.moe visual fallback
          const traceMoeResult = isValidSearchImage(bytes)
            ? await searchByBuffer(bytes, mimeType).catch(() => null)
            : null;
          if (traceMoeResult?.result) {
            console.log(`[identify] (${label}) trace.moe results: ${traceMoeResult.result.length}`);
            allTraceMoeResults.push(...traceMoeResult.result);
          }
        } catch (err) {
          console.warn(`[identify] (${label}) error:`, err);
        }
      }

      // Also search title/comment candidates for slideshows (no early-exit above)
      const slideshowCommentCandidates = await commentsPromise;
      const slideshowTextCandidates = [...titleCandidates, ...slideshowCommentCandidates.map(c => c.text)];
      for (const candidate of slideshowTextCandidates) {
        try {
          const jikanAnime = await searchAnimeByTitle(candidate);
          if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
          if (jikanAnime.rating === "Rx - Hentai") continue;
          if (!titleOverlap(candidate, jikanAnime)) continue;
          seenMalIds.add(jikanAnime.mal_id);
          const synthetic: TraceMoeResult = {
            anilist: 0, filename: candidate, episode: null,
            from: 0, to: 0, similarity: 0.85, video: "", image: "",
          };
          enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: true });
          console.log(`[identify] Slideshow text match: "${jikanAnime.title}" from "${candidate}"`);
        } catch { /* skip */ }
      }

      // Also search hashtag title candidates for slideshows (e.g. "#haimiyasenpaiwakowakutekawaii")
      // For short tags (≤14 chars) try single-space splits; for longer tags try raw only.
      for (const tag of hashtagTitleCandidates) {
        const queries = [tag];
        if (tag.length <= 14) {
          for (let i = 2; i <= tag.length - 2; i++) {
            queries.push(`${tag.slice(0, i)} ${tag.slice(i)}`);
          }
        }
        let foundTag = false;
        for (const query of queries) {
          if (foundTag) break;
          try {
            const jikanAnime = await searchAnimeByTitle(query);
            if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
            if (jikanAnime.rating === "Rx - Hentai") continue;
            const isMatch = titleOverlap(query, jikanAnime) ||
              titleMatchesHashtag(new Set([tag]), jikanAnime.title, jikanAnime.title_english, ...(jikanAnime.title_synonyms ?? []));
            if (!isMatch) continue;
            seenMalIds.add(jikanAnime.mal_id);
            console.log(`[identify] Slideshow hashtag title: "#${tag}" (query: "${query}") → "${jikanAnime.title}"`);
            const synthetic: TraceMoeResult = {
              anilist: 0, filename: query, episode: null,
              from: 0, to: 0, similarity: 0.88, video: "", image: "",
            };
            enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: true });
            foundTag = true;
          } catch { /* skip */ }
        }
      }
    } else {
      // Regular video — multi-crop frames, biased past intro commentary
      try {
        extractedFrames = await framesPromise;
        console.log("[identify] Extracted frame variants:", extractedFrames.length);
      } catch (err) {
        console.warn("[identify] Frame extraction error:", err);
      }

      let quotaDepleted = false;
      let traceSearchCount = 0;
      for (let i = 0; i < extractedFrames.length; i++) {
        if (quotaDepleted || !hasTime() || traceSearchCount >= MAX_TRACE_MOE_SEARCHES) break;
        const { base64: frame, variant, timestampSec } = extractedFrames[i];
        debugImages.push(frame);
        const frameBytes = bytesFromDataUrl(frame);
        if (!frameBytes) {
          console.warn(`[identify] Frame ${i + 1} ${variant} — invalid JPEG, skipping`);
          continue;
        }
        const frameSizeKB = Math.round(frameBytes.length / 1024);
        try {
          traceSearchCount++;
          const result = await searchByBuffer(frameBytes, "image/jpeg");
          console.log(
            `[identify] Frame ${i + 1} ${variant}@${timestampSec.toFixed(1)}s (${frameSizeKB} KB) results:`,
            result.result?.length ?? 0
          );
          if (result.result) allTraceMoeResults.push(...result.result);

          // Stop early once we have a confident visual match.
          const confident = getBestMatches(allTraceMoeResults);
          if (confident.length > 0 && confident[0].avgSimilarity >= 0.78) {
            console.log(
              `[identify] Early exit — ${(confident[0].avgSimilarity * 100).toFixed(1)}% match at ${variant}@${timestampSec.toFixed(1)}s`
            );
            break;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("skipped: invalid")) {
            console.warn(`[identify] Frame ${i + 1}: invalid image — skipping`);
          } else if (msg.includes(": 402")) {
            console.warn(
              `[identify] Frame ${i + 1}: trace.moe daily quota depleted. ` +
              "Add TRACE_MOE_API_KEY to .env for a higher limit — see trace.moe/account"
            );
            quotaDepleted = true;
          } else {
            console.warn(`[identify] Frame ${i + 1} search failed:`, err);
          }
        }
      }

      // If quota depleted before we finished AND we have no confident results yet,
      // still try the cover image — it costs exactly 1 search call and uses a
      // different CDN path that may not be affected by the same quota counter.
      if (quotaDepleted && allTraceMoeResults.length === 0) {
        console.log("[identify] Quota depleted with no results — attempting cover image as last resort");
        coverOnly = true;
        if (videoInfo.originCoverUrl) await searchImageUrl(videoInfo.originCoverUrl, "origin cover");
      }

      // If frame extraction yielded nothing, fall back to origin/portrait cover
      if (extractedFrames.length === 0) {
        coverOnly = true;
        const coverUrls: string[] = [];
        if (videoInfo.originCoverUrl) coverUrls.push(videoInfo.originCoverUrl);
        coverUrls.push(videoInfo.coverUrl);
        for (let i = 0; i < coverUrls.length; i++) {
          await searchImageUrl(coverUrls[i], i === 0 && videoInfo.originCoverUrl ? "origin cover" : "portrait cover");
          if (allTraceMoeResults.length > 0) break;
        }
      }
    }

    console.log("[identify] Total trace.moe results:", allTraceMoeResults.length);
    if (allTraceMoeResults.length > 0) {
      const top5 = [...allTraceMoeResults]
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5)
        .map((r) => `${(r.similarity * 100).toFixed(1)}% — ${r.filename}`);
      console.log("[identify] Top similarities:\n ", top5.join("\n  "));
    }

    const devExtra = process.env.NODE_ENV === "development" ? { debugImages } : {};

    if (allTraceMoeResults.length === 0) {
      return Response.json({
        success: true,
        results: [],
        error: "No anime found. The video may not contain recognizable anime footage.",
        ...devExtra,
      } satisfies IdentifyResponse);
    }

    // Step 4: Group and rank matches.
    // When only a cover image was available (video download failed), relax thresholds:
    //   single-frame minimum: 0.80 → 0.60
    //   consensus minimum:    0.70 → 0.47
    // A cover image is still a meaningful visual signal even at lower similarity.
    // NOTE: no early-return here — steps 5b/5c may still rescue results.
    if (coverOnly) {
      console.log("[identify] Cover-only mode — using relaxed similarity thresholds (0.60 / 0.47)");
    }
    const effectiveSingle = coverOnly ? 0.60 : MIN_SIMILARITY_SINGLE;
    const effectiveConsensus = coverOnly ? 0.47 : MIN_SIMILARITY_CONSENSUS;
    const bestMatches = getBestMatches(allTraceMoeResults, effectiveSingle, effectiveConsensus);

    // Step 5: Fetch anime details from Jikan for trace.moe best matches (top 5)

    for (const group of bestMatches.slice(0, 5)) {
      if (!hasTime(4_000)) break;
      try {
        const anilistMedia = await getMediaByAnilistId(group.anilistId);
        let jikanAnime: JikanAnime | null = null;

        if (anilistMedia?.idMal) {
          jikanAnime = await getAnimeById(anilistMedia.idMal);
        }

        // Fallback priority: AniList romaji → AniList english → trace.moe filename
        if (!jikanAnime) {
          const fallbackTitle =
            anilistMedia?.title?.english ??
            anilistMedia?.title?.romaji ??
            group.bestFilename;
          jikanAnime = await searchAnimeByTitle(fallbackTitle);
        }

        if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
        seenMalIds.add(jikanAnime.mal_id);

        const bestResult = group.results.reduce((best, r) =>
          r.similarity > best.similarity ? r : best
        );
        const animeResult = mapJikanToAnimeResult(jikanAnime, bestResult);

        // Check if TikTok hashtags corroborate this result
        const hashtagMatch = titleMatchesHashtag(
          titleHashtags,
          jikanAnime.title,
          jikanAnime.title_english,
          anilistMedia?.title?.romaji,
          anilistMedia?.title?.english
        );
        if (hashtagMatch) {
          console.log(`[identify] Hashtag match for: ${jikanAnime.title}`);
        }

        enriched.push({ animeResult, hashtagMatch });
      } catch {
        // Skip this match
      }
    }

    // Step 5b: Hashtag-corroborated low-confidence rescue (or unconditional in cover-only mode).
    // A 55 % trace.moe match + a matching hashtag is reliable — accept it.
    // In cover-only mode, accept the top low-confidence match even without hashtag
    // since there is no better visual source.
    if ((titleHashtags.size > 0 || coverOnly) && hasTime(3_000)) {
      const lowConfMatches = getLowConfidenceMatches(
        allTraceMoeResults,
        effectiveSingle,
        effectiveConsensus,
        coverOnly ? 0.40 : 0.45
      );
      for (const group of lowConfMatches.slice(0, 5)) {
        if (enriched.length >= 5 || !hasTime(2_000)) break;
        try {
          const anilistMedia = await getMediaByAnilistId(group.anilistId);
          let jikanAnime: JikanAnime | null = null;
          if (anilistMedia?.idMal) jikanAnime = await getAnimeById(anilistMedia.idMal);
          if (!jikanAnime) {
            const fallbackTitle =
              anilistMedia?.title?.english ??
              anilistMedia?.title?.romaji ??
              group.bestFilename;
            jikanAnime = await searchAnimeByTitle(fallbackTitle);
          }
          if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
          const corroborated = titleMatchesHashtag(
            titleHashtags,
            jikanAnime.title,
            jikanAnime.title_english,
            anilistMedia?.title?.romaji,
            anilistMedia?.title?.english
          );
          // In cover-only mode accept top candidates even without hashtag confirmation
          // (no better visual source exists).
          if (!corroborated && !coverOnly) continue;
          seenMalIds.add(jikanAnime.mal_id);
          const bestResult = group.results.reduce((best, r) =>
            r.similarity > best.similarity ? r : best
          );
          const animeResult = mapJikanToAnimeResult(jikanAnime, bestResult);
          // Boost displayed similarity: visual match + hashtag confirmation
          animeResult.similarity = Math.max(animeResult.similarity, 0.72);
          console.log(
            `[identify] Hashtag-rescued: ${jikanAnime.title} ` +
            `(trace.moe ${(bestResult.similarity * 100).toFixed(1)}% → boosted)`
          );
          enriched.push({ animeResult, hashtagMatch: true });
        } catch {
          // skip this candidate
        }
      }
    }

    // Step 5c: Pure hashtag fallback — when trace.moe had nothing above threshold
    // and no low-confidence corroboration was found, search MAL directly using hashtags.
    if (enriched.length === 0 && titleHashtags.size > 0 && hasTime(2_000)) {
      console.log("[identify] No visual matches — falling back to pure hashtag MAL search");
      const lateHashtags = [...hashtagTitleCandidates].sort((a, b) => b.length - a.length);
      for (const tag of lateHashtags) {
        if (enriched.length >= 3 || !hasTime(JIKAN_CALL_BUDGET_MS)) break;
        const queries = hashtagSearchQueries(tag, true).slice(0, 6);
        let found = false;
        for (const query of queries) {
          if (found || !hasTime(JIKAN_CALL_BUDGET_MS)) break;
          try {
            const resolved = await resolveAnimeByTitle(query, seenMalIds);
            if (!resolved) continue;
            const isHashtagTitle = titleMatchesHashtag(
              new Set([tag]),
              resolved.animeResult.title,
              resolved.animeResult.titleEnglish
            );
            const overlaps = titleOverlap(query, {
              title: resolved.animeResult.title,
              title_english: resolved.animeResult.titleEnglish,
              title_synonyms: [],
            });
            if (!overlaps && !isHashtagTitle) continue;
            seenMalIds.add(resolved.animeResult.malId);
            resolved.animeResult.similarity = 0.70;
            console.log(`[identify] Hashtag fallback: "#${tag}" (query: "${query}") → "${resolved.animeResult.title}"`);
            enriched.push({
              animeResult: resolved.animeResult,
              hashtagMatch: true,
            });
            found = true;
          } catch {
            // skip
          }
        }
      }
    }

    // Step 5c½: Strong comment answers before AI — fast and often correct.
    if (!isSlideshow && enriched.length === 0 && hasTime(3_000)) {
      const earlyComments = await commentsPromise;
      const strongEarly = earlyComments.filter((c) => c.fromNamePattern).slice(0, 5);
      for (const { text, likes } of strongEarly) {
        if (!hasTime(JIKAN_CALL_BUDGET_MS)) break;
        try {
          const match = await tryTitleCandidate(
            text, likes, seenMalIds, true,
            (l) => (l >= 50 ? 0.91 : l >= 10 ? 0.87 : 0.83)
          );
          if (!match) continue;
          console.log(`[identify] Early comment answer: "${text}" (${likes} likes) → "${match.animeResult.title}"`);
          enriched.push({ ...match, hashtagMatch: true });
        } catch { /* skip */ }
      }
    }

    // Step 5d: AI vision — when nothing matched, or visual matches are too weak
    // (common for reaction/commentary TikToks with tiny inset anime clips).
    const maxVisualSimilarity = allTraceMoeResults.reduce(
      (max, r) => Math.max(max, r.similarity),
      0
    );
    const shouldRunAI =
      enriched.length === 0 ||
      (maxVisualSimilarity > 0 && maxVisualSimilarity < 0.58);

    const aiFrameSource =
      !isSlideshow && extractedFrames.length > 0
        ? framesForAiIdentification(extractedFrames, 8)
        : debugImages;

    if (shouldRunAI && aiFrameSource.length > 0 && hasTime(7_000)) {
      console.log(
        `[identify] Running AI identification (enriched: ${enriched.length}, max visual: ${(maxVisualSimilarity * 100).toFixed(1)}%)`
      );
      try {
        const aiMatch = await identifyAnimeFromImages(aiFrameSource, {
          hashtags: hashtagTitleCandidates,
        });
        if (aiMatch && aiMatch.title) {
          const searchTitles = [
            aiMatch.title,
            ...aiMatch.alternativeTitles,
            // Hashtags often match the AI title with spaces removed — try spaced forms too
            ...hashtagTitleCandidates.filter((tag) => {
              const compact = aiMatch.title.toLowerCase().replace(/[^a-z0-9]/g, "");
              return compact.includes(tag) || tag.includes(compact.slice(0, Math.max(tag.length - 2, 4)));
            }),
          ].filter(Boolean);

          let resolved: Awaited<ReturnType<typeof resolveAnimeByTitle>> = null;
          for (const t of searchTitles) {
            resolved = await resolveAnimeByTitle(t, seenMalIds);
            if (resolved) break;
          }

          if (resolved) {
            seenMalIds.add(resolved.animeResult.malId);
            const confidenceScore =
              aiMatch.confidence === "high" ? 0.92
              : aiMatch.confidence === "medium" ? 0.78
              : 0.62;
            resolved.animeResult.similarity = confidenceScore;
            const hashtagMatch = titleMatchesHashtag(
              titleHashtags,
              resolved.animeResult.title,
              resolved.animeResult.titleEnglish,
            );
            console.log(
              `[identify] AI identified: ${resolved.animeResult.title} ` +
              `(${aiMatch.confidence}, score: ${confidenceScore}, via ${resolved.source})`
            );
            enriched.push({
              animeResult: resolved.animeResult,
              hashtagMatch: aiMatch.confidence !== "low" || hashtagMatch,
            });
          } else {
            console.warn(
              `[identify] AI said "${aiMatch.title}" but Jikan/AniList lookup failed — dropping result`
            );
          }
        }
      } catch (err) {
        console.warn("[identify] AI identification error:", err);
      }
    }

    // Step 5e (non-slideshow): text fallbacks when visual/AI didn't produce a result.
    // Skip entirely when we already have matches — avoids burning the deadline on extras.
    if (!isSlideshow && enriched.length === 0) {
      const commentCandidates = await commentsPromise;

      // 5e-ii: Strong comment candidates (may already be tried in step 5c½)
      const strongCandidates = commentCandidates.filter((c) => c.fromNamePattern);
      if (strongCandidates.length > 0 && enriched.length === 0) {
        console.log("[identify] Strong comment candidates:", strongCandidates.map((c) => c.text));
      }
      for (const { text, likes } of strongCandidates.slice(0, 5)) {
        if (enriched.length > 0 || !hasTime(JIKAN_CALL_BUDGET_MS)) break;
        try {
          const match = await tryTitleCandidate(
            text, likes, seenMalIds, true,
            (l) => (l >= 50 ? 0.91 : l >= 10 ? 0.87 : 0.83)
          );
          if (!match) continue;
          console.log(`[identify] Comment answer: "${text}" (${likes} likes) → "${match.animeResult.title}"`);
          enriched.push({ ...match, hashtagMatch: true });
        } catch { /* skip */ }
      }

      // 5f: Weak heuristic text candidates — cheap, run before expensive hashtag splits.
      if (enriched.length === 0 && hasTime(JIKAN_CALL_BUDGET_MS * 2)) {
        console.log("[identify] All methods failed — trying heuristic text candidates");
        const weakFallbacks = [
          ...commentCandidates.filter((c) => !c.fromNamePattern),
          ...titleCandidates.map((t) => ({ text: t, likes: 0, fromNamePattern: false as const })),
        ].slice(0, 6);

        for (const { text, likes } of weakFallbacks) {
          if (!hasTime(JIKAN_CALL_BUDGET_MS)) {
            console.log("[identify] Deadline reached during weak text fallbacks — returning");
            break;
          }
          try {
            const match = await tryTitleCandidate(
              text, likes, seenMalIds, false,
              (l) => (l >= 50 ? 0.82 : 0.75)
            );
            if (!match) continue;
            console.log(`[identify] Weak text fallback: "${text}" → "${match.animeResult.title}"`);
            enriched.push({ ...match, hashtagMatch: false });
          } catch { /* skip */ }
        }
      } else if (enriched.length === 0) {
        console.log("[identify] Skipping weak text fallbacks — deadline too close");
      }

      // 5e-i: Hashtag title splits — expensive; only when still empty and time remains.
      if (enriched.length === 0 && hasTime(JIKAN_CALL_BUDGET_MS * 3)) {
        const allowSplits = hasTime(6_000);
        for (const tag of hashtagTitleCandidates.slice(0, 3)) {
          if (!hasTime(JIKAN_CALL_BUDGET_MS)) break;
          const queries = hashtagSearchQueries(tag, allowSplits).slice(0, allowSplits ? 8 : 1);
          let foundTag = false;
          for (const query of queries) {
            if (foundTag || !hasTime(JIKAN_CALL_BUDGET_MS)) break;
            try {
              const jikanAnime = await searchAnimeByTitle(query);
              if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
              if (jikanAnime.rating === "Rx - Hentai") continue;
              const isMatch = titleOverlap(query, jikanAnime) ||
                titleMatchesHashtag(new Set([tag]), jikanAnime.title, jikanAnime.title_english, ...(jikanAnime.title_synonyms ?? []));
              if (!isMatch) continue;
              seenMalIds.add(jikanAnime.mal_id);
              console.log(`[identify] Hashtag title: "#${tag}" (query: "${query}") → "${jikanAnime.title}"`);
              const synthetic: TraceMoeResult = {
                anilist: 0, filename: query, episode: null,
                from: 0, to: 0, similarity: 0.88, video: "", image: "",
              };
              enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: true });
              foundTag = true;
            } catch { /* skip */ }
          }
        }
      }
    } else if (!isSlideshow && enriched.length > 0) {
      console.log(`[identify] Skipping text fallbacks — ${enriched.length} match(es) already found`);
    }

    console.log(`[identify] Done in ${Date.now() - startedAt}ms — ${enriched.length} result(s)`);

    // Sort: hashtag-confirmed results first, then by similarity
    enriched.sort((a, b) => {
      if (a.hashtagMatch !== b.hashtagMatch) return a.hashtagMatch ? -1 : 1;
      return b.animeResult.similarity - a.animeResult.similarity;
    });

    if (enriched.length === 0) {
      return Response.json({
        success: true,
        results: [],
        error:
          "Couldn't confidently identify an anime. The video may contain heavily edited content, text overlays, or non-anime footage.",
        ...devExtra,
      } satisfies IdentifyResponse);
    }

    const maxResults = isSlideshow ? enriched.length : 3;
    const results = enriched.slice(0, maxResults).map((e) => e.animeResult);

    return Response.json({
      success: true,
      results,
      ...devExtra,
    } satisfies IdentifyResponse);
  } catch {
    return Response.json(
      {
        success: false,
        results: [],
        error: "An unexpected error occurred. Please try again.",
      } satisfies IdentifyResponse,
      { status: 500 }
    );
  }
}
