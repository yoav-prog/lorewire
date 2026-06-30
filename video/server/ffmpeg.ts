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

// Paced hook-first seams (_plans/2026-06-29-hook-first-clean-pacing.md). When the
// hook-first reorder is active the cold-open hook fades to black and holds a
// silent beat before the brand intro, the intro holds a silent beat before the
// story resumes, and the story fades back in — so the intro lands between two
// pauses instead of a hard cut. Mirrors pipeline/segments.py. Set any to 0 to
// drop that seam (all 0 == legacy hard-cut hook-first).
/** Video fade-out / fade-in (seconds) at each hook-first seam. */
export const HOOK_FIRST_FADE_SEC = 0.45;
/** Black + silence (seconds) held after the hook, before the intro. */
export const HOOK_FIRST_HOOK_GAP_SEC = 1.1;
/** Black + silence (seconds) held after the intro, before the story resumes. */
export const HOOK_FIRST_INTRO_GAP_SEC = 0.9;
/** The hook caption can end a few frames before the spoken word does, and the
 *  next line's caption starts on that boundary. So the hook clip freezes its last
 *  clean frame at hookEndSec and the AUDIO runs this much longer, letting the
 *  last word finish over the held frame before the fade — without the next line's
 *  caption appearing. Mirrors pipeline/segments.py. */
export const HOOK_FIRST_TAIL_HOLD_SEC = 0.3;

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
    /** Seconds at which the body's cold-open hook ends. When > 0 AND
     *  the body has at least one input preceding it (i.e. an intro is
     *  in the chain), the splice reorders to hook-first:
     *  [body_hook][intro][body_rest][outro] instead of the legacy
     *  [intro][body][outro]. `body_hook` is the body clipped to
     *  [0, hookEndSec] and `body_rest` is the body from hookEndSec to
     *  the end — both implemented by listing the body file twice in
     *  the argv with different -ss/-t flags so the encoder runs once.
     *  Per _plans/2026-06-28-hook-before-brand-intro.md (manager
     *  directive: the cold-open hook must land in the first 1.5 s,
     *  before the brand stinger). 0 (the default) preserves the
     *  legacy ordering for every caller that hasn't opted in. */
    hookEndSec?: number;
    /** Paced hook-first seams (seconds). When hook-first is active these add a
     *  fade-to-black + silent beat before the intro, a silent beat after it, and
     *  a fade-in on the resume. 0 (the default) keeps the legacy hard cut so
     *  every caller that hasn't opted in is byte-identical. Mirrors
     *  pipeline/segments.py. Per _plans/2026-06-29-hook-first-clean-pacing.md. */
    fadeSec?: number;
    hookGapSec?: number;
    introGapSec?: number;
    tailHoldSec?: number;
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
  const hookEndSec = options.hookEndSec ?? 0;
  const fadeSec = options.fadeSec ?? 0;
  const hookGapSec = options.hookGapSec ?? 0;
  const introGapSec = options.introGapSec ?? 0;
  const tailHoldSec = options.tailHoldSec ?? 0;
  // Hook-first only applies when (a) the caller opted in, (b) the body's
  // index is valid, and (c) something precedes the body in playback order
  // (otherwise there's no intro to push behind the hook). When inactive,
  // the legacy [intro][body][outro] ordering is produced byte-identically.
  const hookFirstActive =
    bodyIndex !== undefined &&
    hookEndSec > 0 &&
    bodyIndex > 0 &&
    bodyIndex < inputs.length;
  // Pad only when (a) the caller actually wants one, (b) the body's index
  // is valid, and (c) something follows the body — padding the tail of a
  // body that's already last in the chain just lengthens the output for
  // no reason. Hook-first reorders the body's tail (body_rest) into the
  // middle of the chain, so the pad-active check still holds — when
  // hook-first is on, body_rest's neighbor on the right is whatever
  // came AFTER the body in the original `inputs` (typically the outro).
  const padActive =
    bodyIndex !== undefined &&
    bodyTailPadSec > 0 &&
    bodyIndex >= 0 &&
    bodyIndex < inputs.length - 1;

  if (hookFirstActive) {
    return buildHookFirstArgv(
      inputs,
      output,
      bodyIndex as number,
      hookEndSec,
      hasAudio,
      bodyTailPadSec,
      padActive,
      fadeSec,
      hookGapSec,
      introGapSec,
      tailHoldSec,
    );
  }

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

/**
 * Hook-first variant of the concat argv. The body file is listed TWICE in the
 * ffmpeg input list — once with `-ss 0 -t hookEndSec` for the cold-open hook
 * clip, once with `-ss hookEndSec` for the rest of the body — so one re-encode
 * pass produces the rearranged stream:
 *
 *   [body_hook][pre-body inputs in caller order][body_rest][post-body inputs]
 *
 * For the canonical caller shape `inputs = [intro, body, outro]` with
 * `bodyIndex = 1`, the physical argv inputs become `[body, intro, body, outro]`
 * (positions 0, 1, 2, 3) and the concat filter references them in playback
 * order. The body's tail-pad, when active, applies to the SECOND body input
 * (body_rest at physical position bodyIndex + 1) so the pre-outro pause still
 * sits where the outro needs it.
 *
 * Pure: no IO. Same as the legacy path. Caller (spliceWithSegments) owns the
 * subprocess.
 */
/** Mirror Python's `format(x, "g")` (≈6 significant figures, trailing zeros
 *  trimmed) so computed durations like `hookEndSec - fadeSec` stringify the same
 *  on both paths. Plain `String(2.5 - 0.45)` yields "2.0499999999999998"; this
 *  yields "2.05" to match the Python splicer byte-for-byte. */
function fmtG(x: number): string {
  return String(parseFloat(x.toPrecision(6)));
}

/**
 * filter_complex for the PACED hook-first splice: body_hook fades to black and
 * holds a silent beat (`hookGapSec`), the intro (the last pre-body input,
 * physical index `bodyIndex`) holds a silent beat (`introGapSec`), and body_rest
 * fades back in (`fadeSec`) — so the brand intro lands between two pauses instead
 * of a hard cut. `tpad=stop_mode=add` pads with solid black so the held beat is
 * pure black regardless of the fade's last frame. `bodyTailPadSec` is the
 * already-gated outro lead-in pad on body_rest (0 disables it). Mirrors
 * pipeline/segments.py:_hook_first_paced_filter. Per
 * _plans/2026-06-29-hook-first-clean-pacing.md.
 */
function hookFirstPacedFilter(
  concatN: number,
  bodyIndex: number,
  restPhysicalIndex: number,
  hasAudio: boolean,
  hookEndSec: number,
  fadeSec: number,
  hookGapSec: number,
  introGapSec: number,
  bodyTailPadSec: number,
  tailHoldSec: number,
): string {
  const parts: string[] = [];
  let refs = "";
  for (let i = 0; i < concatN; i++) {
    const vch: string[] = [];
    const ach: string[] = [];
    if (i === 0) {
      // body_hook: freeze the last clean frame at hookEndSec while the audio
      // finishes the line (runs tailHoldSec longer), then fade to black + beat.
      const aEnd = hookEndSec + tailHoldSec;
      vch.push(`trim=0:${fmtG(hookEndSec)}`);
      vch.push("setpts=PTS-STARTPTS");
      vch.push(`tpad=stop_mode=clone:stop_duration=${fmtG(tailHoldSec + fadeSec)}`);
      if (fadeSec > 0) {
        vch.push(`fade=t=out:st=${fmtG(aEnd)}:d=${fmtG(fadeSec)}`);
      }
      if (hookGapSec > 0) {
        vch.push(`tpad=stop_mode=add:stop_duration=${fmtG(hookGapSec)}`);
      }
      // Audio fade-out spans the entire held region [hookEndSec, aEnd]. The
      // body_hook input runs to aEnd, so the audio in that range is the
      // natural consonant decay of the last hook word PLUS (in the gap=0
      // case) the first ~tailHoldSec milliseconds of the next sentence. We
      // fade BOTH so the decay plays at falling volume (natural sound) and
      // any next-sentence bleed is heavily attenuated (mostly inaudible).
      // The full-volume hook word still plays cleanly through hookEndSec.
      // Skipped when tailHoldSec is 0 (no held region to fade); the
      // dispatcher floors tailHoldSec in render.ts so hook-first renders
      // always get a held region. Per the 2026-06-30 incident note in
      // render.ts:MIN_HOOK_AUDIO_TAIL_HOLD_SEC.
      if (tailHoldSec > 0) {
        ach.push(
          `afade=t=out:st=${fmtG(hookEndSec)}:d=${fmtG(tailHoldSec)}`,
        );
      }
      const apadDur = fadeSec + hookGapSec;
      if (apadDur > 0) {
        ach.push(`apad=pad_dur=${fmtG(apadDur)}`);
      }
    } else if (i === bodyIndex) {
      // the intro: hold a silent beat before the story resumes.
      if (introGapSec > 0) {
        vch.push(`tpad=stop_mode=add:stop_duration=${fmtG(introGapSec)}`);
        ach.push(`apad=pad_dur=${fmtG(introGapSec)}`);
      }
    } else if (i === restPhysicalIndex) {
      // body_rest: fade in, then the outro lead-in pad.
      if (fadeSec > 0) {
        vch.push(`fade=t=in:st=0:d=${fmtG(fadeSec)}`);
        ach.push(`afade=t=in:d=${fmtG(fadeSec)}`);
      }
      if (bodyTailPadSec > 0) {
        vch.push(`tpad=stop_mode=clone:stop_duration=${fmtG(bodyTailPadSec)}`);
        ach.push(`apad=pad_dur=${fmtG(bodyTailPadSec)}`);
      }
    }
    if (vch.length > 0) {
      parts.push(`[${i}:v:0]${vch.join(",")}[pv${i}]`);
      refs += `[pv${i}]`;
    } else {
      refs += `[${i}:v:0]`;
    }
    if (hasAudio) {
      if (ach.length > 0) {
        parts.push(`[${i}:a:0]${ach.join(",")}[pa${i}]`);
        refs += `[pa${i}]`;
      } else {
        refs += `[${i}:a:0]`;
      }
    }
  }
  const audioFlag = hasAudio ? 1 : 0;
  let streams = parts.map((p) => p + ";").join("") + refs;
  streams += `concat=n=${concatN}:v=1:a=${audioFlag}[v]`;
  if (hasAudio) streams += "[a]";
  return streams;
}

function buildHookFirstArgv(
  inputs: string[],
  output: string,
  bodyIndex: number,
  hookEndSec: number,
  hasAudio: boolean,
  bodyTailPadSec: number,
  padActive: boolean,
  fadeSec = 0,
  hookGapSec = 0,
  introGapSec = 0,
  tailHoldSec = 0,
): string[] {
  // Build the physical input list. The body appears at physical positions
  // 0 (the hook clip) and bodyIndex + 1 (the rest clip). Everything else
  // keeps its caller-supplied order but shifts up by 1 because body_hook
  // is now the first input.
  // Example: inputs=[intro, body, outro], bodyIndex=1 →
  //   physical=[body, intro, body, outro]
  //   hookPhysicalIndex=0, restPhysicalIndex=2
  const paced = fadeSec > 0 || hookGapSec > 0 || introGapSec > 0;
  // body_hook runs to `bodyHookEndSec` (hookEndSec + tailHoldSec when paced)
  // so the audio tail-hold region is present in the input. body_rest resumes
  // at `bodyRestStartSec` which is INDEPENDENT — it always starts at
  // hookEndSec so the next sentence's first syllable is preserved at full
  // volume in body_rest after the intro. The body_hook tail and body_rest
  // start overlap by tailHoldSec of original-body audio: the overlap plays
  // at fading volume in body_hook (the afade-out, in the paced filter) and
  // at full volume in body_rest (after the intro). With the brand intro
  // between the two, the overlap is perceptually two separate events, not a
  // duplicate. Pre-paced renders (legacy, no fade seams) use a single split
  // because the hard-cut design has no held region. Per the 2026-06-30
  // splice fix.
  const bodyHookEndSec = fmtG(hookEndSec + (paced ? tailHoldSec : 0));
  const bodyRestStartSec = fmtG(hookEndSec);
  const argv: string[] = ["ffmpeg", "-y"];
  // Position 0: body_hook (runs through the held tail region).
  argv.push("-ss", "0", "-t", bodyHookEndSec, "-i", inputs[bodyIndex]);
  // Positions 1..bodyIndex: the pre-body segments (typically just the intro).
  for (let i = 0; i < bodyIndex; i++) {
    argv.push("-i", inputs[i]);
  }
  // Position bodyIndex + 1: body_rest (resumes at hookEndSec — the visual
  // scene-edge cut — so no next-sentence audio is lost when paced).
  argv.push("-ss", bodyRestStartSec, "-i", inputs[bodyIndex]);
  // Positions bodyIndex + 2..: the post-body segments (typically the outro).
  for (let i = bodyIndex + 1; i < inputs.length; i++) {
    argv.push("-i", inputs[i]);
  }

  // Physical index of body_rest in the ffmpeg input list.
  const restPhysicalIndex = bodyIndex + 1;
  // Concat input count = original input count + 1 (body listed twice).
  const concatN = inputs.length + 1;

  // Filter graph. body_rest gets the tail-pad when one is active; when the paced
  // seams are on, the dedicated builder adds the freeze + fades + silent beats.
  let streams: string;
  if (paced) {
    streams = hookFirstPacedFilter(
      concatN,
      bodyIndex,
      restPhysicalIndex,
      hasAudio,
      hookEndSec,
      fadeSec,
      hookGapSec,
      introGapSec,
      padActive ? bodyTailPadSec : 0,
      tailHoldSec,
    );
  } else {
    streams = "";
    if (padActive) {
      const padS = String(bodyTailPadSec);
      streams += `[${restPhysicalIndex}:v:0]tpad=stop_mode=clone:stop_duration=${padS}[bv];`;
      if (hasAudio) {
        streams += `[${restPhysicalIndex}:a:0]apad=pad_dur=${padS}[ba];`;
      }
    }
    for (let i = 0; i < concatN; i++) {
      if (padActive && i === restPhysicalIndex) {
        streams += `[bv]`;
        if (hasAudio) streams += `[ba]`;
      } else {
        streams += `[${i}:v:0]`;
        if (hasAudio) streams += `[${i}:a:0]`;
      }
    }
    const audioFlag = hasAudio ? 1 : 0;
    streams += `concat=n=${concatN}:v=1:a=${audioFlag}[v]`;
    if (hasAudio) streams += "[a]";
  }

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
