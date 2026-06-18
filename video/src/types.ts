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
  // Stable per-frame identifier. Phase 2 of the video editor overhaul
  // (lorewire-app/_plans/2026-06-12-video-editor-overhaul.md). UUID minted
  // on first parse if a legacy config is missing it; persisted on the
  // next save. Once written, the id survives regens, prompt edits, and
  // frame reordering — queue rows keyed by `frame:<id>` stay valid.
  id: string;
  url: string;             // file:// or http(s):// path to the image
  caption_chunk_start_index: number; // index into ShortVideoConfig.captions
  // The prompt that produced `url`. Optional during the rollout window
  // before Phase 3's regen action backfills it on first regen. The
  // renderer ignores this field — it exists for the editor and the queue
  // worker.
  image_prompt?: string;
  // Single-step Revert history. Phase 3's regen action snapshots the
  // pre-regen url + prompt here before writing the new image so the
  // editor can undo without another model call. Cleared by an explicit
  // Revert action. The renderer ignores this field.
  prev_image?: {
    url: string;
    image_prompt: string;
    replaced_at: string; // ISO-8601
  };
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

// Phase 0 of _plans/2026-06-12-video-aspect-ratio.md: per-story aspect
// override. Missing field is interpreted as the legacy 9:16 default at
// the resolver (`resolveAspect` in aspect.ts) so every existing render
// stays byte-identical until a story or the global setting opts in.
import type { VideoAspect } from "./aspect";
export type { VideoAspect };

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

// Phase 3 of _plans/2026-06-17-engagement-polls.md. Burnt-in end card
// drawn at the tail of every short whose story has an enabled poll.
// Populated by pipeline/shorts_render.py:build_short_props from the
// polls table; the renderer keeps `duration_ms` extended by
// `card_ms` so the QuestionCard sequence sits at
// [duration_ms - card_ms, duration_ms].
//
// `slug` is the story slug used in the footer CTA
// (lorewire.com/v/<slug>). Falls back to the safe story id when the
// story has no slug yet — better to ship "lorewire.com/v/abc123"
// than no link at all.
//
// Missing field = no card. The composition renders byte-identical to
// today's shorts when a story has no poll.
export interface QuestionCard {
  question: string;
  option_a: string;
  option_b: string;
  slug: string;
  card_ms: number;
}

export interface ShortVideoConfig {
  // Schema version. Must equal CURRENT_CONFIG_VERSION when emitted by the
  // pipeline; the validator applies migrations for older values.
  config_version?: number;
  voiceover_url: string;
  title?: string;
  channel_name?: string;
  // Per-story aspect override. Missing means "fall through to the
  // global default; if that's missing too, fall back to the legacy
  // 9:16 portrait so pre-existing rows render unchanged" — the chain
  // lives in `resolveAspect()` in ./aspect.ts.
  aspect?: VideoAspect;
  duration_ms: number;
  // V1 editor trim: render only frames in [clip_start_ms, clip_end_ms].
  // Both default to the full duration so a missing trim is byte-identical
  // to today's render. Composition honors them in `Sequence` windows.
  clip_start_ms?: number;
  clip_end_ms?: number;
  // Post-roll hold (ms) on the final scene. The shorts pipeline sets this so
  // the last frame lingers past the narration and the closing word finishes
  // before the outro splices on. Missing / 0 = no hold (long-form renders are
  // unchanged). deriveCompositionMetadata grows durationInFrames by it and
  // DoodleShort stretches the last frame's window to match.
  end_hold_ms?: number;
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
  // Phase 3 of _plans/2026-06-17-engagement-polls.md. Burnt-in
  // question card at the tail. When present, the composition's
  // `duration_ms` was already extended by the build step to include
  // the card's hold time; the renderer places the card sequence at
  // [duration_ms - question_card.card_ms, duration_ms]. Missing
  // field = no card, renders byte-identical to a pre-poll short.
  question_card?: QuestionCard;
  // Editor-only metadata. The renderer ignores both.
  _locks?: LockMap;
  _edit_session?: EditSession;
}
