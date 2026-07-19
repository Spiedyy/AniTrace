import { spawn } from "child_process";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";
import { isValidSearchImage, TRACE_MOE_MAX_BYTES } from "@/lib/image-bytes";

/** Low-memory / time-boxed hosts (Vercel functions, Render free). */
const IS_CONSTRAINED = !!(process.env.VERCEL || process.env.RENDER);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegBin: string = require("ffmpeg-static");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Skip creator intro / commentary at the start of reaction-style TikToks. */
const INTRO_SKIP_RATIO = 0.22;
const INTRO_SKIP_MIN_S = 3;

/** Native-ish TikTok frame — up to 720p, typically well under trace.moe's 1 MB cap. */
const FULL_SCALE = "scale=720:1280:force_original_aspect_ratio=decrease";
/** Inset crops are already zoomed — 640 px is enough for matching. */
const CROP_SCALE = "scale=640:640:force_original_aspect_ratio=decrease";
const FALLBACK_SCALE = "scale=640:640:force_original_aspect_ratio=decrease";

/**
 * Multiple crops per timestamp — reaction videos often show anime in a small
 * inset while the creator talks full-screen. The `full` variant is the entire
 * TikTok frame; corner variants are fallbacks for PiP layouts.
 */
export const FRAME_VARIANTS = {
  full: FULL_SCALE,
  center:
    "crop=iw:trunc(ih*0.70/2)*2:0:trunc(ih*0.15/2)*2," + CROP_SCALE,
  bottomRight:
    "crop=trunc(iw*0.48/2)*2:trunc(ih*0.48/2)*2:trunc(iw*0.52/2)*2:trunc(ih*0.52/2)*2," +
    CROP_SCALE,
  topRight:
    "crop=trunc(iw*0.48/2)*2:trunc(ih*0.48/2)*2:trunc(iw*0.52/2)*2:0," + CROP_SCALE,
  bottomLeft:
    "crop=trunc(iw*0.48/2)*2:trunc(ih*0.48/2)*2:0:trunc(ih*0.52/2)*2," + CROP_SCALE,
} as const;

export type FrameVariant = keyof typeof FRAME_VARIANTS;

export interface ExtractedFrame {
  base64: string;
  variant: FrameVariant;
  /** Seconds into the video. */
  timestampSec: number;
}

function introSkipSeconds(duration: number): number {
  return Math.min(
    Math.max(INTRO_SKIP_MIN_S, duration * INTRO_SKIP_RATIO),
    Math.max(0, duration * 0.45)
  );
}

async function spawnFfmpeg(
  args: string[],
  timeoutMs = IS_CONSTRAINED ? 15_000 : 60_000
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
    setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
  });
}

async function downloadVideo(url: string, dest: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutMs = IS_CONSTRAINED ? 12_000 : 45_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://www.tiktok.com/" },
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

async function downloadWithFfmpeg(url: string, dest: string): Promise<boolean> {
  // Must stay under Vercel maxDuration — 90s previously guaranteed FUNCTION_INVOCATION_TIMEOUT.
  const { ok, stderr } = await spawnFfmpeg(
    [
      "-user_agent", UA,
      "-headers", "Referer: https://www.tiktok.com/\r\n",
      "-i", url,
      "-c", "copy",
      "-y", dest,
    ],
    IS_CONSTRAINED ? 12_000 : 90_000
  );
  if (!ok) {
    const tail = stderr.split("\n").filter(Boolean).slice(-4).join(" | ");
    console.warn(`[frame-extractor] ffmpeg download failed — ${tail}`);
  } else {
    console.log("[frame-extractor] ffmpeg download succeeded");
  }
  return ok;
}

async function captureFrame(
  source: string,
  seekSec: number,
  vf: string,
  framePath: string,
  isUrl: boolean,
  jpegQuality = 4
): Promise<boolean> {
  const args = [
    ...(isUrl ? ["-user_agent", UA, "-headers", "Referer: https://www.tiktok.com/\r\n"] : []),
    "-ss", seekSec.toFixed(3),
    "-i", source,
    "-vf", vf,
    "-vframes", "1",
    "-q:v", String(jpegQuality),
    framePath,
    "-y",
  ];
  const { ok } = await spawnFfmpeg(args, IS_CONSTRAINED ? 12_000 : 45_000);
  if (!ok) return false;
  try {
    await readFile(framePath);
    return true;
  } catch {
    return false;
  }
}

async function readValidatedFrame(
  source: string,
  seekSec: number,
  vf: string,
  framePath: string,
  isUrl: boolean,
  variant: FrameVariant
): Promise<Buffer | null> {
  const quality = variant === "full" ? 4 : 5;
  let ok = await captureFrame(source, seekSec, vf, framePath, isUrl, quality);
  if (!ok) return null;

  let raw = await readFile(framePath).catch(() => null);
  if (!raw || !isValidSearchImage(raw)) return null;

  // If 720p full frame exceeds trace.moe's 1 MB limit, retry at 640p.
  if (raw.length > TRACE_MOE_MAX_BYTES && variant === "full") {
    ok = await captureFrame(source, seekSec, FALLBACK_SCALE, framePath, isUrl, 5);
    if (!ok) return null;
    raw = await readFile(framePath).catch(() => null);
    if (!raw || !isValidSearchImage(raw)) return null;
  }

  return raw;
}

async function extractVariantsAtTimestamp(
  source: string,
  timestampSec: number,
  tmpDir: string,
  prefix: string,
  variants: FrameVariant[],
  isUrl: boolean
): Promise<ExtractedFrame[]> {
  const frames: ExtractedFrame[] = [];

  for (const variant of variants) {
    const framePath = path.join(
      tmpDir,
      `${prefix}_${variant}_${Math.round(timestampSec * 1000)}.jpg`
    );
    try {
      const raw = await readValidatedFrame(
        source,
        timestampSec,
        FRAME_VARIANTS[variant],
        framePath,
        isUrl,
        variant
      );
      if (!raw) continue;
      frames.push({
        base64: `data:image/jpeg;base64,${raw.toString("base64")}`,
        variant,
        timestampSec,
      });
    } catch {
      // skip unreadable output
    }
  }

  return frames;
}

function dedupeTimestamps(timestamps: number[], minGapSec = 1.2): number[] {
  const sorted = [...timestamps].sort((a, b) => a - b);
  const out: number[] = [];
  for (const ts of sorted) {
    if (out.length === 0 || ts - out[out.length - 1] >= minGapSec) {
      out.push(ts);
    }
  }
  return out;
}

/** Scene cuts after the intro — skips commentary at the start. */
async function collectSceneTimestamps(
  videoPath: string,
  duration: number,
  sceneThreshold = 0.12
): Promise<number[]> {
  const { stderr } = await spawnFfmpeg(
    [
      "-i", videoPath,
      "-vf", `select=gt(scene,${sceneThreshold}),showinfo`,
      "-fps_mode", "vfr",
      "-f", "null", "-",
    ],
    IS_CONSTRAINED ? 15_000 : 120_000
  );

  const introSkip = introSkipSeconds(duration);
  const timestamps: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const ts = parseFloat(m[1]);
    if (ts >= introSkip) timestamps.push(ts);
  }

  console.log(
    `[frame-extractor] Scene detection: ${timestamps.length} cut(s) after ${introSkip.toFixed(1)}s intro skip`
  );
  return dedupeTimestamps(timestamps);
}

function buildEvenTimestamps(duration: number, count = IS_CONSTRAINED ? 3 : 6): number[] {
  const introSkip = introSkipSeconds(duration);
  const start = Math.max(introSkip, duration * 0.25);
  const end = duration * 0.97;
  if (end <= start) return [Math.min(introSkip, duration * 0.5)];

  const timestamps: number[] = [];
  const step = count > 1 ? (end - start) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    timestamps.push(start + step * i);
  }
  return timestamps;
}

/** Prefer full frames first; PiP corner crops are fallbacks for reaction layouts. */
export function sortFramesForSearch(frames: ExtractedFrame[]): ExtractedFrame[] {
  const variantPriority: Record<FrameVariant, number> = {
    full: 0,
    center: 1,
    bottomRight: 2,
    topRight: 3,
    bottomLeft: 4,
  };

  return [...frames].sort((a, b) => {
    const variantDiff = variantPriority[a.variant] - variantPriority[b.variant];
    if (variantDiff !== 0) return variantDiff;
    return b.timestampSec - a.timestampSec;
  });
}

/** Flat base64 list for AI fallback — later frames and inset crops first. */
export function framesForAiIdentification(frames: ExtractedFrame[], limit = 8): string[] {
  return sortFramesForSearch(frames)
    .slice(0, limit)
    .map((f) => f.base64);
}

async function extractFromSource(
  source: string,
  duration: number,
  tmpDir: string,
  sceneTimestamps: number[],
  prefix: string,
  deadlineAt?: number
): Promise<ExtractedFrame[]> {
  const isUrl = source.startsWith("http://") || source.startsWith("https://");
  const pipVariants: FrameVariant[] = IS_CONSTRAINED
    ? ["full", "bottomRight"]
    : ["full", "bottomRight", "topRight", "center"];
  const evenVariants: FrameVariant[] = IS_CONSTRAINED
    ? ["full", "bottomRight"]
    : ["full", "bottomRight", "topRight"];

  const evenTimestamps = buildEvenTimestamps(duration);
  const sceneSample = IS_CONSTRAINED ? [] : dedupeTimestamps(sceneTimestamps).slice(-6);
  const maxTimestamps = IS_CONSTRAINED ? 4 : 10;
  const allTimestamps = dedupeTimestamps([...evenTimestamps, ...sceneSample]).slice(-maxTimestamps);

  console.log(
    `[frame-extractor] Sampling ${allTimestamps.length} timestamp(s):`,
    allTimestamps.map((t) => t.toFixed(1) + "s").join(", ")
  );

  const frames: ExtractedFrame[] = [];
  for (const ts of allTimestamps) {
    if (deadlineAt != null && Date.now() >= deadlineAt) {
      console.warn(
        `[frame-extractor] Deadline reached after ${frames.length} frame(s) — stopping extraction`
      );
      break;
    }
    const isSceneCut = sceneSample.some((s) => Math.abs(s - ts) < 0.5);
    const variants = isSceneCut ? pipVariants : evenVariants;
    const batch = await extractVariantsAtTimestamp(
      source,
      ts,
      tmpDir,
      prefix,
      variants,
      isUrl
    );
    frames.push(...batch);
  }

  return frames;
}

/**
 * Main entry point.
 *
 * Extracts multiple crops per timestamp (full frame + inset corners) and skips
 * the opening commentary segment common in reaction TikToks.
 *
 * @param deadlineAt - Optional wall-clock ms deadline; extraction stops early to leave
 *   time for trace.moe / enrichment on Vercel.
 */
export async function extractFrames(
  videoUrl: string,
  duration: number,
  altVideoUrls: string[] = [],
  deadlineAt?: number
): Promise<ExtractedFrame[]> {
  const id = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(tmpdir(), `anitrace-${id}`);
  const videoPath = path.join(tmpDir, "input.mp4");

  try {
    await mkdir(tmpDir, { recursive: true });

    const urlsToTry = [videoUrl, ...altVideoUrls].filter(Boolean);

    let downloaded = false;
    for (const url of urlsToTry) {
      if (deadlineAt != null && Date.now() >= deadlineAt) {
        console.warn("[frame-extractor] Deadline reached before download — aborting");
        return [];
      }
      if (await downloadVideo(url, videoPath)) {
        downloaded = true;
        break;
      }
      console.log("[frame-extractor] Fetch failed — retrying with ffmpeg download");
      if (await downloadWithFfmpeg(url, videoPath)) {
        downloaded = true;
        break;
      }
    }

    if (downloaded) {
      const sceneTimestamps = IS_CONSTRAINED
        ? []
        : await collectSceneTimestamps(videoPath, duration);
      const frames = await extractFromSource(
        videoPath,
        duration,
        tmpDir,
        sceneTimestamps,
        "dl",
        deadlineAt
      );
      console.log("[frame-extractor] Total frame variants (downloaded):", frames.length);
      return sortFramesForSearch(frames);
    }

    console.log("[frame-extractor] Download failed — trying direct URL extraction");
    for (const url of urlsToTry) {
      if (deadlineAt != null && Date.now() >= deadlineAt) break;
      console.log(`[frame-extractor] Direct URL extraction: ${url.slice(0, 80)}...`);
      const frames = await extractFromSource(url, duration, tmpDir, [], "url", deadlineAt);
      if (frames.length > 0) {
        console.log(`[frame-extractor] Direct URL extraction succeeded: ${frames.length} variants`);
        return sortFramesForSearch(frames);
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
