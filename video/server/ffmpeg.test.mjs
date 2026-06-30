// Phase 2 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
//
// Pure tests for the ffmpeg concat argv builder. Asserts the shape of the
// argv against the contract `pipeline/segments.py:_ffmpeg_splice_cmd` uses
// so a render produced through the Cloud Run path mirrors the local
// pipeline's output bit-for-bit (modulo encode non-determinism).
//
// Uses node:test (compiled JS imported from dist/) — same harness pattern
// as index.test.mjs sits alongside.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  AAC_BITRATE,
  H264_CRF,
  H264_PRESET,
  TARGET_AUDIO_CHANNELS,
  TARGET_AUDIO_RATE,
  TARGET_FPS,
  buildConcatArgv,
} from "../dist/server/ffmpeg.js";
import { parseGcsSegmentUrl, parseSegmentUrl } from "../dist/server/render.js";

describe("buildConcatArgv", () => {
  it("throws on fewer than 2 inputs (single-clip splice is meaningless)", () => {
    assert.throws(() => buildConcatArgv([], "/tmp/out.mp4"), RangeError);
    assert.throws(() => buildConcatArgv(["/tmp/body.mp4"], "/tmp/out.mp4"), RangeError);
  });

  it("emits a 2-input concat (intro + body, no outro) with the right filter graph", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4"],
      "/tmp/out.mp4",
    );
    // Stream label sequence: 2 inputs * (video + audio) = 4 stream refs
    const filterIdx = argv.indexOf("-filter_complex");
    assert.ok(filterIdx > 0, "argv must carry -filter_complex");
    const filter = argv[filterIdx + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
    );
    // Output path is always the last token.
    assert.equal(argv.at(-1), "/tmp/out.mp4");
    // Re-encode contract is preserved verbatim.
    assert.ok(argv.includes("libx264"));
    assert.ok(argv.includes(H264_PRESET));
    assert.ok(argv.includes(H264_CRF));
    assert.ok(argv.includes(String(TARGET_FPS)));
    assert.ok(argv.includes("aac"));
    assert.ok(argv.includes(AAC_BITRATE));
    assert.ok(argv.includes(String(TARGET_AUDIO_RATE)));
    assert.ok(argv.includes(String(TARGET_AUDIO_CHANNELS)));
    assert.ok(argv.includes("+faststart"));
  });

  it("emits a 3-input concat (intro + body + outro) with the right filter graph", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0]concat=n=3:v=1:a=1[v][a]",
    );
    // Each input is preceded by `-i` — three inputs ⇒ three `-i` tokens.
    const inputFlagCount = argv.filter((t) => t === "-i").length;
    assert.equal(inputFlagCount, 3);
  });

  it("respects hasAudio=false (drops audio streams + audio map + audio encode)", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4"],
      "/tmp/out.mp4",
      { hasAudio: false },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(filter, "[0:v:0][1:v:0]concat=n=2:v=1:a=0[v]");
    // No `[a]` map, no aac encoder flags.
    const mapIndices = argv.reduce((acc, t, i) => {
      if (t === "-map") acc.push(i);
      return acc;
    }, []);
    assert.equal(mapIndices.length, 1);
    assert.equal(argv[mapIndices[0] + 1], "[v]");
    assert.equal(argv.includes("aac"), false);
    assert.equal(argv.includes("-b:a"), false);
  });

  it("applies a body tail-pad before the outro when configured", () => {
    // intro(0) + body(1) + outro(2); pad on body should hold its last
    // video frame for 1.5s + extend its audio with silence for the
    // same. Concat picks up `[bv][ba]` in place of `[1:v:0][1:a:0]`.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, bodyTailPadSec: 1.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[1:v:0]tpad=stop_mode=clone:stop_duration=1.5[bv];" +
        "[1:a:0]apad=pad_dur=1.5[ba];" +
        "[0:v:0][0:a:0][bv][ba][2:v:0][2:a:0]concat=n=3:v=1:a=1[v][a]",
    );
  });

  it("pad without intro: body at index 0, outro at 1", () => {
    // Same fix, no intro — body is input 0.
    const argv = buildConcatArgv(
      ["/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 0, bodyTailPadSec: 1.2 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0]tpad=stop_mode=clone:stop_duration=1.2[bv];" +
        "[0:a:0]apad=pad_dur=1.2[ba];" +
        "[bv][ba][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
    );
  });

  it("skips the pad when nothing follows the body (no outro)", () => {
    // intro + body, no outro — padding the body would just lengthen
    // the output for no reason, so the filter graph drops to the
    // pre-fix shape.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, bodyTailPadSec: 1.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
    );
  });

  it("skips the pad when bodyTailPadSec is 0 or missing", () => {
    // Even with outro present, a 0-second (or unset) pad must produce
    // the exact same argv as the unpadded path — back-compat.
    const baseline = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
    );
    const zero = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, bodyTailPadSec: 0 },
    );
    assert.deepEqual(zero, baseline);
  });

  it("body-tail-pad respects hasAudio=false (no apad clause)", () => {
    // Without audio there's no [body:a:0] to pad — only the video gets
    // the tpad clause and only [bv] feeds the concat.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { hasAudio: false, bodyIndex: 1, bodyTailPadSec: 1.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[1:v:0]tpad=stop_mode=clone:stop_duration=1.5[bv];" +
        "[0:v:0][bv][2:v:0]concat=n=3:v=1:a=0[v]",
    );
  });

  it("hook-first: reorders to [body_hook][intro][body_rest][outro] when hookEndSec > 0 and intro precedes body", () => {
    // _plans/2026-06-28-hook-before-brand-intro.md. The body file appears
    // twice in the physical argv — once with `-ss 0 -t 2.5` (the hook
    // clip), once with `-ss 2.5` (the rest) — so the concat filter sees
    // four streams in playback order: body_hook → intro → body_rest → outro.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5 },
    );
    // Physical input order in argv: body, intro, body, outro.
    // Each -i is preceded by either -ss/-t (body_hook), nothing (intro),
    // -ss (body_rest), or nothing (outro). Three -i for the bare inputs
    // plus one more (the body listed twice) = 4 -i tokens.
    const inputFlagCount = argv.filter((t) => t === "-i").length;
    assert.equal(inputFlagCount, 4);
    // Walk the argv and confirm the seek shape: -ss 0 -t 2.5 -i body,
    // -i intro, -ss 2.5 -i body, -i outro.
    const ffmpegPrefixLen = 2; // ["ffmpeg", "-y"]
    assert.deepEqual(
      argv.slice(ffmpegPrefixLen, ffmpegPrefixLen + 6),
      ["-ss", "0", "-t", "2.5", "-i", "/tmp/body.mp4"],
    );
    assert.deepEqual(
      argv.slice(ffmpegPrefixLen + 6, ffmpegPrefixLen + 8),
      ["-i", "/tmp/intro.mp4"],
    );
    assert.deepEqual(
      argv.slice(ffmpegPrefixLen + 8, ffmpegPrefixLen + 12),
      ["-ss", "2.5", "-i", "/tmp/body.mp4"],
    );
    assert.deepEqual(
      argv.slice(ffmpegPrefixLen + 12, ffmpegPrefixLen + 14),
      ["-i", "/tmp/outro.mp4"],
    );
    // Filter graph references the 4 physical inputs in playback order.
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0][3:v:0][3:a:0]concat=n=4:v=1:a=1[v][a]",
    );
  });

  it("hook-first with tail-pad: pad lands on body_rest, not body_hook", () => {
    // The outro still needs the silence-before-outro contract, so the
    // tpad/apad clause attaches to body_rest (the second body input,
    // physical index = bodyIndex + 1 = 2). body_hook lands directly
    // into the intro with no pad.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, bodyTailPadSec: 1.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[2:v:0]tpad=stop_mode=clone:stop_duration=1.5[bv];" +
        "[2:a:0]apad=pad_dur=1.5[ba];" +
        "[0:v:0][0:a:0][1:v:0][1:a:0][bv][ba][3:v:0][3:a:0]concat=n=4:v=1:a=1[v][a]",
    );
  });

  it("hook-first without outro: [body_hook][intro][body_rest], no pad", () => {
    // intro + body only — the outro slot is empty, so the chain is
    // 3 physical inputs and no pad applies (body_rest is now last).
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, bodyTailPadSec: 1.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0]concat=n=3:v=1:a=1[v][a]",
    );
    // body_rest has nothing after it, so the pad clause is dropped.
    assert.equal(filter.includes("tpad"), false);
    assert.equal(filter.includes("apad"), false);
  });

  it("hook-first inactive when hookEndSec is 0: byte-identical to legacy argv", () => {
    // Opt-in semantics: a zero (or unset) hookEndSec must produce the
    // SAME argv as the pre-hook-first path. No surprises for callers
    // that haven't migrated.
    const baseline = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, bodyTailPadSec: 1.5 },
    );
    const zero = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, bodyTailPadSec: 1.5, hookEndSec: 0 },
    );
    assert.deepEqual(zero, baseline);
  });

  it("hook-first inactive when no intro precedes body: legacy argv", () => {
    // Nothing to push behind the hook — falls through to the legacy
    // ordering. bodyIndex=0 means the body is already first.
    const argv = buildConcatArgv(
      ["/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 0, hookEndSec: 2.5 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[v][a]",
    );
    // No body duplication — only 2 inputs.
    const inputFlagCount = argv.filter((t) => t === "-i").length;
    assert.equal(inputFlagCount, 2);
  });

  it("hook-first with hasAudio=false: pad clause drops apad, concat drops audio map", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, bodyTailPadSec: 1.5, hasAudio: false },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[2:v:0]tpad=stop_mode=clone:stop_duration=1.5[bv];" +
        "[0:v:0][1:v:0][bv][3:v:0]concat=n=4:v=1:a=0[v]",
    );
    assert.equal(argv.includes("aac"), false);
  });

  // Paced hook-first seams (fade-to-black + silent beat each side of the intro).
  // _plans/2026-06-29-hook-first-clean-pacing.md. Expected strings are IDENTICAL
  // to pipeline/tests/test_segments.py so the two splice paths stay byte-equal.

  it("hook-first paced: body_hook freezes + holds the line, afade spans the held region; body_rest resumes at hookEndSec (NOT split)", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, fadeSec: 0.45, hookGapSec: 1.1, introGapSec: 0.9, tailHoldSec: 0.3 },
    );
    // body_hook input runs to hookEndSec + tailHoldSec = 2.8 so the held tail
    // audio region is present for the afade to attenuate. body_rest input
    // resumes at hookEndSec (2.5) — NOT at 2.8 — so the next sentence's first
    // syllable is preserved at full volume after the intro. The [2.5, 2.8]
    // body audio range plays in BOTH body_hook (fading) AND body_rest (full
    // volume), with the brand intro between them so the brain processes them
    // as separate events. Per the 2026-06-30 splice fix.
    assert.deepEqual(argv.slice(2, 8), ["-ss", "0", "-t", "2.8", "-i", "/tmp/body.mp4"]);
    assert.deepEqual(argv.slice(10, 14), ["-ss", "2.5", "-i", "/tmp/body.mp4"]);
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0]trim=0:2.5,setpts=PTS-STARTPTS," +
        "tpad=stop_mode=clone:stop_duration=0.75," +
        "fade=t=out:st=2.8:d=0.45,tpad=stop_mode=add:stop_duration=1.1[pv0];" +
        // Audio fade-out spans the entire held region [hookEndSec, aEnd] =
        // [2.5, 2.8]. The body audio in that range is the natural consonant
        // decay of the last hook word PLUS (in gap=0 cases) the start of the
        // next sentence — both at decreasing volume. Per the 2026-06-30
        // splice fix.
        "[0:a:0]afade=t=out:st=2.5:d=0.3,apad=pad_dur=1.55[pa0];" +
        "[1:v:0]tpad=stop_mode=add:stop_duration=0.9[pv1];" +
        "[1:a:0]apad=pad_dur=0.9[pa1];" +
        "[2:v:0]fade=t=in:st=0:d=0.45[pv2];" +
        "[2:a:0]afade=t=in:d=0.45[pa2];" +
        "[pv0][pa0][pv1][pa1][pv2][pa2][3:v:0][3:a:0]" +
        "concat=n=4:v=1:a=1[v][a]",
    );
  });

  it("hook-first paced: tailHoldSec=0 means no held region; the afade-out clause is dropped from body_hook audio", () => {
    // tailHoldSec=0 happens when the caller hasn't opted into the floor (the
    // dispatcher in render.ts floors it at MIN_HOOK_AUDIO_TAIL_HOLD_SEC for
    // hook-first renders). For a pure builder test with tailHoldSec=0, there's
    // no held region for the afade to span, so the audio chain collapses to
    // just the apad silence. body_rest -ss still equals hookEndSec.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      {
        bodyIndex: 1,
        hookEndSec: 2.0,
        fadeSec: 0.45,
        hookGapSec: 1.1,
        introGapSec: 0.9,
        tailHoldSec: 0,
      },
    );
    // Both body inputs cut at the same point (2.0) — no held region.
    assert.deepEqual(argv.slice(2, 8), ["-ss", "0", "-t", "2", "-i", "/tmp/body.mp4"]);
    assert.deepEqual(argv.slice(10, 14), ["-ss", "2", "-i", "/tmp/body.mp4"]);
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    // afade is skipped (tailHoldSec=0 means no held region to fade); body_hook
    // audio chain is just the apad silence pad.
    assert.ok(
      filter.includes("[0:a:0]apad=pad_dur=1.55[pa0]"),
      `expected no afade in body_hook audio chain; got: ${filter}`,
    );
    assert.equal(
      filter.includes("afade=t=out"),
      false,
      `expected NO afade=t=out clause; got: ${filter}`,
    );
  });

  it("hook-first paced: 150ms floor case — body_rest -ss decouples from body_hook -t (the 2026-06-30 fix shape)", () => {
    // Regression for the 2026-06-30 incident on idea_a744e0a033b0. With the
    // render.ts floor in place, tailHoldSec arrives here as 0.15 even when
    // the pipeline's gap-sized value was 0. The body_hook input gets 150ms
    // of post-hookEndSec audio to fade out; body_rest resumes at hookEndSec
    // so "That was..." plays cleanly after the intro from its first syllable.
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      {
        bodyIndex: 1,
        hookEndSec: 1.9, // the user's actual hook_end_sec from the rewrite log
        fadeSec: 0.45,
        hookGapSec: 1.1,
        introGapSec: 0.9,
        tailHoldSec: 0.15, // the floored value from render.ts
      },
    );
    // body_hook -t = 1.9 + 0.15 = 2.05; body_rest -ss = 1.9 (decoupled).
    assert.deepEqual(argv.slice(2, 8), ["-ss", "0", "-t", "2.05", "-i", "/tmp/body.mp4"]);
    assert.deepEqual(argv.slice(10, 14), ["-ss", "1.9", "-i", "/tmp/body.mp4"]);
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    // afade spans [1.9, 2.05] = the full held region.
    assert.ok(
      filter.includes("[0:a:0]afade=t=out:st=1.9:d=0.15,apad="),
      `expected afade spanning the held region [1.9, 2.05]; got: ${filter}`,
    );
  });

  it("hook-first paced: body_rest keeps the outro lead-in pad after the fade-in", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      {
        bodyIndex: 1,
        hookEndSec: 2.5,
        bodyTailPadSec: 1.5,
        fadeSec: 0.45,
        hookGapSec: 1.1,
        introGapSec: 0.9,
        tailHoldSec: 0.3,
      },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.ok(
      filter.includes(
        "[2:v:0]fade=t=in:st=0:d=0.45,tpad=stop_mode=clone:stop_duration=1.5[pv2];" +
          "[2:a:0]afade=t=in:d=0.45,apad=pad_dur=1.5[pa2];",
      ),
    );
  });

  it("hook-first paced: all seam durations 0 is byte-identical to the legacy argv", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, bodyTailPadSec: 1.5, fadeSec: 0, hookGapSec: 0, introGapSec: 0 },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[2:v:0]tpad=stop_mode=clone:stop_duration=1.5[bv];" +
        "[2:a:0]apad=pad_dur=1.5[ba];" +
        "[0:v:0][0:a:0][1:v:0][1:a:0][bv][ba][3:v:0][3:a:0]" +
        "concat=n=4:v=1:a=1[v][a]",
    );
  });

  it("hook-first paced with hasAudio=false: drops apad/afade and the audio map", () => {
    const argv = buildConcatArgv(
      ["/tmp/intro.mp4", "/tmp/body.mp4", "/tmp/outro.mp4"],
      "/tmp/out.mp4",
      { bodyIndex: 1, hookEndSec: 2.5, fadeSec: 0.45, hookGapSec: 1.1, introGapSec: 0.9, tailHoldSec: 0.3, hasAudio: false },
    );
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(
      filter,
      "[0:v:0]trim=0:2.5,setpts=PTS-STARTPTS," +
        "tpad=stop_mode=clone:stop_duration=0.75," +
        "fade=t=out:st=2.8:d=0.45,tpad=stop_mode=add:stop_duration=1.1[pv0];" +
        "[1:v:0]tpad=stop_mode=add:stop_duration=0.9[pv1];" +
        "[2:v:0]fade=t=in:st=0:d=0.45[pv2];" +
        "[pv0][pv1][pv2][3:v:0]concat=n=4:v=1:a=0[v]",
    );
    assert.equal(filter.includes("apad"), false);
    assert.equal(
      filter.includes("afade"),
      false,
      "hasAudio=false must not leak the new body_hook afade-out into the video-only filter",
    );
  });

  it("treats input paths as standalone argv tokens (no shell interpolation)", () => {
    // Paths with spaces, semicolons, and quotes pass through untouched —
    // any shell hazard at the call site is the spawner's problem, not
    // ours. We verify each input lands as ONE argv entry.
    const sneaky = "/tmp/has space; rm -rf /.mp4";
    const argv = buildConcatArgv([sneaky, "/tmp/body.mp4"], "/tmp/out.mp4");
    // The path appears exactly once in the argv, as a standalone token —
    // never embedded inside the -filter_complex string.
    const matches = argv.filter((t) => t === sneaky);
    assert.equal(matches.length, 1);
    const filter = argv[argv.indexOf("-filter_complex") + 1];
    assert.equal(filter.includes(sneaky), false);
  });
});

describe("parseGcsSegmentUrl", () => {
  const BUCKET = "lorewire-media";

  it("returns the key for a well-formed URL pointing at the expected bucket", () => {
    const key = parseGcsSegmentUrl(
      `https://storage.googleapis.com/${BUCKET}/segments/abc-123.mp4`,
      BUCKET,
    );
    assert.equal(key, "segments/abc-123.mp4");
  });

  it("returns null when the bucket doesn't match (defense in depth)", () => {
    const key = parseGcsSegmentUrl(
      "https://storage.googleapis.com/some-other-bucket/segments/x.mp4",
      BUCKET,
    );
    assert.equal(key, null);
  });

  it("returns null for non-storage hosts", () => {
    assert.equal(
      parseGcsSegmentUrl(`https://attacker.example/${BUCKET}/x.mp4`, BUCKET),
      null,
    );
  });

  it("returns null when the path doesn't end in .mp4", () => {
    assert.equal(
      parseGcsSegmentUrl(`https://storage.googleapis.com/${BUCKET}/foo.txt`, BUCKET),
      null,
    );
  });

  it("returns null for http:// (insists on https)", () => {
    assert.equal(
      parseGcsSegmentUrl(`http://storage.googleapis.com/${BUCKET}/x.mp4`, BUCKET),
      null,
    );
  });

  it("returns null for empty or junk input", () => {
    assert.equal(parseGcsSegmentUrl("", BUCKET), null);
    assert.equal(parseGcsSegmentUrl("not a url", BUCKET), null);
  });
});

describe("parseSegmentUrl (GCS + R2 unified)", () => {
  const GCS_BUCKET = "lorewire-media";
  const R2_BUCKET = "lorewire-media-r2";
  const R2_BASE = "https://media.lorewire.com";
  const FULL_OPTS = {
    gcsBucket: GCS_BUCKET,
    r2PublicBase: R2_BASE,
    r2Bucket: R2_BUCKET,
  };

  it("tags a legacy GCS URL as kind:gcs with the GCS bucket", () => {
    const ref = parseSegmentUrl(
      `https://storage.googleapis.com/${GCS_BUCKET}/segments/abc.mp4`,
      FULL_OPTS,
    );
    assert.deepEqual(ref, {
      kind: "gcs",
      bucket: GCS_BUCKET,
      key: "segments/abc.mp4",
    });
  });

  it("tags a post-cutover R2 URL as kind:r2 with the R2 bucket", () => {
    const ref = parseSegmentUrl(
      `${R2_BASE}/segments/intro-reel-2.norm.mp4`,
      FULL_OPTS,
    );
    assert.deepEqual(ref, {
      kind: "r2",
      bucket: R2_BUCKET,
      key: "segments/intro-reel-2.norm.mp4",
    });
  });

  it("returns null when neither shape matches (foreign host fails closed)", () => {
    assert.equal(
      parseSegmentUrl(
        "https://attacker.example/segments/intro.mp4",
        FULL_OPTS,
      ),
      null,
    );
  });

  it("refuses an R2 URL when r2PublicBase is null (pre-cutover safety)", () => {
    const ref = parseSegmentUrl(`${R2_BASE}/segments/intro.mp4`, {
      gcsBucket: GCS_BUCKET,
      r2PublicBase: null,
      r2Bucket: null,
    });
    assert.equal(ref, null);
  });

  it("refuses a GCS URL pointing at a foreign bucket even when R2 is configured", () => {
    const ref = parseSegmentUrl(
      "https://storage.googleapis.com/other-bucket/segments/x.mp4",
      FULL_OPTS,
    );
    assert.equal(ref, null);
  });
});
