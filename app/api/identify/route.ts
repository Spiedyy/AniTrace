import { NextRequest } from "next/server";
import { fetchTikTokVideo } from "@/lib/tikwm";
import { searchByBuffer } from "@/lib/tracemoe";
import { getMediaByAnilistId } from "@/lib/anilist";
import { getAnimeById, searchAnimeByTitle, JikanAnime } from "@/lib/jikan";
import { extractFrames } from "@/lib/frame-extractor";
import { identifyAnimeFromImages, readAnimeNamesFromSlide } from "@/lib/ai-identify";
import {
  fetchComments, fetchCommentReplies,
  extractNameCandidates, extractDirectReplyCandidates, extractCandidatesFromComments,
  isNameQuestion,
  type TikCommentCandidate,
} from "@/lib/tiktok-comments";
import { extractTitleCandidates } from "@/lib/title-parser";
import type { AnimeResult, TraceMoeResult, IdentifyResponse } from "@/types";
import { TIKTOK_URL_REGEX } from "@/lib/tiktok-url";
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
 * Returns true when the candidate string shares at least one significant word
 * with the Jikan anime's titles/synonyms — guards against Jikan returning an
 * unrelated anime for a vague query like "big oppai new waifu".
 */
function titleOverlap(candidate: string, jikanAnime: JikanAnime): boolean {
  const words = candidate
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const haystack = [
    jikanAnime.title,
    jikanAnime.title_english,
    ...(jikanAnime.title_synonyms ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ");

  return words.some((w) => haystack.includes(w));
}

export async function POST(request: NextRequest): Promise<Response> {
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
    const commentsPromise = fetchComments(tiktokUrl.trim()).then(async (comments) => {
      // 1. Direct "name: [title]" answers — highest confidence, processed first.
      const nameCandidates = extractNameCandidates(comments);

      // 2. "name?" questions → fetch their replies to find the answer.
      //    Cap at 3 reply fetches to keep latency reasonable.
      const nameQuestions = comments
        .filter((c) => isNameQuestion(c.text) && c.replyCount > 0 && c.id)
        .slice(0, 3);

      const replyNameCandidates: TikCommentCandidate[] = [];
      for (const qc of nameQuestions) {
        const replies = await fetchCommentReplies(tiktokUrl.trim(), qc.id);
        // extractDirectReplyCandidates handles both "name: [title]" and plain title
        // replies (e.g. "kill blue" with 0 likes), since the name-question context
        // is itself a strong signal that the reply is an anime title.
        const found = extractDirectReplyCandidates(replies);
        if (found.length > 0) {
          console.log(`[identify] Reply answer for "${qc.text.slice(0, 40)}":`, found.map(c => c.text));
          replyNameCandidates.push(...found);
        }
      }

      // 3. Heuristic fallback candidates.
      const heuristicCandidates = extractCandidatesFromComments(comments);

      // Merge: name-pattern first (deduplicated), then heuristic.
      const seen = new Set<string>();
      const merged: TikCommentCandidate[] = [];
      for (const c of [...nameCandidates, ...replyNameCandidates, ...heuristicCandidates]) {
        const key = c.text.toLowerCase();
        if (!seen.has(key)) { seen.add(key); merged.push(c); }
      }

      console.log(
        "[identify] Comment candidates:",
        merged.map((c) => `${c.text} (${c.likes}${c.fromNamePattern ? ", name-pattern" : ""})`),
        `(from ${comments.length} comments)`
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
      for (const { text, likes, fromNamePattern } of commentCandidates) {
        try {
          const jikanAnime = await searchAnimeByTitle(text);
          if (!jikanAnime) continue;
          if (!titleOverlap(text, jikanAnime)) {
            console.log(`[identify] Comment "${text}" (${likes}) → "${jikanAnime.title}" — no overlap, skipping`);
            continue;
          }
          if (seenMalIds.has(jikanAnime.mal_id)) {
            console.log(`[identify] Comment "${text}" (${likes}) → "${jikanAnime.title}" — excluded by user, skipping`);
            continue;
          }
          // "name: [title]" pattern is a very strong explicit signal → boost confidence
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
    }

    // Steps 2 & 3 produced no early-exit — fall through to visual search.
    // Step 4: Build the list of images to search
    // coverOnly = true when video frame extraction failed and we fell back to cover images.
    // In that mode thresholds are relaxed because we have no better visual source.
    let coverOnly = false;
    const allTraceMoeResults: TraceMoeResult[] = [];
    const debugImages: string[] = [];

    // Declared here (before slideshow block) so both slideshow and video paths share them.
    interface EnrichedResult { animeResult: AnimeResult; hashtagMatch: boolean; }
    const enriched: EnrichedResult[] = [];

    const BROWSER_HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Referer: "https://www.tiktok.com/",
    };

    async function searchImageUrl(url: string, label: string) {
      try {
        const res = await fetch(url, { headers: BROWSER_HEADERS });
        console.log(`[identify] Fetch (${label}) status:`, res.status);
        if (!res.ok) return;
        const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
        const buf = await res.arrayBuffer();
        debugImages.push(`data:${mimeType};base64,${Buffer.from(buf).toString("base64")}`);
        const result = await searchByBuffer(buf, mimeType);
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
          const dataUrl = `data:${mimeType};base64,${Buffer.from(buf).toString("base64")}`;
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
          const traceMoeResult = await searchByBuffer(buf, mimeType).catch(() => null);
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
      // Regular video — extract frames with scene detection
      let frames: string[] = [];
      try {
        // Priority order: TikWM proxy (no IP restriction) → HD CDN → plain CDN → watermarked CDN
        const altUrls = [
          videoInfo.hdVideoUrl,
          videoInfo.wmVideoUrl,
        ].filter((u): u is string => !!u);
        frames = await extractFrames(
          videoInfo.tikwmProxyUrl, // try proxy first — immune to TikTok CDN IP-binding
          videoInfo.duration,
          [videoInfo.videoUrl, ...altUrls]  // CDN URLs as fallbacks
        );
        console.log("[identify] Extracted frames:", frames.length);
      } catch (err) {
        console.warn("[identify] Frame extraction error:", err);
      }

      let quotaDepleted = false;
      for (let i = 0; i < frames.length; i++) {
        if (quotaDepleted) break;
        const frame = frames[i];
        debugImages.push(frame);
        // Convert base64 data URL back to raw bytes and send as multipart —
        // the same path used for cover images, which is known to work.
        const base64Data = frame.replace(/^data:image\/[^;]+;base64,/, "");
        const frameBuffer = Buffer.from(base64Data, "base64");
        const frameSizeKB = Math.round(frameBuffer.length / 1024);
        try {
          const result = await searchByBuffer(frameBuffer.buffer as ArrayBuffer, "image/jpeg");
          console.log(`[identify] Frame ${i + 1} (${frameSizeKB} KB) results:`, result.result?.length ?? 0);
          if (result.result) allTraceMoeResults.push(...result.result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(": 402")) {
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
      if (frames.length === 0) {
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
    if (titleHashtags.size > 0 || coverOnly) {
      const lowConfMatches = getLowConfidenceMatches(
        allTraceMoeResults,
        effectiveSingle,
        effectiveConsensus,
        coverOnly ? 0.40 : 0.45
      );
      for (const group of lowConfMatches.slice(0, 5)) {
        if (enriched.length >= 5) break;
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
    if (enriched.length === 0 && titleHashtags.size > 0) {
      console.log("[identify] No visual matches — falling back to pure hashtag MAL search");
      for (const tag of titleHashtags) {
        if (enriched.length >= 3) break;
        if (GENERIC_TAGS.has(tag) || tag.length < 4) continue;
        try {
          const jikanAnime = await searchAnimeByTitle(tag);
          if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
          // Accept if words overlap OR if the hashtag matches the title with spaces removed
          // (e.g. "killblue" → "Kill Blue": "killblue" === "killblue" when normalised)
          const isHashtagTitle = titleMatchesHashtag(
            new Set([tag]),
            jikanAnime.title,
            jikanAnime.title_english,
            ...(jikanAnime.title_synonyms ?? [])
          );
          if (!titleOverlap(tag, jikanAnime) && !isHashtagTitle) continue;
          seenMalIds.add(jikanAnime.mal_id);
          const synthetic: TraceMoeResult = {
            anilist: 0, filename: tag, episode: null,
            from: 0, to: 0, similarity: 0.70, video: "", image: "",
          };
          enriched.push({
            animeResult: mapJikanToAnimeResult(jikanAnime, synthetic),
            hashtagMatch: true,
          });
        } catch {
          // skip
        }
      }
    }

    // Step 5d: Claude AI vision identification — last resort only.
    // Reaches here only when title/comment text search AND trace.moe both failed.
    const shouldRunAI = enriched.length === 0;

    if (shouldRunAI && debugImages.length > 0) {
      console.log(`[identify] Running AI identification (enriched so far: ${enriched.length})`);
      try {
        const aiMatch = await identifyAnimeFromImages(debugImages);
        if (aiMatch && aiMatch.title) {
          const searchTitles = [aiMatch.title, ...aiMatch.alternativeTitles].filter(Boolean);
          let jikanAnime: JikanAnime | null = null;
          for (const t of searchTitles) {
            jikanAnime = await searchAnimeByTitle(t);
            if (jikanAnime && !seenMalIds.has(jikanAnime.mal_id)) break;
          }
          if (jikanAnime && !seenMalIds.has(jikanAnime.mal_id)) {
            seenMalIds.add(jikanAnime.mal_id);
            const confidenceScore =
              aiMatch.confidence === "high" ? 0.92
              : aiMatch.confidence === "medium" ? 0.78
              : 0.62;
            const synthetic: TraceMoeResult = {
              anilist: 0,
              filename: aiMatch.title,
              episode: null,
              from: 0, to: 0,
              similarity: confidenceScore,
              video: "", image: "",
            };
            const animeResult = mapJikanToAnimeResult(jikanAnime, synthetic);
            animeResult.similarity = confidenceScore;
            const hashtagMatch = titleMatchesHashtag(
              titleHashtags,
              jikanAnime.title,
              jikanAnime.title_english,
            );
            console.log(`[identify] AI identified: ${jikanAnime.title} (${aiMatch.confidence}, score: ${confidenceScore})`);
            // Treat "high" or "medium" AI confidence as a corroborating signal
            // so the result sorts to the top (same bucket as hashtagMatch: true).
            enriched.push({ animeResult, hashtagMatch: aiMatch.confidence !== "low" || hashtagMatch });
          }
        }
      } catch (err) {
        console.warn("[identify] AI identification error:", err);
      }
    }

    // Step 5e (non-slideshow): always merge strong comment candidates + hashtag title candidates.
    // These are human-provided signals that override or supplement the visual result:
    //   • Explicit "name: [title]" comments and direct replies to name-question comments
    //   • Non-generic hashtags that ARE the anime title (e.g. "#killblue" → "Kill Blue")
    // Run regardless of whether visual search already found something.
    if (!isSlideshow) {
      // 5e-i: Hashtag title candidates
      // Hashtags concatenate words without spaces (e.g. "#killblue" for "Kill Blue").
      // Try the raw tag first; if validation fails, try single-space splits from left to right
      // (e.g. "kill blue" → Jikan returns "Kill Blue" → titleMatchesHashtag validates).
      // Limited to tags ≤ 14 chars to keep the number of Jikan calls bounded.
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

      // 5e-ii: Strong comment candidates (explicit "name:" or replies to name questions)
      const commentCandidates = await commentsPromise;
      const strongCandidates = commentCandidates.filter((c) => c.fromNamePattern);
      if (strongCandidates.length > 0) {
        console.log("[identify] Strong comment candidates:", strongCandidates.map((c) => c.text));
      }
      for (const { text, likes } of strongCandidates) {
        try {
          const jikanAnime = await searchAnimeByTitle(text);
          if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
          if (jikanAnime.rating === "Rx - Hentai") continue;
          if (!titleOverlap(text, jikanAnime)) continue;
          seenMalIds.add(jikanAnime.mal_id);
          const similarity = likes >= 50 ? 0.91 : likes >= 10 ? 0.87 : 0.83;
          console.log(`[identify] Comment answer: "${text}" (${likes} likes) → "${jikanAnime.title}"`);
          const synthetic: TraceMoeResult = {
            anilist: 0, filename: text, episode: null,
            from: 0, to: 0, similarity, video: "", image: "",
          };
          enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: true });
        } catch { /* skip */ }
      }

      // Step 5f: Weak heuristic text candidates — absolute last resort.
      if (enriched.length === 0) {
        console.log("[identify] All methods failed — trying heuristic text candidates");
        const weakFallbacks = [
          ...titleCandidates.map((t) => ({ text: t, likes: 0, fromNamePattern: false as const })),
          ...commentCandidates.filter((c) => !c.fromNamePattern),
        ];
        for (const { text, likes } of weakFallbacks) {
          try {
            const jikanAnime = await searchAnimeByTitle(text);
            if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
            if (jikanAnime.rating === "Rx - Hentai") continue;
            if (!titleOverlap(text, jikanAnime)) continue;
            seenMalIds.add(jikanAnime.mal_id);
            const similarity = likes >= 50 ? 0.82 : 0.75;
            console.log(`[identify] Weak text fallback: "${text}" → "${jikanAnime.title}"`);
            const synthetic: TraceMoeResult = {
              anilist: 0, filename: text, episode: null,
              from: 0, to: 0, similarity, video: "", image: "",
            };
            enriched.push({ animeResult: mapJikanToAnimeResult(jikanAnime, synthetic), hashtagMatch: false });
          } catch { /* skip */ }
        }
      }
    }

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
