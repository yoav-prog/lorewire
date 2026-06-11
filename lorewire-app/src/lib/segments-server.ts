// Server-side helpers for the intro/outro library. Spawns ffmpeg to normalize
// uploads (1080x1920 @ 30fps H.264 + AAC, center-crop landscape sources) and
// publishes both the source and normalized copies to GCS. The output contract
// must match pipeline/segments.py exactly so the concat step in the render
// pipeline doesn't re-encode unnecessarily.

import "server-only";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import ffmpegStatic from "ffmpeg-static";
// ffprobe-static ships no .d.ts and no @types package, so we declare the
// single field we use here. Keeping the declaration adjacent to the import
// avoids a stray .d.ts in src/ that would have to be globbed by tsconfig.
import ffprobeStatic from "ffprobe-static";
import { uploadFile, isConfigured as gcsConfigured } from "@/lib/gcs";

// Bundled static binaries so the admin upload works without the host having
// ffmpeg/ffprobe on PATH — the deciding factor for whether this feature
// runs on Vercel (no host binaries) as cleanly as it does locally. Both
// libraries return null when the platform/arch isn't supported; we fall
// back to "ffmpeg"/"ffprobe" so a dev on an exotic arch can still ship.
const FFMPEG_BIN = ffmpegStatic ?? "ffmpeg";
const FFPROBE_BIN = ffprobeStatic.path ?? "ffprobe";

// Pin the same constants pipeline/segments.py uses. If you change either side
// you must change the other — the splice step assumes the body and the
// segments share these.
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const TARGET_FPS = 30;
const TARGET_AUDIO_RATE = 48000;
const TARGET_AUDIO_CHANNELS = 2;
const H264_PRESET = "fast";
const H264_CRF = "20";
const AAC_BITRATE = "192k";

const NORMALIZE_VIDEO_FILTER =
  `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,` +
  `crop=${TARGET_WIDTH}:${TARGET_HEIGHT},` +
  `setsar=1,fps=${TARGET_FPS}`;

const NORMALIZE_AUDIO_FILTER =
  `aformat=sample_rates=${TARGET_AUDIO_RATE}:channel_layouts=stereo`;

// Upload constraints. 200 MB matches the plan; larger than that is almost
// certainly a misclick — the source files are typically 5-30 MB.
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const ACCEPTED_MIME = new Set(["video/mp4", "video/quicktime"]);
export const ACCEPTED_EXT = new Set([".mp4", ".mov"]);

// MP4/MOV both begin with a box whose 4-byte type at offset 4..8 is "ftyp".
// Magic-byte sniff before we trust the extension or MIME the browser sent.
export function hasFtypHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return (
    bytes[4] === 0x66 && // 'f'
    bytes[5] === 0x74 && // 't'
    bytes[6] === 0x79 && // 'y'
    bytes[7] === 0x70 //   'p'
  );
}

export function newSegmentId(): string {
  // 16 random hex chars — short enough to type in a URL, long enough that
  // collisions are not a real concern at our scale.
  return randomBytes(8).toString("hex");
}

export function sanitizeLabel(raw: string): string {
  // Drop ASCII control bytes (and DEL) so an accidental newline or escape
  // can't smuggle markup. Hebrew, emoji, punctuation are all fine — labels
  // render as text, not HTML.
  let cleaned = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    cleaned += raw[i];
  }
  return cleaned.trim().slice(0, 80);
}

function ffmpegNormalizeArgs(source: string, output: string): string[] {
  return [
    "-y",
    "-i", source,
    "-vf", NORMALIZE_VIDEO_FILTER,
    "-af", NORMALIZE_AUDIO_FILTER,
    "-r", String(TARGET_FPS),
    "-c:v", "libx264",
    "-preset", H264_PRESET,
    "-crf", H264_CRF,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", AAC_BITRATE,
    "-ar", String(TARGET_AUDIO_RATE),
    "-ac", String(TARGET_AUDIO_CHANNELS),
    "-movflags", "+faststart",
    output,
  ];
}

function ffprobeDurationArgs(target: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    target,
  ];
}

async function runProcess(
  bin: string,
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stderr, stdout });
    });
  });
}

export async function probeDurationMs(target: string): Promise<number> {
  try {
    const { code, stdout } = await runProcess(
      FFPROBE_BIN,
      ffprobeDurationArgs(target),
    );
    if (code !== 0) return 0;
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds)) return 0;
    return Math.round(seconds * 1000);
  } catch {
    return 0;
  }
}

export interface NormalizeAndPublishResult {
  sourceUrl: string;
  normalizedUrl: string;
  durationMs: number;
}

// End-to-end upload path: write bytes to a tmp file, run ffmpeg to produce a
// normalized copy in a sibling tmp file, then upload both to GCS under
// `segments/<id>.{ext,norm.mp4}`. Cleans up the tmp dir on success and on
// failure (so a flaky upload doesn't leave gigabytes around). Throws on any
// step that fails — the admin server action turns the message into a flash
// for the page.
export async function normalizeAndPublish(opts: {
  id: string;
  ext: ".mp4" | ".mov";
  bytes: Uint8Array;
}): Promise<NormalizeAndPublishResult> {
  if (!gcsConfigured()) {
    throw new Error(
      "GCS upload is not configured. Set GCS_BUCKET, GCS_CLIENT_EMAIL, and GCS_PRIVATE_KEY in the env.",
    );
  }
  const tag = `[segment normalize id=${opts.id}]`;
  const workDir = path.join(tmpdir(), `lw-segment-${opts.id}`);
  await mkdir(workDir, { recursive: true });
  const sourcePath = path.join(workDir, `source${opts.ext}`);
  const normalizedPath = path.join(workDir, `normalized.mp4`);
  try {
    await writeFile(sourcePath, opts.bytes);
    console.info(
      `${tag} wrote ${opts.bytes.byteLength} bytes to ${sourcePath}`,
    );
    const startNormalize = Date.now();
    const { code, stderr } = await runProcess(
      FFMPEG_BIN,
      ffmpegNormalizeArgs(sourcePath, normalizedPath),
    );
    const elapsed = ((Date.now() - startNormalize) / 1000).toFixed(1);
    if (code !== 0) {
      const tail = stderr.split(/\r?\n/).slice(-10).join("\n");
      console.error(`${tag} ffmpeg FAILED rc=${code} in ${elapsed}s\n${tail}`);
      throw new Error(
        `ffmpeg normalize failed (rc=${code}). Check that the file is a valid mp4/mov.`,
      );
    }
    const normalizedStat = await stat(normalizedPath);
    const durationMs = await probeDurationMs(normalizedPath);
    console.info(
      `${tag} done in ${elapsed}s output=${(normalizedStat.size / (1024 * 1024)).toFixed(1)} MB duration=${durationMs}ms`,
    );

    const sourceKey = `segments/${opts.id}.source${opts.ext}`;
    const normalizedKey = `segments/${opts.id}.norm.mp4`;
    const startUpload = Date.now();
    const [sourceUrl, normalizedUrl] = await Promise.all([
      uploadFile(sourcePath, sourceKey),
      uploadFile(normalizedPath, normalizedKey),
    ]);
    const uploadElapsed = ((Date.now() - startUpload) / 1000).toFixed(1);
    console.info(
      `${tag} uploaded to GCS in ${uploadElapsed}s source=${sourceKey} normalized=${normalizedKey}`,
    );
    return { sourceUrl, normalizedUrl, durationMs };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
