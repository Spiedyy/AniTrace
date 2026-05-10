import { spawn } from "child_process";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegBin: string = require("ffmpeg-static");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Crop+scale filter applied to every extracted frame.
 *
 * Removes the top 15 % and bottom 15 % of each frame before sending to
 * trace.moe.  Iceberg compilation videos consistently place text overlays
 * (anime title, rank number, subtitles) in these regions.  The perceptual
 * hash of those overlaid pixels lowers trace.moe similarity by 15–25 points.
 * Cropping the centre 70 % isolates the actual anime scene content.
 *
 * trunc(X/2)*2 rounds down to an even number — required by most video codecs.
 */
const CROP_FILTER =
  "crop=iw:trunc(ih*0.70/2)*2:0:trunc(ih*0.15/2)*2," +
  "scale=640:640:force_original_aspect_ratio=decrease";

/**
 * Thin wrapper around ffmpeg spawn.  Returns stderr output regardless of
 * exit code so callers can log failure reasons.
 *
 * Using spawn (not exec) means args are passed verbatim — no shell
 * interpolation, no cmd.exe quote-nesting bugs on Windows.
 */
async function spawnFfmpeg(
  args: string[],
  timeoutMs = 60_000
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin, args);
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve({ ok, stderr: stderrChunks.join("") });
      }
    };

    child.on("close", (code) => finish(code === 0));
    child.on("error", (err) => {
      console.warn("[frame-extractor] spawn error:", err.message);
      finish(false);
    });
    setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
  });
}

/** Download via Node fetch. Rejects files smaller than 100 KB (error HTML pages, etc.). */
async function downloadVideo(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" },
    });
    if (!res.ok) {
      console.warn(`[frame-extractor] Fetch ${res.status} for video URL`);
      return false;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    console.log(
      `[frame-extractor] Downloaded ${bytes.length.toLocaleString()} bytes — ${contentType || "no content-type"}`
    );
    if (bytes.length < 100_000) {
      console.warn("[frame-extractor] File too small — likely an error page, not a video");
      return false;
    }
    await writeFile(dest, bytes);
    return true;
  } catch (err) {
    console.warn("[frame-extractor] Fetch download error:", err);
    return false;
  }
}

/** Download via ffmpeg's built-in HTTP client (no shell — URL special chars are safe). */
async function downloadWithFfmpeg(url: string, dest: string): Promise<boolean> {
  const { ok, stderr } = await spawnFfmpeg(
    [
      "-user_agent", UA,
      "-headers", "Referer: https://www.tiktok.com/\r\n",
      "-i", url,
      "-c", "copy",
      "-y", dest,
    ],
    90_000
  );
  if (!ok) {
    const tail = stderr.split("\n").filter(Boolean).slice(-4).join(" | ");
    console.warn(`[frame-extractor] ffmpeg download failed — ${tail}`);
  } else {
    console.log("[frame-extractor] ffmpeg download succeeded");
  }
  return ok;
}

/**
 * Two-pass scene-change extraction (local file only).
 *
 * Pass 1 — detect cut timestamps via showinfo filter stderr output.
 * Pass 2 — seek to ts + STABLE_OFFSET_S per cut.
 *
 * STABLE_OFFSET_S = 1.5 s skips iceberg title cards (usually 1–3 s long)
 * that would otherwise produce text-heavy, low-similarity frames.
 */
async function extractSceneFrames(
  videoPath: string,
  tmpDir: string,
  maxFrames = 12,
  sceneThreshold = 0.15
): Promise<string[]> {
  // ── Pass 1: collect scene-cut timestamps ────────────────────────────────────
  // No shell involved — filter uses plain comma, no escaping needed.
  const { stderr: passOneStderr } = await spawnFfmpeg(
    [
      "-i", videoPath,
      "-vf", `select=gt(scene,${sceneThreshold}),showinfo`,
      "-fps_mode", "vfr",
      "-f", "null", "-",
    ],
    120_000
  );

  const timestamps: number[] = [];
  for (const m of passOneStderr.matchAll(/pts_time:([\d.]+)/g)) {
    timestamps.push(parseFloat(m[1]));
  }
  console.log(`[frame-extractor] Scene detection found ${timestamps.length} cut(s)`);
  if (timestamps.length === 0) return [];

  // ── Pass 2: extract stable frame 1.5 s after each cut ───────────────────────
  const STABLE_OFFSET_S = 1.5;
  const frames: string[] = [];

  for (const ts of timestamps.slice(0, maxFrames)) {
    const idx = String(frames.length).padStart(4, "0");
    const framePath = path.join(tmpDir, `scene${idx}.jpg`);
    let captured = false;

    for (const offset of [STABLE_OFFSET_S, 0.7, 0.2, 0]) {
      const seekTs = Math.max(0, ts + offset).toFixed(3);
      const { ok } = await spawnFfmpeg([
        "-ss", seekTs,
        "-i", videoPath,
        "-vf", CROP_FILTER,
        "-vframes", "1",
        "-q:v", "5",
        framePath,
        "-y",
      ]);
      if (ok) {
        try {
          frames.push(
            `data:image/jpeg;base64,${(await readFile(framePath)).toString("base64")}`
          );
          captured = true;
          break;
        } catch {
          // file not written despite exit 0 — try shorter offset
        }
      }
    }
    if (!captured) break;
  }

  return frames;
}

/**
 * Evenly-spaced frames from a local video file or a remote HTTP URL.
 *
 * When `source` is an HTTP URL ffmpeg uses Range requests to seek without
 * downloading the full file — this is Strategy 2 when the full download fails.
 *
 * Uses spawn (not exec) so filter strings and URL special chars pass verbatim
 * with no shell interpolation.
 */
async function extractEvenFrames(
  source: string,
  duration: number,
  tmpDir: string,
  frameCount = 8,
  prefix = "even"
): Promise<string[]> {
  const isUrl = source.startsWith("http://") || source.startsWith("https://");
  const safeDuration = Math.max(duration, 1);
  const start = safeDuration * 0.05;
  const end = safeDuration * 0.95;
  const step = frameCount > 1 ? (end - start) / (frameCount - 1) : 0;
  const frames: string[] = [];

  for (let i = 0; i < frameCount; i++) {
    const timestamp = (start + step * i).toFixed(2);
    const framePath = path.join(tmpDir, `${prefix}${i}.jpg`);

    const args = [
      // HTTP headers only needed for remote URLs
      ...(isUrl ? ["-user_agent", UA, "-headers", "Referer: https://www.tiktok.com/\r\n"] : []),
      "-ss", timestamp,
      "-i", source,
      "-vf", CROP_FILTER,
      "-vframes", "1",
      "-q:v", "5",
      framePath,
      "-y",
    ];

    const { ok, stderr } = await spawnFfmpeg(args, 45_000);
    if (ok) {
      try {
        frames.push(
          `data:image/jpeg;base64,${(await readFile(framePath)).toString("base64")}`
        );
      } catch {
        // file not written despite exit 0 — skip
      }
    } else if (i === 0) {
      // Log first failure so we know what's going wrong
      const tail = stderr.split("\n").filter(Boolean).slice(-3).join(" | ");
      console.warn(`[frame-extractor] Even frame 0 @ ${timestamp}s failed — ${tail}`);
    }
  }

  return frames;
}

/**
 * Main entry point.
 *
 * Strategy (in order):
 * 1. Try downloading the full video (proxy URL first, then CDN fallbacks).
 *    On success: extract scene-change frames + evenly-spaced frames (up to 14).
 * 2. If download fails: extract evenly-spaced frames directly from each URL
 *    using ffmpeg's built-in HTTP client (Range-request seeking, no full download).
 *    This bypasses IP-restricted TikTok CDN tokens by trying the TikWM proxy URL.
 *
 * @param altVideoUrls  Fallback URLs tried in order if the primary URL fails.
 */
export async function extractFrames(
  videoUrl: string,
  duration: number,
  altVideoUrls: string[] = []
): Promise<string[]> {
  const id = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(tmpdir(), `anitrace-${id}`);
  const videoPath = path.join(tmpDir, "input.mp4");

  try {
    await mkdir(tmpDir, { recursive: true });

    const urlsToTry = [videoUrl, ...altVideoUrls].filter(Boolean);

    // ── Strategy 1: full download → scene + even frames ─────────────────────
    let downloaded = false;
    for (const url of urlsToTry) {
      if (await downloadVideo(url, videoPath)) { downloaded = true; break; }
      console.log("[frame-extractor] Fetch failed — retrying with ffmpeg download");
      if (await downloadWithFfmpeg(url, videoPath)) { downloaded = true; break; }
    }

    if (downloaded) {
      const sceneFrames = await extractSceneFrames(videoPath, tmpDir);
      console.log("[frame-extractor] Scene frames:", sceneFrames.length);

      const evenTarget = Math.max(4, 10 - sceneFrames.length);
      const evenFrames = await extractEvenFrames(videoPath, duration, tmpDir, evenTarget, "even");
      console.log("[frame-extractor] Even frames:", evenFrames.length);

      const combined = [...sceneFrames, ...evenFrames].slice(0, 14);
      console.log("[frame-extractor] Total frames (downloaded):", combined.length);
      return combined;
    }

    // ── Strategy 2: direct URL → evenly-spaced frames via ffmpeg HTTP ────────
    console.log("[frame-extractor] Download failed for all URLs — trying direct URL extraction");
    for (const url of urlsToTry) {
      console.log(`[frame-extractor] Direct URL extraction: ${url.slice(0, 80)}...`);
      const frames = await extractEvenFrames(url, duration, tmpDir, 8, "urlframe");
      if (frames.length > 0) {
        console.log(`[frame-extractor] Direct URL extraction succeeded: ${frames.length} frames`);
        return frames;
      }
    }

    console.warn("[frame-extractor] All strategies failed — returning empty");
    return [];
  } catch (err) {
    console.warn("[frame-extractor] Failed:", err);
    return [];
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
