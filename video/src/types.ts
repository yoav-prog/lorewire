// Composition props shape, written by `pipeline/video.py` to a JSON file the
// CLI render command reads AND persisted on stories.video_config so the
// admin /admin/videos/[id] editor and the pipeline share one source of truth
// (see _plans/2026-06-11-video-editor.md — single-schema decision). Ported
// from yt-studio's ShortVideoConfig / ShortCaptionChunk with the fields we
// actually need; LoreWire stories don't have variant chunks, channel branding
// from CMS, or i2v animation_url yet, so those are dropped.
//
// The composition itself only depends on the render-relevant fields. Editor-
// only metadata (_locks, _edit_session, config_version) is carried alongside
// but unused by the renderer — the principle is that the renderer treats
// unknown fields as no-ops so the schema is additive-safe.

// Current schema version. Bump on breaking changes only; new optional fields
// do not require a bump. pipeline/video.py and the Zod validator both check
// this and apply the migration layer in `video-config-migrations.ts`.
export const CURRENT_CONFIG_VERSION = 2;

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

// V1.5 editor: a single optional background music track at fixed gain. Real
// sidechain ducking is out of scope (see plan §Rejected alternatives). The
// composition mixes the track at `gain_db` under the voiceover; values below
// -24 dB are effectively silent. Missing = no music.
export interface MusicTrack {
  url: string;
  gain_db: number;
}

// V1.5 editor: free-form text overlay positioned by relative coords. Reserved
// in the schema so saves don't fail; composition treats an empty array as
// no-op for v1 and grows a single overlay type in v1.5.
export interface Overlay {
  start_ms: number;
  end_ms: number;
  text: string;
  // [0..1] coords from top-left of the 1080x1920 frame.
  x: number;
  y: number;
}

// Editor-only: per-field lock map. Key is a dotted path into ShortVideoConfig
// (e.g. "title", "captions[3].text", "music.url"); value `true` means the
// field is human-edited and the pipeline must NOT overwrite it on re-runs.
// pipeline/video.py reads this via `merge_with_locks()` before writing.
export type LockMap = Record<string, true>;

// Editor-only: lightweight presence/heartbeat so two admins opening the same
// editor see each other (see plan §UI structure). Refreshed every
// `video.editor.heartbeat_interval_ms`; stale sessions (>2x interval) are
// treated as departed.
export interface EditSession {
  user_id: string;
  started_at: string;
  heartbeat_at: string;
}

export interface ShortVideoConfig {
  // Schema version. Must equal CURRENT_CONFIG_VERSION when emitted by the
  // pipeline; the validator applies migrations for older values.
  config_version?: number;
  voiceover_url: string;
  title?: string;
  channel_name?: string;
  duration_ms: number;
  // V1 editor trim: render only frames in [clip_start_ms, clip_end_ms].
  // Both default to the full duration so a missing trim is byte-identical
  // to today's render. Composition honors them in `Sequence` windows.
  clip_start_ms?: number;
  clip_end_ms?: number;
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
  // V1.5 editor — single bg track at fixed gain. Missing = no music.
  music?: MusicTrack;
  // V1.5 editor — reserved; renderer no-ops on an empty array.
  overlays?: Overlay[];
  // Editor-only metadata. The renderer ignores both.
  _locks?: LockMap;
  _edit_session?: EditSession;
}
