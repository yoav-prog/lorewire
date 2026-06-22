// Phase 2 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
//
// Pure builder for the ffmpeg argv that concatenates intro + body + outro
// into a single MP4. Mirrors `pipeline/segments.py:_ffmpeg_splice_cmd` so a
// render produced by the Cloud Run path is byte-equivalent (modulo encode
// non-determinism) to one produced by the local pipeline.
//
// Pure on purpose: no side effects, no spawn, no filesystem access. The
// caller (video/server/render.ts) owns spawning the process + capturing
// stderr + handling the exit code. This lets the argv shape be unit-tested
// without ffmpeg installed.

/** Frames per second the body MP4 is rendered at. Splice inputs must match
 *  this rate (segments are normalized to it at upload time). */
export const TARGET_FPS = 30;
/** Sample rate every segment is normalized to. */
export const TARGET_AUDIO_RATE = 48000;
/** Channel count every segment is normalized to. */
export const TARGET_AUDIO_CHANNELS = 2;

/** libx264 preset shared with the Python normalizer / splicer so renders
 *  stay consistent across the two code paths. `fast` is fast enough to keep
 *  splice under ~10 s for a 2-minute output and quality is visually
 *  indistinguishable from `medium`. */
export const H264_PRESET = "fast";
/** Constant Rate Factor. 23 is the high-quality web standard — ~30-40% smaller
 *  than the old 20 / Remotion's default 18, with quality still excellent for the
 *  flat doodle art. See _plans/2026-06-22-media-compression.md. */
export const H264_CRF = "23";
/** AAC bitrate. 192 k stereo matches the body's audio encode. */
export const AAC_BITRATE = "192k";

/**
 * Build the ffmpeg argv that concatenates 2+ normalized MP4 inputs into one
 * output with one re-encode pass through the `concat` filter. All inputs
 * must already be at the target resolution / fps / codec (segments are
 * normalized at upload time; the body is rendered at the same contract).
 *
 * Why `concat` filter + re-encode instead of the demuxer + stream-copy:
 * stream-copy concat requires identical SPS/PPS headers across inputs, and
 * even when both files are 1080x1920 @ 30 fps the encoder settings differ
 * (intra refresh, GOP length, …). The filter-based concat re-encodes once,
 * which is bulletproof and costs ~5–10 s per output minute.
 *
 * Throws `RangeError` if called with fewer than 2 inputs — the splice
 * step makes no sense for a single file and the caller should skip it
 * instead.
 */
export function buildConcatArgv(
  inputs: string[],
  output: string,
  options: {
    hasAudio?: boolean;
    /** Index of the body input in `inputs`. When supplied together with a
     *  positive `bodyTailPadSec`, the body's tail gets a held-frame +
     *  silent audio pad before the concat so the narrator's last word
     *  doesn't get stepped on by whatever comes after (typically the
     *  outro). Pure mirror of pipeline/segments.py:_ffmpeg_splice_cmd. */
    bodyIndex?: number;
    /** Seconds of held-frame + silent-audio pad to insert on the body's
     *  tail. 0 (the default) skips the pad — same argv shape as before
     *  this option landed. */
    bodyTailPadSec?: number;
  } = {},
): string[] {
  const hasAudio = options.hasAudio ?? true;
  if (inputs.length < 2) {
    throw new RangeError(
      `splice needs at least 2 inputs, got ${inputs.length}`,
    );
  }
  const bodyIndex = options.bodyIndex;
  const bodyTailPadSec = options.bodyTailPadSec ?? 0;
  // Pad only when (a) the caller actually wants one, (b) the body's index
  // is valid, and (c) something follows the body — padding the tail of a
  // body that's already last in the chain just lengthens the output for
  // no reason.
  const padActive =
    bodyIndex !== undefined &&
    bodyTailPadSec > 0 &&
    bodyIndex >= 0 &&
    bodyIndex < inputs.length - 1;

  const argv: string[] = ["ffmpeg", "-y"];
  for (const p of inputs) {
    argv.push("-i", p);
  }

  // Filter graph mirrors the Python builder verbatim. Without pad:
  //   [0:v:0][0:a:0][1:v:0][1:a:0]...concat=n=N:v=1:a=1[v][a]
  // With pad applied to body at index B:
  //   [B:v:0]tpad=stop_mode=clone:stop_duration=S[bv];
  //   [B:a:0]apad=pad_dur=S[ba];
  //   [0:v:0][0:a:0]...[bv][ba]...concat=...
  // When `hasAudio` is false the audio streams + the `[a]` label drop.
  let streams = "";
  if (padActive) {
    // `Number.toString` would emit "1.5", "0.5", etc. — same shape the
    // Python side produces via format("g") and what ffmpeg's parser
    // expects. No locale risk because Number stringification is
    // locale-independent.
    const padS = String(bodyTailPadSec);
    streams += `[${bodyIndex}:v:0]tpad=stop_mode=clone:stop_duration=${padS}[bv];`;
    if (hasAudio) {
      streams += `[${bodyIndex}:a:0]apad=pad_dur=${padS}[ba];`;
    }
  }
  for (let i = 0; i < inputs.length; i++) {
    if (padActive && i === bodyIndex) {
      streams += `[bv]`;
      if (hasAudio) streams += `[ba]`;
    } else {
      streams += `[${i}:v:0]`;
      if (hasAudio) streams += `[${i}:a:0]`;
    }
  }
  const audioFlag = hasAudio ? 1 : 0;
  streams += `concat=n=${inputs.length}:v=1:a=${audioFlag}[v]`;
  if (hasAudio) streams += "[a]";

  argv.push("-filter_complex", streams);
  argv.push("-map", "[v]");
  if (hasAudio) argv.push("-map", "[a]");

  argv.push(
    "-r", String(TARGET_FPS),
    "-c:v", "libx264",
    "-preset", H264_PRESET,
    "-crf", H264_CRF,
    "-pix_fmt", "yuv420p",
  );
  if (hasAudio) {
    argv.push(
      "-c:a", "aac",
      "-b:a", AAC_BITRATE,
      "-ar", String(TARGET_AUDIO_RATE),
      "-ac", String(TARGET_AUDIO_CHANNELS),
    );
  }
  argv.push("-movflags", "+faststart", output);
  return argv;
}
