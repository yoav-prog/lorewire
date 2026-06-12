// Server-and-client safe schema for stories.video_config.
//
// MUST stay in sync with `video/src/types.ts`. The /video/ Remotion project
// is the renderer's view of this schema; this file is the editor + DB view.
// We duplicate rather than cross-import because /video/src/types.ts pulls in
// Remotion runtime modules (caption-style etc.) we do NOT want Next bundling
// into the admin client. The single-schema rule from
// `_plans/2026-06-11-video-editor.md` is enforced by a parity test
// (`lib/__tests__/video-config-parity.test.ts`) rather than by import.
//
// When you add a field here, add it to `video/src/types.ts` in the same PR.

import type { StoryRow } from "@/lib/repo";
import { isVideoAspect, type VideoAspect } from "@/lib/aspect";

export const CURRENT_CONFIG_VERSION = 2;

// ─── Schema (mirror of video/src/types.ts) ────────────────────────────────────

// ─── DoodleFrame: stable per-frame entity ────────────────────────────────────
// Phase 2 of the video editor overhaul
// (_plans/2026-06-12-video-editor-overhaul.md). `id` is a UUID minted on
// first parse if a legacy config is missing it; persisted on the next
// save. Once written, the id survives regens, prompt edits, and frame
// reordering — queue rows keyed by `frame:<id>` stay valid. `image_prompt`
// is the prompt that produced `url`. `prev_image` is the single-step
// Revert snapshot Phase 3 writes before regen so the editor can undo
// without another model call.

export interface PrevImage {
  url: string;
  image_prompt: string;
  replaced_at: string; // ISO-8601
}

export interface DoodleFrame {
  id: string;
  url: string;
  caption_chunk_start_index: number;
  image_prompt?: string;
  prev_image?: PrevImage;
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
  words?: ShortCaptionWord[];
}

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

// Caption template fields — loose mirror of the structure
// `caption-style.ts` resolves. Editor never edits these for v1; we just
// pass the value through to the renderer untouched.
export type CaptionTemplate = Record<string, unknown>;

export interface MusicTrack {
  url: string;
  gain_db: number;
}

export interface Overlay {
  start_ms: number;
  end_ms: number;
  text: string;
  x: number;
  y: number;
}

export type LockMap = Record<string, true>;

export interface EditSession {
  user_id: string;
  started_at: string;
  heartbeat_at: string;
}

export interface ShortVideoConfig {
  config_version?: number;
  voiceover_url: string;
  title?: string;
  channel_name?: string;
  // Per-story aspect override. Phase 0 of
  // _plans/2026-06-12-video-aspect-ratio.md. Missing field is interpreted
  // as the legacy 9:16 default in `resolveAspect()` so existing rows
  // render byte-identical.
  aspect?: VideoAspect;
  duration_ms: number;
  clip_start_ms?: number;
  clip_end_ms?: number;
  doodle_frames: DoodleFrame[];
  captions: ShortCaptionChunk[];
  ken_burns?: boolean;
  caption_template?: CaptionTemplate;
  motion?: MotionConfig;
  props_list?: PropListItem[];
  character_image_mouth_removed?: string;
  music?: MusicTrack;
  overlays?: Overlay[];
  _locks?: LockMap;
  _edit_session?: EditSession;
}

// ─── Parse + validate ─────────────────────────────────────────────────────────

export interface ParseOk {
  ok: true;
  config: ShortVideoConfig;
}
export interface ParseErr {
  ok: false;
  error: string;
}
export type ParseResult = ParseOk | ParseErr;

// Strict validator: returns a typed config or a path-prefixed error message.
// Unknown top-level fields are silently dropped — that's the council's "the
// renderer treats unknown fields as no-ops" boundary, enforced here so the
// schema can grow without coordinated deploys. Editor patches that include
// junk fields will save the known parts and discard the rest.
export function parseVideoConfig(raw: unknown): ParseResult {
  if (!isObject(raw)) return err("root: expected object");

  const migrated = migrateVideoConfig(raw);

  const voiceover_url = readString(migrated, "voiceover_url");
  if (voiceover_url.error) return voiceover_url.error;

  const duration_ms = readNumber(migrated, "duration_ms", { min: 0 });
  if (duration_ms.error) return duration_ms.error;

  const doodle_frames = readArray(
    migrated,
    "doodle_frames",
    parseDoodleFrame,
  );
  if (doodle_frames.error) return doodle_frames.error;

  const captions = readArray(migrated, "captions", parseCaptionChunk);
  if (captions.error) return captions.error;

  const clip_start_ms = readOptionalNumber(migrated, "clip_start_ms", {
    min: 0,
    max: duration_ms.value,
  });
  if (clip_start_ms.error) return clip_start_ms.error;
  const clip_end_ms = readOptionalNumber(migrated, "clip_end_ms", {
    min: clip_start_ms.value ?? 0,
    max: duration_ms.value,
  });
  if (clip_end_ms.error) return clip_end_ms.error;

  const music = readOptional(migrated, "music", parseMusicTrack);
  if (music.error) return music.error;

  const overlays = readOptionalArray(migrated, "overlays", parseOverlay);
  if (overlays.error) return overlays.error;

  const motion = readOptional(migrated, "motion", parseMotion);
  if (motion.error) return motion.error;

  const props_list = readOptionalArray(migrated, "props_list", parsePropItem);
  if (props_list.error) return props_list.error;

  const _locks = readOptional(migrated, "_locks", parseLockMap);
  if (_locks.error) return _locks.error;

  const _edit_session = readOptional(
    migrated,
    "_edit_session",
    parseEditSession,
  );
  if (_edit_session.error) return _edit_session.error;

  const config: ShortVideoConfig = {
    config_version: CURRENT_CONFIG_VERSION,
    voiceover_url: voiceover_url.value,
    duration_ms: duration_ms.value,
    doodle_frames: doodle_frames.value,
    captions: captions.value,
  };

  // Optional pass-throughs. We don't validate caption_template's interior here
  // — the renderer's resolveCaptionTemplate() falls back per-field. Keeping
  // the editor agnostic of styling internals matches the existing pattern
  // (see how `payload` is treated in repo.ts).
  if (typeof migrated.title === "string") config.title = migrated.title;
  if (typeof migrated.channel_name === "string") {
    config.channel_name = migrated.channel_name;
  }
  if (typeof migrated.ken_burns === "boolean") {
    config.ken_burns = migrated.ken_burns;
  }
  if (isObject(migrated.caption_template)) {
    config.caption_template = migrated.caption_template as CaptionTemplate;
  }
  if (typeof migrated.character_image_mouth_removed === "string") {
    config.character_image_mouth_removed =
      migrated.character_image_mouth_removed;
  }
  // Per-story aspect override. Only the two supported values survive; any
  // other shape (legacy field, typo, malicious payload) is dropped silently
  // so the resolver falls back to the global default / legacy 9:16.
  if (isVideoAspect(migrated.aspect)) {
    config.aspect = migrated.aspect;
  }

  if (clip_start_ms.value !== undefined) {
    config.clip_start_ms = clip_start_ms.value;
  }
  if (clip_end_ms.value !== undefined) config.clip_end_ms = clip_end_ms.value;
  if (music.value) config.music = music.value;
  if (overlays.value) config.overlays = overlays.value;
  if (motion.value) config.motion = motion.value;
  if (props_list.value) config.props_list = props_list.value;
  if (_locks.value) config._locks = _locks.value;
  if (_edit_session.value) config._edit_session = _edit_session.value;

  return { ok: true, config };
}

// Apply schema migrations. v1 → v2 lifts the implicit "no trim" default into
// an explicit absent clip_start_ms/clip_end_ms (both treated as full
// duration by the renderer), so no transform is needed. Future bumps land
// their migration logic here.
export function migrateVideoConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const version =
    typeof raw.config_version === "number" ? raw.config_version : 1;
  if (version >= CURRENT_CONFIG_VERSION) return raw;
  // v1 → v2: no field rename, just stamp the version.
  return { ...raw, config_version: CURRENT_CONFIG_VERSION };
}

// ─── Apply an editor patch onto a base config ────────────────────────────────

// Used by the /admin/videos/[id] save server action. Takes a guaranteed-
// valid `base`, a partial patch object the editor sent, and the dotted
// paths the user actually touched. Returns a new dict where each top-level
// patch key is shallow-merged over the base, every lock path is stamped
// into `_locks`, and every unlock path is removed from `_locks`.
//
// The lock paths come from the editor (not from the patch keys) because
// the editor sometimes patches multiple related fields when the user only
// "touched" one — e.g. the trim handle moves both clip_start_ms and
// clip_end_ms but only the dragged handle should be the headline lock if
// we want sibling-vs-pair distinction later. Today both are locked but
// the API keeps the door open.
//
// The caller is responsible for re-running parseVideoConfig() on the
// result to catch patches that produce an invalid full shape (the action
// in actions.ts does this).
export function applyConfigPatch(
  base: ShortVideoConfig,
  patch: Record<string, unknown>,
  lockPaths: string[],
  unlockPaths: string[] = [],
): ShortVideoConfig {
  // Shallow merge — patch keys overwrite top-level base keys. Deep merge
  // would surprise: a music patch with only `gain_db` would expect to keep
  // the existing url, and JSON spread does that already at the top level
  // because the editor sends the full music object when editing either
  // field.
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // Reject editor-only keys in the patch path. The editor must never
    // overwrite _locks or _edit_session through saveVideoConfigPatch;
    // those have their own dedicated unlockPaths arg / heartbeat action.
    if (key === "_locks" || key === "_edit_session") continue;
    out[key] = value;
  }

  const existingLocks = (out._locks as LockMap | undefined) ?? base._locks ?? {};
  const nextLocks: LockMap = { ...existingLocks };
  for (const path of lockPaths) {
    if (typeof path !== "string" || path.length === 0) continue;
    nextLocks[path] = true;
  }
  for (const path of unlockPaths) {
    if (typeof path !== "string" || path.length === 0) continue;
    delete nextLocks[path];
  }
  if (Object.keys(nextLocks).length > 0) {
    out._locks = nextLocks;
  } else {
    // Empty lock map is equivalent to "no locks at all" but keeping the
    // empty object on the row leaks editor metadata into pipeline-only
    // reads; drop it so the JSON column stays minimal.
    delete out._locks;
  }

  return out as unknown as ShortVideoConfig;
}

// ─── Derived initial config ───────────────────────────────────────────────────

// First-open helper: when the editor lands on a story without a
// video_config yet, build one from the story's raw pipeline outputs. The
// pipeline will write a fuller version on its next run, but the editor can
// already show the player and accept edits.
//
// The alignment column lives in two historical shapes:
//   1. word-level: [{ word, start, end }] with start/end in *seconds*
//      (what STT writes and what the pipeline's _chunk_alignment consumes)
//   2. chunk-level: [{ start_ms, end_ms, text, words? }] with values in ms
//      (matches ShortCaptionChunk directly)
// We detect the shape and convert both into ShortCaptionChunk[]. If neither
// matches OR the column is empty, captions come back empty and duration_ms
// defaults to 1 ms so the Player still gets a finite, integer
// durationInFrames (it rejects NaN with a hard TypeError).
export function defaultVideoConfig(story: StoryRow): ShortVideoConfig {
  const images = safeJsonArray<string>(story.images);
  const captions = parseAlignmentFlexibly(story.alignment);
  const totalMs = lastCaptionEnd(captions);

  const doodle_frames: DoodleFrame[] = images.map((url, i) => ({
    id: mintFrameId(),
    url,
    caption_chunk_start_index: Math.floor(
      (i / Math.max(1, images.length)) * Math.max(1, captions.length),
    ),
  }));

  return {
    config_version: CURRENT_CONFIG_VERSION,
    voiceover_url: story.audio_url ?? "",
    title: story.title ?? undefined,
    channel_name: "lorewire",
    // Guarantee a finite non-negative integer. 0 is a valid "unknown" —
    // the editor's `safePositiveInt` guard clamps it up to a 1-frame
    // placeholder when handing it to @remotion/player. The Player
    // hard-rejects NaN/Infinity though, which is what we're really
    // defending against here.
    duration_ms: Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0,
    doodle_frames,
    captions,
  };
}

// ─── Alignment parsing (used by defaultVideoConfig) ──────────────────────────

// Detect the alignment shape and convert to ShortCaptionChunk[]. Returns
// [] for anything we can't interpret — including non-array JSON, objects
// with unexpected keys, or values that fail the NaN/finite checks. The
// editor tolerates an empty captions array gracefully; what it can't
// tolerate is a single bad number infecting duration_ms.
function parseAlignmentFlexibly(
  raw: string | null | undefined,
): ShortCaptionChunk[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  const first = parsed[0];
  if (typeof first !== "object" || first === null) return [];
  const sample = first as Record<string, unknown>;

  // Shape 1: chunk-level. Already what we want — just defensively validate.
  if (
    typeof sample.start_ms === "number" &&
    typeof sample.end_ms === "number"
  ) {
    return (parsed as unknown[])
      .map((c) => {
        if (!c || typeof c !== "object") return null;
        const o = c as Record<string, unknown>;
        if (
          !Number.isFinite(o.start_ms as number) ||
          !Number.isFinite(o.end_ms as number) ||
          typeof o.text !== "string"
        ) {
          return null;
        }
        return {
          start_ms: o.start_ms as number,
          end_ms: o.end_ms as number,
          text: o.text,
        } satisfies ShortCaptionChunk;
      })
      .filter((c): c is ShortCaptionChunk => c !== null);
  }

  // Shape 2: word-level (start/end in seconds). Chunk per the same rules
  // pipeline/video.py uses so the editor-derived captions match the
  // eventual render byte-for-byte.
  if (
    "word" in sample &&
    typeof sample.start === "number" &&
    typeof sample.end === "number"
  ) {
    return chunkAlignmentWords(
      parsed.filter(
        (w): w is { word: string; start: number; end: number } =>
          !!w &&
          typeof w === "object" &&
          typeof (w as Record<string, unknown>).word === "string" &&
          Number.isFinite((w as Record<string, unknown>).start as number) &&
          Number.isFinite((w as Record<string, unknown>).end as number),
      ),
    );
  }

  return [];
}

// Mirrors pipeline/video.py:_chunk_alignment so the editor's first-open
// derivation lines up with what the pipeline would write on its next run.
const MAX_WORDS_PER_CHUNK = 4;
const PAUSE_BREAK_S = 0.4;
const PUNCT_BREAK_RE = /[.!?,;:]$/;

function chunkAlignmentWords(
  words: Array<{ word: string; start: number; end: number }>,
): ShortCaptionChunk[] {
  const chunks: ShortCaptionChunk[] = [];
  let current: typeof words = [];

  for (const w of words) {
    if (current.length > 0) {
      const last = current[current.length - 1];
      const breakHere =
        current.length >= MAX_WORDS_PER_CHUNK ||
        w.start - last.end >= PAUSE_BREAK_S ||
        PUNCT_BREAK_RE.test(last.word);
      if (breakHere) {
        chunks.push(materializeChunk(current));
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length > 0) chunks.push(materializeChunk(current));
  return chunks;
}

function materializeChunk(
  words: Array<{ word: string; start: number; end: number }>,
): ShortCaptionChunk {
  return {
    start_ms: Math.round(words[0].start * 1000),
    end_ms: Math.round(words[words.length - 1].end * 1000),
    text: words.map((w) => w.word).join(" "),
    words: words.map((w) => ({
      word: w.word,
      start_ms: Math.round(w.start * 1000),
      end_ms: Math.round(w.end * 1000),
    })),
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(message: string): ParseErr {
  return { ok: false, error: message };
}

interface FieldOk<T> {
  value: T;
  error?: undefined;
}
interface FieldErr {
  error: ParseErr;
  value?: undefined;
}
type FieldResult<T> = FieldOk<T> | FieldErr;

function ok<T>(value: T): FieldOk<T> {
  return { value };
}

function readString(
  obj: Record<string, unknown>,
  key: string,
): FieldResult<string> {
  const raw = obj[key];
  if (typeof raw !== "string") {
    return { error: err(`${key}: expected string, got ${typeName(raw)}`) };
  }
  return ok(raw);
}

function readNumber(
  obj: Record<string, unknown>,
  key: string,
  bounds?: { min?: number; max?: number },
): FieldResult<number> {
  const raw = obj[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { error: err(`${key}: expected finite number`) };
  }
  if (bounds?.min !== undefined && raw < bounds.min) {
    return { error: err(`${key}: ${raw} below min ${bounds.min}`) };
  }
  if (bounds?.max !== undefined && raw > bounds.max) {
    return { error: err(`${key}: ${raw} above max ${bounds.max}`) };
  }
  return ok(raw);
}

function readOptionalNumber(
  obj: Record<string, unknown>,
  key: string,
  bounds?: { min?: number; max?: number },
): FieldResult<number | undefined> {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    return ok(undefined);
  }
  return readNumber(obj, key, bounds);
}

function readArray<T>(
  obj: Record<string, unknown>,
  key: string,
  parse: (item: unknown, idx: number) => FieldResult<T>,
): FieldResult<T[]> {
  const raw = obj[key];
  if (!Array.isArray(raw)) {
    return { error: err(`${key}: expected array, got ${typeName(raw)}`) };
  }
  const out: T[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = parse(raw[i], i);
    if (r.error) {
      return { error: err(`${key}[${i}].${r.error.error}`) };
    }
    out.push(r.value);
  }
  return ok(out);
}

function readOptionalArray<T>(
  obj: Record<string, unknown>,
  key: string,
  parse: (item: unknown, idx: number) => FieldResult<T>,
): FieldResult<T[] | undefined> {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    return ok(undefined);
  }
  return readArray(obj, key, parse);
}

function readOptional<T>(
  obj: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => FieldResult<T>,
): FieldResult<T | undefined> {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    return ok(undefined);
  }
  return parse(obj[key]);
}

function parseDoodleFrame(raw: unknown): FieldResult<DoodleFrame> {
  if (!isObject(raw)) return { error: err("expected object") };
  const url = readString(raw, "url");
  if (url.error) return { error: url.error };
  const idx = readNumber(raw, "caption_chunk_start_index", { min: 0 });
  if (idx.error) return { error: idx.error };

  // `id` is the contract surface for Phase 3's regen action. Mint a fresh
  // UUID when a legacy config is missing it — the next save persists the
  // value. Empty-string ids are treated as missing (the renderer would
  // otherwise carry a bogus key forward).
  const rawId =
    typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
  const id = rawId ?? mintFrameId();

  const out: DoodleFrame = {
    id,
    url: url.value,
    caption_chunk_start_index: idx.value,
  };

  // `image_prompt` is optional — present once a frame has been regenerated
  // through Phase 3 (or backfilled). When missing or empty-string we omit
  // it so the persisted JSON stays minimal.
  if (typeof raw.image_prompt === "string" && raw.image_prompt.length > 0) {
    out.image_prompt = raw.image_prompt;
  }

  // `prev_image` is the single-step Revert snapshot Phase 3 writes before
  // a regen; missing on a fresh frame.
  if (raw.prev_image !== undefined && raw.prev_image !== null) {
    const prev = parsePrevImage(raw.prev_image);
    if (prev.error) return { error: prev.error };
    out.prev_image = prev.value;
  }

  return ok(out);
}

function parsePrevImage(raw: unknown): FieldResult<PrevImage> {
  if (!isObject(raw)) return { error: err("prev_image: expected object") };
  const url = readString(raw, "url");
  if (url.error) return { error: url.error };
  const image_prompt = readString(raw, "image_prompt");
  if (image_prompt.error) return { error: image_prompt.error };
  const replaced_at = readString(raw, "replaced_at");
  if (replaced_at.error) return { error: replaced_at.error };
  return ok({
    url: url.value,
    image_prompt: image_prompt.value,
    replaced_at: replaced_at.value,
  });
}

// `mintFrameId` is exported so server actions (Phase 3) can stamp ids on
// freshly-derived frames before queuing a regen — the queue row's
// `frame:<id>` reference must match a stable id the editor will write
// back on save.
export function mintFrameId(): string {
  // globalThis.crypto.randomUUID is available in the browser, Node 18+,
  // happy-dom (test env), and edge runtimes. The fallback only fires on
  // a deeply broken host that's missing Web Crypto entirely — a frame
  // still comes back with a unique-enough id rather than crashing.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `frame-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function parseCaptionChunk(raw: unknown): FieldResult<ShortCaptionChunk> {
  if (!isObject(raw)) return { error: err("expected object") };
  const start_ms = readNumber(raw, "start_ms", { min: 0 });
  if (start_ms.error) return { error: start_ms.error };
  const end_ms = readNumber(raw, "end_ms", { min: start_ms.value });
  if (end_ms.error) return { error: end_ms.error };
  const text = readString(raw, "text");
  if (text.error) return { error: text.error };
  const out: ShortCaptionChunk = {
    start_ms: start_ms.value,
    end_ms: end_ms.value,
    text: text.value,
  };
  if (Array.isArray(raw.words)) {
    const words: ShortCaptionWord[] = [];
    for (const w of raw.words) {
      if (!isObject(w)) continue;
      const word = readString(w, "word");
      const ws = readNumber(w, "start_ms", { min: 0 });
      const we = readNumber(w, "end_ms", { min: 0 });
      if (word.error || ws.error || we.error) continue;
      words.push({ word: word.value, start_ms: ws.value, end_ms: we.value });
    }
    out.words = words;
  }
  return ok(out);
}

function parseMusicTrack(raw: unknown): FieldResult<MusicTrack> {
  if (!isObject(raw)) return { error: err("expected object") };
  const url = readString(raw, "url");
  if (url.error) return { error: url.error };
  const gain_db = readNumber(raw, "gain_db", { min: -60, max: 12 });
  if (gain_db.error) return { error: gain_db.error };
  return ok({ url: url.value, gain_db: gain_db.value });
}

function parseOverlay(raw: unknown): FieldResult<Overlay> {
  if (!isObject(raw)) return { error: err("expected object") };
  const start_ms = readNumber(raw, "start_ms", { min: 0 });
  if (start_ms.error) return { error: start_ms.error };
  const end_ms = readNumber(raw, "end_ms", { min: start_ms.value });
  if (end_ms.error) return { error: end_ms.error };
  const text = readString(raw, "text");
  if (text.error) return { error: text.error };
  const x = readNumber(raw, "x", { min: 0, max: 1 });
  if (x.error) return { error: x.error };
  const y = readNumber(raw, "y", { min: 0, max: 1 });
  if (y.error) return { error: y.error };
  return ok({
    start_ms: start_ms.value,
    end_ms: end_ms.value,
    text: text.value,
    x: x.value,
    y: y.value,
  });
}

function parseMotion(raw: unknown): FieldResult<MotionConfig> {
  if (!isObject(raw)) return { error: err("expected object") };
  const out: MotionConfig = {};
  for (const k of [
    "micro_wiggle",
    "label_pop",
    "scribble_draw",
    "prop_slide",
    "mouth_swap",
  ] as const) {
    if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  }
  return ok(out);
}

function parsePropItem(raw: unknown): FieldResult<PropListItem> {
  if (!isObject(raw)) return { error: err("expected object") };
  const url = readString(raw, "url");
  if (url.error) return { error: url.error };
  const out: PropListItem = { url: url.value };
  if (typeof raw.label === "string") out.label = raw.label;
  if (raw.side === "left" || raw.side === "right" || raw.side === "top" || raw.side === "bottom") {
    out.side = raw.side;
  }
  return ok(out);
}

function parseLockMap(raw: unknown): FieldResult<LockMap> {
  if (!isObject(raw)) return { error: err("expected object") };
  const out: LockMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === true) out[k] = true;
  }
  return ok(out);
}

function parseEditSession(raw: unknown): FieldResult<EditSession> {
  if (!isObject(raw)) return { error: err("expected object") };
  const user_id = readString(raw, "user_id");
  if (user_id.error) return { error: user_id.error };
  const started_at = readString(raw, "started_at");
  if (started_at.error) return { error: started_at.error };
  const heartbeat_at = readString(raw, "heartbeat_at");
  if (heartbeat_at.error) return { error: heartbeat_at.error };
  return ok({
    user_id: user_id.value,
    started_at: started_at.value,
    heartbeat_at: heartbeat_at.value,
  });
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function safeJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function lastCaptionEnd(captions: ShortCaptionChunk[]): number {
  if (captions.length === 0) return 0;
  return captions.reduce((m, c) => Math.max(m, c.end_ms), 0);
}
