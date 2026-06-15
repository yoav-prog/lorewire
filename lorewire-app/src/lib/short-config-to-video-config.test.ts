// Tests for the ShortConfig → ShortVideoConfig adapter that drives the
// short editor's live preview player.

import { describe, expect, it } from "vitest";
import { shortConfigToVideoConfig } from "@/lib/short-config-to-video-config";
import {
  CURRENT_SHORT_CONFIG_VERSION,
  type ShortConfig,
} from "@/lib/short-config";

function baseShort(over: Partial<ShortConfig> = {}): ShortConfig {
  return {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    doodle_frames: [
      {
        id: "frame-00",
        url: "https://gcs/00.png",
        caption_chunk_start_index: 0,
        image_prompt: "scene a",
      },
      {
        id: "frame-01",
        url: "https://gcs/01.png",
        caption_chunk_start_index: 3,
      },
    ],
    captions: [
      { start_ms: 0, end_ms: 2000, text: "Once upon a time" },
      { start_ms: 2000, end_ms: 4500, text: "in an office" },
    ],
    voiceover_url: "https://gcs/voice.mp3",
    duration_ms: 4500,
    ...over,
  };
}

describe("shortConfigToVideoConfig", () => {
  it("pins aspect to 9:16 (shorts are always vertical)", () => {
    const v = shortConfigToVideoConfig(baseShort());
    expect(v.aspect).toBe("9:16");
  });

  it("passes through doodle_frames + captions verbatim", () => {
    const s = baseShort();
    const v = shortConfigToVideoConfig(s);
    expect(v.doodle_frames).toEqual([
      {
        id: "frame-00",
        url: "https://gcs/00.png",
        caption_chunk_start_index: 0,
        image_prompt: "scene a",
      },
      {
        id: "frame-01",
        url: "https://gcs/01.png",
        caption_chunk_start_index: 3,
        image_prompt: undefined,
      },
    ]);
    expect(v.captions).toEqual(s.captions);
  });

  it("passes through voiceover_url when set", () => {
    const v = shortConfigToVideoConfig(baseShort());
    expect(v.voiceover_url).toBe("https://gcs/voice.mp3");
  });

  it("falls back to empty voiceover_url on cold start (no render yet)", () => {
    const v = shortConfigToVideoConfig(baseShort({ voiceover_url: undefined }));
    expect(v.voiceover_url).toBe("");
  });

  it("computes duration_ms = max(config.duration_ms, last_caption_end, 1000)", () => {
    // Config explicit duration wins when it's the largest
    expect(
      shortConfigToVideoConfig(baseShort({ duration_ms: 10_000 })).duration_ms,
    ).toBe(10_000);
    // Caption end wins when duration_ms is missing
    expect(
      shortConfigToVideoConfig(
        baseShort({ duration_ms: undefined }),
      ).duration_ms,
    ).toBe(4500);
    // 1s floor wins when there's nothing else
    expect(
      shortConfigToVideoConfig({
        config_version: CURRENT_SHORT_CONFIG_VERSION,
        doodle_frames: [],
        captions: [],
      }).duration_ms,
    ).toBe(1000);
  });

  it("zeros out the motion beats so the editor preview doesn't animate", () => {
    const v = shortConfigToVideoConfig(baseShort());
    expect(v.motion).toEqual({
      micro_wiggle: false,
      label_pop: false,
      scribble_draw: false,
      prop_slide: false,
      mouth_swap: false,
    });
    expect(v.ken_burns).toBe(false);
  });
});
