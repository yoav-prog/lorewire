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
import { parseGcsSegmentUrl } from "../dist/server/render.js";

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
