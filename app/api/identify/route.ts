import { NextRequest } from "next/server";
import { fetchTikTokVideo } from "@/lib/tikwm";
import { searchByBase64, searchByBuffer } from "@/lib/tracemoe"; // searchByBase64 used for ffmpeg frames
import { getMediaByAnilistId } from "@/lib/anilist";
import { getAnimeById, searchAnimeByTitle, JikanAnime } from "@/lib/jikan";
import { extractFrames } from "@/lib/frame-extractor";
import type { AnimeResult, TraceMoeResult, IdentifyResponse } from "@/types";

const TIKTOK_URL_REGEX = /^https?:\/\/(www\.|vm\.|m\.)?tiktok\.com\/.+/;
// A single frame needs strong confidence to avoid false positives.
// When 2+ frames agree on the same anime the bar is lower — consensus is reliable.
const MIN_SIMILARITY_SINGLE = 0.84;
const MIN_SIMILARITY_CONSENSUS = 0.70;

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
  filename: string;
}

function getBestMatches(allResults: TraceMoeResult[]): TraceMoeGroup[] {
  // First pass: group all results by anime (no threshold yet)
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

    // Accept if: multiple frames agree at ≥70%, OR a single frame is ≥84%
    const hasConsensus = results.length >= 2 && best.similarity >= MIN_SIMILARITY_CONSENSUS;
    const isConfident = best.similarity >= MIN_SIMILARITY_SINGLE;
    if (!hasConsensus && !isConfident) continue;

    groups.push({ anilistId, results, avgSimilarity, filename: results[0].filename });
  }

  return groups.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json();
    const { url: tiktokUrl } = body;

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

    const isSlideshow = !!videoInfo.images?.length;
    console.log(
      "[identify] TikWM ok — duration:", videoInfo.duration,
      "originCover:", !!videoInfo.originCoverUrl,
      "slideshow:", isSlideshow, isSlideshow ? `(${videoInfo.images!.length} slides)` : ""
    );

    // Step 2: Build the list of images to search
    const allTraceMoeResults: TraceMoeResult[] = [];
    const debugImages: string[] = [];

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
      // Photo slideshow — every slide is a candidate frame
      for (let i = 0; i < videoInfo.images!.length; i++) {
        await searchImageUrl(videoInfo.images![i], `slide ${i + 1}`);
      }
    } else {
      // Regular video — extract frames with scene detection
      let frames: string[] = [];
      try {
        frames = await extractFrames(videoInfo.videoUrl, videoInfo.duration);
        console.log("[identify] Extracted frames:", frames.length);
      } catch (err) {
        console.warn("[identify] Frame extraction error:", err);
      }

      let quotaDepleted = false;
      for (let i = 0; i < frames.length; i++) {
        if (quotaDepleted) break;
        const frame = frames[i];
        debugImages.push(frame);
        try {
          const result = await searchByBase64(frame);
          console.log(`[identify] Frame ${i + 1} results:`, result.result?.length ?? 0);
          if (result.result) allTraceMoeResults.push(...result.result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(": 402")) {
            console.warn(`[identify] Frame ${i + 1}: trace.moe quota depleted — stopping`);
            quotaDepleted = true;
          } else {
            console.warn(`[identify] Frame ${i + 1} search failed:`, err);
          }
        }
      }

      // If frame extraction yielded nothing, fall back to origin/portrait cover
      if (frames.length === 0) {
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

    // Step 4: Group and rank matches
    const bestMatches = getBestMatches(allTraceMoeResults);

    if (bestMatches.length === 0) {
      return Response.json({
        success: true,
        results: [],
        error: "Couldn't confidently identify an anime. The video may contain heavily edited content, text overlays, or non-anime footage.",
        ...devExtra,
      } satisfies IdentifyResponse);
    }

    // Step 5: Fetch anime details from Jikan (top 3 matches)
    const results: AnimeResult[] = [];
    const seenMalIds = new Set<number>();

    for (const group of bestMatches.slice(0, 3)) {
      try {
        const anilistMedia = await getMediaByAnilistId(group.anilistId);
        let jikanAnime: JikanAnime | null = null;

        if (anilistMedia?.idMal) {
          jikanAnime = await getAnimeById(anilistMedia.idMal);
        }

        // Fall back to title search if ID lookup failed
        if (!jikanAnime) {
          jikanAnime = await searchAnimeByTitle(group.filename);
        }

        if (!jikanAnime || seenMalIds.has(jikanAnime.mal_id)) continue;
        seenMalIds.add(jikanAnime.mal_id);

        const bestResult = group.results.reduce((best, r) =>
          r.similarity > best.similarity ? r : best
        );
        results.push(mapJikanToAnimeResult(jikanAnime, bestResult));
      } catch {
        // Skip this match
      }
    }

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
