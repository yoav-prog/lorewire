// Composition props shape, written by `pipeline/video.py` to a JSON file the
// CLI render command reads. Ported from yt-studio's ShortVideoConfig / ShortCaptionChunk
// (see _reference/youtubestudio/src/lib/shorts-render-types.ts) with the fields we
// actually need; LoreWire stories don't have variant chunks, channel branding from
// CMS, or i2v animation_url yet, so those are dropped.

export interface DoodleFrame {
  url: string;             // file:// or http(s):// path to the image
  caption_chunk_start_index: number; // index into ShortVideoConfig.captions
}

export interface ShortCaptionWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface ShortCaptionChunk {
  start_ms: number;
  end_ms: number;
  text: string;
  words?: ShortCaptionWord[]; // when present, drives the karaoke highlight
}

// CaptionTemplateInput lives in caption-style.ts (next to the resolver) and is
// re-exported here so external consumers can import the whole props shape from
// one module without reaching into the styling internals.
import type { CaptionTemplateInput } from "./caption-style";
export type { CaptionTemplateInput };

// Wave 3 Phase 3: composition-only motion beats, each independently
// togglable from /admin/settings. All off = byte-identical to today's
// render. The composition reads each flag and skips the layer when off so
// no work is done. prop_slide also needs a non-empty props_list to do
// anything; the pipeline writes that list to the story row when the
// prop-slide beat is enabled.
export interface MotionConfig {
  micro_wiggle?: boolean;
  label_pop?: boolean;
  scribble_draw?: boolean;
  prop_slide?: boolean;
  mouth_swap?: boolean;
}

export interface PropListItem {
  url: string;
  label?: string;
  side?: "left" | "right" | "top" | "bottom";
}

export interface ShortVideoConfig {
  voiceover_url: string;
  title?: string;
  channel_name?: string;
  duration_ms: number;
  doodle_frames: DoodleFrame[];
  captions: ShortCaptionChunk[];
  // Wave 2 admin toggle: when true, each held image gets a slow Ken-Burns
  // pan/zoom so 30-60 scenes don't feel static between cuts. Off by default
  // to preserve the doodle look.
  ken_burns?: boolean;
  // Wave 3 Phase 1: admin-edited caption styling. Every field is optional;
  // resolveCaptionTemplate() in caption-style.ts fills missing fields from
  // DOODLE_CAPTION_STYLE so the existing doodle look is the safe default.
  caption_template?: CaptionTemplateInput;
  // Wave 3 Phase 3 motion beats. Missing = all off.
  motion?: MotionConfig;
  // Prop list for the prop_slide beat. Pipeline writes it when the beat is
  // enabled; composition slides each prop in at evenly spaced intervals.
  props_list?: PropListItem[];
  // Mouth-removed character bust for the mouth_swap beat. Pipeline writes
  // it when the beat is enabled; composition overlays SVG mouth shapes at
  // a fixed anchor while playing. Missing = no talking head rendered.
  character_image_mouth_removed?: string;
}
