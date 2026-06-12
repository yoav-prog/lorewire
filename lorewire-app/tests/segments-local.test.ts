// Pure-helper coverage for lib/segments-local. The actual ffmpeg invocation
// is integration territory (depends on the host having ffmpeg on PATH), so
// we lock the argv shape with these unit tests — a regression in the args
// would silently produce un-spliceable output. The integration test sits in
// pipeline/tests/test_segments_ffmpeg.py against the Python implementation
// of the same contract; we keep both sides aligned by asserting identical
// values here.

import { describe, expect, it } from "vitest";
import {
  buildNormalizeArgs,
  buildProbeDurationArgs,
} from "@/lib/segments-local";

describe("segments-local / buildNormalizeArgs", () => {
  const argv = buildNormalizeArgs("/tmp/source.mp4", "/tmp/out.mp4");

  it("uses -y to overwrite existing output (idempotent retries)", () => {
    expect(argv[0]).toBe("-y");
  });

  it("targets 1080x1920 with center-crop and 30 fps", () => {
    const vf = argv[argv.indexOf("-vf") + 1];
    expect(vf).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(vf).toContain("crop=1080:1920");
    expect(vf).toContain("fps=30");
  });

  it("forces stereo 48 kHz audio so concat needs no resample", () => {
    const af = argv[argv.indexOf("-af") + 1];
    expect(af).toContain("sample_rates=48000");
    expect(af).toContain("channel_layouts=stereo");
    expect(argv).toContain("-ar");
    expect(argv[argv.indexOf("-ar") + 1]).toBe("48000");
    expect(argv).toContain("-ac");
    expect(argv[argv.indexOf("-ac") + 1]).toBe("2");
  });

  it("encodes H.264 fast + CRF 20 + yuv420p (browser-safe)", () => {
    expect(argv[argv.indexOf("-c:v") + 1]).toBe("libx264");
    expect(argv[argv.indexOf("-preset") + 1]).toBe("fast");
    expect(argv[argv.indexOf("-crf") + 1]).toBe("20");
    expect(argv[argv.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
  });

  it("encodes AAC at 192 kbps to match the pipeline contract", () => {
    expect(argv[argv.indexOf("-c:a") + 1]).toBe("aac");
    expect(argv[argv.indexOf("-b:a") + 1]).toBe("192k");
  });

  it("emits faststart MP4 so the admin preview seeks without redownload", () => {
    expect(argv[argv.indexOf("-movflags") + 1]).toBe("+faststart");
  });

  it("passes the input and output paths through unchanged", () => {
    expect(argv[argv.indexOf("-i") + 1]).toBe("/tmp/source.mp4");
    expect(argv[argv.length - 1]).toBe("/tmp/out.mp4");
  });
});

describe("segments-local / buildProbeDurationArgs", () => {
  it("asks ffprobe for format=duration with no key/wrapper noise", () => {
    const argv = buildProbeDurationArgs("/tmp/x.mp4");
    expect(argv).toEqual([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      "/tmp/x.mp4",
    ]);
  });
});

// ─── Phase 3 of _plans/2026-06-12-video-aspect-ratio.md ─────────────────────

describe("segments-local / buildNormalizeArgs — aspect branching", () => {
  it("default aspect keeps the legacy portrait 1080x1920 graph", () => {
    const argv = buildNormalizeArgs("/tmp/src.mp4", "/tmp/out.mp4");
    const vf = argv[argv.indexOf("-vf") + 1];
    expect(vf).toContain("scale=1080:1920");
    expect(vf).toContain("crop=1080:1920");
  });

  it("explicit 9:16 aspect produces identical argv to the default", () => {
    const baseline = buildNormalizeArgs("/tmp/src.mp4", "/tmp/out.mp4");
    const explicit = buildNormalizeArgs("/tmp/src.mp4", "/tmp/out.mp4", "9:16");
    expect(explicit).toEqual(baseline);
  });

  it("16:9 aspect produces a 1920x1080 vf filter", () => {
    const argv = buildNormalizeArgs("/tmp/src.mp4", "/tmp/out.mp4", "16:9");
    const vf = argv[argv.indexOf("-vf") + 1];
    expect(vf).toContain("scale=1920:1080");
    expect(vf).toContain("crop=1920:1080");
    expect(vf).toContain("force_original_aspect_ratio=increase");
    expect(vf).toContain("fps=30");
  });

  it("only the video filter changes between aspects — every other arg stays put", () => {
    const portrait = buildNormalizeArgs("/tmp/src.mp4", "/tmp/out.mp4", "9:16");
    const landscape = buildNormalizeArgs(
      "/tmp/src.mp4",
      "/tmp/out.mp4",
      "16:9",
    );
    // The two argv lists differ only at the -vf value position.
    const vfIdx = portrait.indexOf("-vf");
    expect(portrait.length).toBe(landscape.length);
    portrait.forEach((arg, i) => {
      if (i === vfIdx + 1) return;
      expect(landscape[i]).toBe(arg);
    });
  });
});
