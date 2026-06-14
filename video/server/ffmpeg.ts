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
/** Constant Rate Factor — visually lossless for short-form at 1080p. */
export const H264_CRF = "20";
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
  options: { hasAudio?: boolean } = {},
): string[] {
  const hasAudio = options.hasAudio ?? true;
  if (inputs.length < 2) {
    throw new RangeError(
      `splice needs at least 2 inputs, got ${inputs.length}`,
    );
  }

  const argv: string[] = ["ffmpeg", "-y"];
  for (const p of inputs) {
    argv.push("-i", p);
  }

  // Filter graph mirrors the Python builder verbatim:
  //   [0:v:0][0:a:0][1:v:0][1:a:0]...concat=n=N:v=1:a=1[v][a]
  // When `hasAudio` is false the audio streams + the `[a]` label drop.
  let streams = "";
  for (let i = 0; i < inputs.length; i++) {
    streams += `[${i}:v:0]`;
    if (hasAudio) streams += `[${i}:a:0]`;
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
