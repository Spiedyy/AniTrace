import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import crypto from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegBin: string = require("ffmpeg-static");
const execAsync = promisify(exec);

async function downloadVideo(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Scene-change detection pass.
 * Returns frames at every hard cut (scene score > threshold), capped at maxFrames.
 * Each cut in an anime compilation corresponds to a new show — perfect for trace.moe.
 */
async function extractSceneFrames(
  videoPath: string,
  tmpDir: string,
  maxFrames = 12,
  sceneThreshold = 0.25
): Promise<string[]> {
  const pattern = path.join(tmpDir, "scene%04d.jpg");
  try {
    await execAsync(
      `"${ffmpegBin}" -i "${videoPath}" ` +
        `-vf "select=gt(scene\\,${sceneThreshold}),scale=640:640:force_original_aspect_ratio=decrease" ` +
        `-vsync vfr -frames:v ${maxFrames} -q:v 5 "${pattern}" -y`
    );
  } catch {
    return [];
  }

  const frames: string[] = [];
  for (let i = 1; i <= maxFrames; i++) {
    const p = path.join(tmpDir, `scene${String(i).padStart(4, "0")}.jpg`);
    try {
      frames.push(
        `data:image/jpeg;base64,${(await readFile(p)).toString("base64")}`
      );
    } catch {
      break; // no more frames
    }
  }
  return frames;
}

/**
 * Evenly-spaced fallback: 5% → 95% of the video, frameCount steps.
 * Used when scene detection finds fewer than minSceneFrames scenes.
 */
async function extractEvenFrames(
  videoPath: string,
  tmpDir: string,
  duration: number,
  frameCount = 8
): Promise<string[]> {
  const safeDuration = Math.max(duration, 1);
  const start = safeDuration * 0.05;
  const end = safeDuration * 0.95;
  const step = frameCount > 1 ? (end - start) / (frameCount - 1) : 0;
  const frames: string[] = [];

  for (let i = 0; i < frameCount; i++) {
    const timestamp = (start + step * i).toFixed(2);
    const framePath = path.join(tmpDir, `even${i}.jpg`);
    try {
      await execAsync(
        `"${ffmpegBin}" -ss ${timestamp} -i "${videoPath}" ` +
          `-vf "scale=640:640:force_original_aspect_ratio=decrease" ` +
          `-vframes 1 -q:v 5 "${framePath}" -y`
      );
      frames.push(
        `data:image/jpeg;base64,${(await readFile(framePath)).toString("base64")}`
      );
    } catch {
      // timestamp past EOF — skip
    }
  }
  return frames;
}

/**
 * Main entry point.
 * Tries scene-change detection first (best for compilations with hard cuts).
 * Falls back to evenly-spaced frames if fewer than 3 scene changes are found.
 */
export async function extractFrames(
  videoUrl: string,
  duration: number
): Promise<string[]> {
  const id = crypto.randomBytes(8).toString("hex");
  const tmpDir = path.join(tmpdir(), `anitrace-${id}`);
  const videoPath = path.join(tmpDir, "input.mp4");

  try {
    await mkdir(tmpDir, { recursive: true });

    if (!(await downloadVideo(videoUrl, videoPath))) return [];

    const sceneFrames = await extractSceneFrames(videoPath, tmpDir);
    console.log("[frame-extractor] Scene frames:", sceneFrames.length);

    if (sceneFrames.length >= 3) return sceneFrames;

    // Not enough scene cuts detected — use even spacing
    const evenFrames = await extractEvenFrames(videoPath, tmpDir, duration);
    console.log("[frame-extractor] Even frames:", evenFrames.length);
    return evenFrames;
  } catch (err) {
    console.warn("[frame-extractor] Failed:", err);
    return [];
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
