// Adapter: ShortConfig (short editor's source of truth) -> ShortVideoConfig
// (the renderer's view, also consumed by components/video-preview/PreviewComposition
// for live editor playback).
//
// The two schemas overlap on the load-bearing fields (doodle_frames,
// captions, voiceover_url, duration_ms) and diverge on long-form-only
// concerns (intro/outro segments, aspect toggle, music, motion beats,
// trim clip). Shorts are always 9:16, never carry intro/outro music,
// never trim, so the adapter pins those fields to sensible defaults.
//
// The preview composition reads `aspect`, so we MUST set it to '9:16';
// PreviewComposition would otherwise render a 16:9 canvas.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (preview slice).

import type { ShortVideoConfig } from "@/lib/video-config";
import type { ShortConfig } from "@/lib/short-config";

const DEFAULT_DURATION_MS = 1_000;

export function shortConfigToVideoConfig(
  short: ShortConfig,
): ShortVideoConfig {
  // duration_ms is required by the renderer; fall back to "long enough to
  // cover the captions" when the short hasn't been rendered yet (the
  // cold-start editor has no duration_ms on short_config until Lane A/B/C
  // has run at least once). Captions array end_ms is a reasonable lower
  // bound; otherwise use a 1s placeholder so the Player has SOMETHING.
  const captionEnd = short.captions.length
    ? short.captions[short.captions.length - 1].end_ms
    : 0;
  const duration_ms = Math.max(
    short.duration_ms ?? 0,
    captionEnd,
    DEFAULT_DURATION_MS,
  );
  return {
    config_version: 2,
    aspect: "9:16",
    voiceover_url: short.voiceover_url ?? "",
    duration_ms,
    doodle_frames: short.doodle_frames.map((f) => ({
      id: f.id,
      url: f.url,
      caption_chunk_start_index: f.caption_chunk_start_index,
      image_prompt: f.image_prompt,
    })),
    captions: short.captions.map((c) => ({
      start_ms: c.start_ms,
      end_ms: c.end_ms,
      text: c.text,
    })),
    title: undefined,
    channel_name: "lorewire",
    ken_burns: false,
    motion: {
      micro_wiggle: false,
      label_pop: false,
      scribble_draw: false,
      prop_slide: false,
      mouth_swap: false,
    },
    props_list: [],
  };
}
