// Local-only segment normalize + publish for `next dev` without GCS creds.
//
// Mirrors the contract of pipeline/segments.py:normalize so the output of
// either path is interchangeable: 1080x1920 @ 30fps H.264 + 48 kHz AAC,
// faststart-flagged, ready for ffmpeg concat at splice time.
//
// Everything in this file shells out to the host's system ffmpeg/ffprobe.
// We deliberately do NOT depend on ffmpeg-static — it was removed from the
// web bundle when the prod path moved to direct-to-GCS, and bringing it
// back just for an offline dev convenience would re-bloat every prod
// function bundle for zero prod benefit. Devs already have ffmpeg on PATH
// (the same one pipeline/segments_worker.py uses).
//
// Guarded by the upload-local route's `process.env.VERCEL` check — this
// module is server-only AND should never execute in a Vercel function.

import "server-only";
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aspectDims,
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";

// Pinned to match pipeline/segments.py exactly — if you tune one side you
// must tune the other or the concat filter at splice time will resample.
//
// Phase 3 of _plans/2026-06-12-video-aspect-ratio.md: the target pixel
// dimensions branch on a per-segment aspect (the same string the renderer
// uses). 9:16 keeps the legacy 1080x1920 so any segment uploaded before
// the column existed normalises to the exact same shape as before.
const TARGET_FPS = 30;
const TARGET_AUDIO_RATE = 48000;
const TARGET_AUDIO_CHANNELS = 2;
const H264_PRESET = "fast";
const H264_CRF = "20";
const AAC_BITRATE = "192k";

function buildVideoFilter(aspect: VideoAspect): string {
  const { width, height } = aspectDims(aspect);
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},` +
    `setsar=1,fps=${TARGET_FPS}`
  );
}

const AUDIO_FILTER =
  `aformat=sample_rates=${TARGET_AUDIO_RATE}:channel_layouts=stereo`;

function resolveSegmentAspect(aspect: VideoAspect | string | undefined): VideoAspect {
  return isVideoAspect(aspect) ? aspect : LEGACY_DEFAULT_ASPECT;
}

// Public asset roots. We write under `lorewire-app/public/segments/<id>.*`
// so Next dev's static-file middleware serves them at /segments/<id>.* —
// the same shape pipeline/media.py writes when GCS is unset (matching
// convention beats inventing a new one).
const PUBLIC_RELATIVE_DIR = path.join("public", "segments");

/**
 * Build the argv for the normalize ffmpeg invocation. Pure — kept separate
 * so tests can assert the shape without running ffmpeg. `aspect` defaults
 * to the legacy 9:16 portrait so any caller that hasn't been updated
 * produces argv byte-identical to the pre-Phase-3 normalize.
 */
export function buildNormalizeArgs(
  source: string,
  output: string,
  aspect: VideoAspect = LEGACY_DEFAULT_ASPECT,
): string[] {
  return [
    "-y",
    "-i", source,
    "-vf", buildVideoFilter(aspect),
    "-af", AUDIO_FILTER,
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

/**
 * Build the argv for ffprobe duration. Pure.
 */
export function buildProbeDurationArgs(target: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    target,
  ];
}

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(bin: string, args: string[]): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface NormalizeAndPublishLocalResult {
  sourceUrl: string;
  normalizedUrl: string;
  durationMs: number;
}

/**
 * Normalize an upload's bytes with system ffmpeg and publish source +
 * normalized copies under `lorewire-app/public/segments/`. Returns the
 * public-URL pair the DB row stores (`/segments/<id>.source<ext>` and
 * `/segments/<id>.norm.mp4`) plus the probed duration.
 *
 * The tmp working dir is cleaned up on success and on failure so a flaky
 * upload doesn't leave gigabytes around. Throws on any subprocess failure;
 * the route handler turns the message into a 5xx for the form.
 */
export async function normalizeAndPublishLocal(opts: {
  id: string;
  ext: ".mp4" | ".mov";
  bytes: Uint8Array;
  /** Phase 3 of _plans/2026-06-12-video-aspect-ratio.md: the target
   *  aspect for the normalised clip. Defaults to the legacy 9:16
   *  portrait so any caller that hasn't been updated keeps the existing
   *  contract. Once the upload form exposes an aspect picker (Phase 4),
   *  the route handler will pass the chosen value through. */
  aspect?: VideoAspect | string;
}): Promise<NormalizeAndPublishLocalResult> {
  const aspect = resolveSegmentAspect(opts.aspect);
  const tag = `[segments local normalize id=${opts.id} aspect=${aspect}]`;
  const workDir = path.join(tmpdir(), `lw-segment-local-${opts.id}`);
  await mkdir(workDir, { recursive: true });
  const tmpSource = path.join(workDir, `source${opts.ext}`);
  const tmpNormalized = path.join(workDir, `normalized.mp4`);
  try {
    await writeFile(tmpSource, opts.bytes);
    console.info(`${tag} wrote ${opts.bytes.byteLength} bytes`);

    const startNormalize = Date.now();
    const normResult = await runProcess(
      "ffmpeg",
      buildNormalizeArgs(tmpSource, tmpNormalized, aspect),
    );
    const elapsed = ((Date.now() - startNormalize) / 1000).toFixed(1);
    if (normResult.code !== 0) {
      const tail = normResult.stderr.split(/\r?\n/).slice(-10).join("\n");
      console.error(`${tag} ffmpeg FAILED rc=${normResult.code} in ${elapsed}s\n${tail}`);
      throw new Error(
        `ffmpeg normalize failed (rc=${normResult.code}). Is ffmpeg on PATH?`,
      );
    }
    const normalizedStat = await stat(tmpNormalized);
    let durationMs = 0;
    try {
      const probe = await runProcess(
        "ffprobe",
        buildProbeDurationArgs(tmpNormalized),
      );
      if (probe.code === 0) {
        const seconds = Number(probe.stdout.trim());
        if (Number.isFinite(seconds)) durationMs = Math.round(seconds * 1000);
      }
    } catch {
      // ffprobe missing or broken — duration is metadata-only for the
      // admin list, not load-bearing for splice.
    }
    console.info(
      `${tag} done in ${elapsed}s output=${(normalizedStat.size / (1024 * 1024)).toFixed(1)} MB duration=${durationMs}ms`,
    );

    // Copy both files into public/segments/. We resolve under process.cwd()
    // because `next dev` runs from the lorewire-app directory and the public
    // dir sits next to it. Using cwd keeps this insensitive to where the
    // file is imported from.
    const publicDir = path.join(process.cwd(), PUBLIC_RELATIVE_DIR);
    await mkdir(publicDir, { recursive: true });
    const sourceFilename = `${opts.id}.source${opts.ext}`;
    const normalizedFilename = `${opts.id}.norm.mp4`;
    const sourcePublicPath = path.join(publicDir, sourceFilename);
    const normalizedPublicPath = path.join(publicDir, normalizedFilename);
    await writeFile(sourcePublicPath, opts.bytes);
    // Re-read normalized and write to public — the tmp file is going to be
    // rm'd in the finally block.
    const { readFile: readBytes } = await import("node:fs/promises");
    await writeFile(normalizedPublicPath, await readBytes(tmpNormalized));
    console.info(
      `${tag} published source=/segments/${sourceFilename} normalized=/segments/${normalizedFilename}`,
    );

    return {
      sourceUrl: `/segments/${sourceFilename}`,
      normalizedUrl: `/segments/${normalizedFilename}`,
      durationMs,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {
      // tmp dir is in the OS tmp tree; an OS cleanup pass will get it
      // eventually if our rm raced something. Not worth surfacing.
    });
  }
}
