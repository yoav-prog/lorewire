// Server-and-client safe schema for stories.short_config.
//
// Parallel to lib/video-config.ts for the article-shorts pipeline. Same
// "manual parser, no Zod" idiom — keeps the type and the parser in
// lock-step so a refactor to one breaks the other at compile time, and
// avoids a Zod runtime in the admin client bundle.
//
// MUST stay in sync with the DoodleShort composition's expected inputs in
// `video/src/DoodleShort.tsx`. We duplicate rather than cross-import
// because /video/src/ pulls in Remotion modules we do NOT want Next
// bundling into the admin client. The single-schema rule from the editor
// plan is enforced by a parity test (added in Phase 2 when the renderer
// starts reading from this schema directly).
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import type { StoryRow } from "@/lib/repo";

export const CURRENT_SHORT_CONFIG_VERSION = 1;

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface ShortFrame {
  /** Stable id (e.g. "frame-00"). Survives regens, prompt edits, and
   *  reorders so queue rows keyed by frame_id stay valid. */
  id: string;
  url: string;
  caption_chunk_start_index: number;
  /** Editable prompt the per-scene regen action feeds to kie gpt-image-2-i2i.
   *  Optional because the original generation may not have persisted
   *  individual scene prompts; the editor seeds it from a sensible default
   *  on first edit. */
  image_prompt?: string;
  /** Optional alt text (will be carried into a swap-to-article-gallery if
   *  the user later promotes this frame). */
  alt?: string;
  /** True when the admin has manually swapped this frame's image (per-scene
   *  regen, upload, or pull from another short). A full Regenerate of the
   *  short MUST preserve pinned frames so the admin's work isn't blown
   *  away. Phase 1's regenerate path checks this flag before overwriting. */
  is_pinned?: boolean;
  /** Single-step Revert snapshot. The per-scene regen action writes the
   *  prior url + prompt here so the admin can undo without another model
   *  call. Mirrors video-config's PrevImage. */
  prev_image?: {
    url: string;
    image_prompt?: string;
    replaced_at: string; // ISO-8601
  };
}

export interface ShortCaptionChunk {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ShortVoiceOverride {
  provider: string;
  voice_id: string;
}

export type ShortLockMap = Record<string, true>;

export interface ShortEditSession {
  user_id: string;
  started_at: string;
  heartbeat_at: string;
}

/** Per-field caption style overrides. Mirrors caption-style.ts's
 *  CAPTION_STYLE_FIELDS at the value level (always stored as strings;
 *  the renderer parses them into the typed CaptionStyleProps shape).
 *  Sparse — only the fields the admin actually changed live here; the
 *  rest fall back through the global resolver chain. Editor tab:
 *  CaptionStyleTab. */
export interface ShortCaptionStyleOverride {
  position_y?: string;
  size_scale?: string;
  padding_x?: string;
  text_transform?: string;
  font_weight?: string;
  letter_spacing?: string;
  line_height?: string;
  color?: string;
  active_word_color?: string;
  spoken_word_color?: string;
  outline_color?: string;
  outline_width?: string;
  entry_effect?: string;
  word_highlight?: string;
}

export interface ShortConfig {
  config_version?: number;
  /** Which short_renders row this config was seeded from. The render plan
   *  helper (Phase 4) diffs the current config against this baseline to
   *  pick lane A / B / C. */
  source_render_id?: string;
  /** Per-short intro/outro override. Resolution chain (consumed by
   *  lib/short-segments.ts) is:
   *    1. short_config.skip_intro / skip_outro truthy -> hard skip
   *    2. short_config.intro_segment_id / outro_segment_id set -> pin
   *    3. story.skip_intro / skip_outro / pin / global active (existing)
   *  Lets the admin pick a different 9:16 intro for THIS short without
   *  touching the per-story columns the long-form video also uses. */
  intro_segment_id?: string;
  outro_segment_id?: string;
  skip_intro?: boolean;
  skip_outro?: boolean;
  /** Provenance — the original creation options. Preserved so a Restart
   *  with the same vibe + length can use them as the default. */
  narration_style?: string;
  length_preset?: string;
  /** Editable narration script. Phase 3's "Re-narrate from script"
   *  button feeds this to the voice synthesis path. */
  script?: string;
  /** Total render duration in ms. Used by the assembly + caption editor. */
  duration_ms?: number;
  /** The character base image URL kept around so per-scene regen has the
   *  same i2i input the original generation used. */
  character_base_url?: string;
  /** Scene frames with editable prompts + alt + is_pinned. */
  doodle_frames: ShortFrame[];
  /** Caption chunks (Phase 2's per-chunk editor binds here). */
  captions: ShortCaptionChunk[];
  /** Per-short voice override; null means "use the global default."
   *  Phase 3's VoicePicker binds here. */
  voice?: ShortVoiceOverride;
  /** Voiceover MP3 URL. Persisted so a captions-only edit (Lane A) can
   *  re-render the assembly without re-synthesizing audio. */
  voiceover_url?: string;
  /** Per-story caption style overrides. The Caption style tab patches into
   *  this with `caption_style.<field>` paths. The preview composition reads
   *  it (parsed into CaptionStyleProps) so edits show live; the render path
   *  picks it up on the next Lane A/B/C run. */
  caption_style?: ShortCaptionStyleOverride;
  _locks?: ShortLockMap;
  _edit_session?: ShortEditSession;
  /** Resolved intro/outro segment ids the LAST successful render spliced.
   *  Used by lib/short-render-plan to detect "intro or outro override
   *  changed since last render" → Lane A trigger. Stamped by
   *  api/render_short after finishShortRender returns; null entries
   *  mean "no segment spliced" (skip flag or missing). The leading
   *  underscore mirrors _locks / _edit_session — internal bookkeeping
   *  the editor doesn't write directly. */
  _last_rendered_segments?: {
    intro_segment_id: string | null;
    outro_segment_id: string | null;
  };
}

// ─── Parse + validate ─────────────────────────────────────────────────────────

export interface ShortParseOk {
  ok: true;
  config: ShortConfig;
}
export interface ShortParseErr {
  ok: false;
  error: string;
}
export type ShortParseResult = ShortParseOk | ShortParseErr;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function err(message: string): ShortParseErr {
  return { ok: false, error: message };
}

function readOptString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readOptNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseFrame(raw: unknown, idx: number): ShortFrame | string {
  if (!isObject(raw)) return `doodle_frames[${idx}]: expected object`;
  const id = raw.id;
  const url = raw.url;
  if (typeof id !== "string") return `doodle_frames[${idx}].id: expected string`;
  if (typeof url !== "string") return `doodle_frames[${idx}].url: expected string`;
  const ccsi = raw.caption_chunk_start_index;
  const frame: ShortFrame = {
    id,
    url,
    caption_chunk_start_index:
      typeof ccsi === "number" && Number.isFinite(ccsi) ? ccsi : 0,
  };
  if (typeof raw.image_prompt === "string") frame.image_prompt = raw.image_prompt;
  if (typeof raw.alt === "string") frame.alt = raw.alt;
  if (typeof raw.is_pinned === "boolean") frame.is_pinned = raw.is_pinned;
  const prev = raw.prev_image;
  if (
    isObject(prev) &&
    typeof prev.url === "string" &&
    typeof prev.replaced_at === "string"
  ) {
    frame.prev_image = {
      url: prev.url,
      replaced_at: prev.replaced_at,
      ...(typeof prev.image_prompt === "string"
        ? { image_prompt: prev.image_prompt }
        : {}),
    };
  }
  return frame;
}

function parseCaption(raw: unknown, idx: number): ShortCaptionChunk | string {
  if (!isObject(raw)) return `captions[${idx}]: expected object`;
  const start = raw.start_ms;
  const end = raw.end_ms;
  const text = raw.text;
  if (typeof start !== "number") return `captions[${idx}].start_ms: expected number`;
  if (typeof end !== "number") return `captions[${idx}].end_ms: expected number`;
  if (typeof text !== "string") return `captions[${idx}].text: expected string`;
  if (end < start) return `captions[${idx}]: end_ms < start_ms`;
  return { start_ms: start, end_ms: end, text };
}

// Strict validator: returns a typed config or a path-prefixed error message.
// Unknown top-level fields are silently dropped so the schema can grow
// without coordinated deploys (matches video-config.ts).
export function parseShortConfig(raw: unknown): ShortParseResult {
  if (!isObject(raw)) return err("root: expected object");

  const framesRaw = raw.doodle_frames;
  const frames: ShortFrame[] = [];
  if (Array.isArray(framesRaw)) {
    for (let i = 0; i < framesRaw.length; i++) {
      const parsed = parseFrame(framesRaw[i], i);
      if (typeof parsed === "string") return err(parsed);
      frames.push(parsed);
    }
  }

  const captionsRaw = raw.captions;
  const captions: ShortCaptionChunk[] = [];
  if (Array.isArray(captionsRaw)) {
    for (let i = 0; i < captionsRaw.length; i++) {
      const parsed = parseCaption(captionsRaw[i], i);
      if (typeof parsed === "string") return err(parsed);
      captions.push(parsed);
    }
  }

  const config: ShortConfig = {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    doodle_frames: frames,
    captions,
  };

  const sourceRenderId = readOptString(raw, "source_render_id");
  if (sourceRenderId !== undefined) config.source_render_id = sourceRenderId;
  const narrationStyle = readOptString(raw, "narration_style");
  if (narrationStyle !== undefined) config.narration_style = narrationStyle;
  const lengthPreset = readOptString(raw, "length_preset");
  if (lengthPreset !== undefined) config.length_preset = lengthPreset;
  const script = readOptString(raw, "script");
  if (script !== undefined) config.script = script;
  const characterBaseUrl = readOptString(raw, "character_base_url");
  if (characterBaseUrl !== undefined) config.character_base_url = characterBaseUrl;
  const voiceoverUrl = readOptString(raw, "voiceover_url");
  if (voiceoverUrl !== undefined) config.voiceover_url = voiceoverUrl;
  const durationMs = readOptNumber(raw, "duration_ms");
  if (durationMs !== undefined && durationMs >= 0) config.duration_ms = durationMs;

  const voice = raw.voice;
  if (
    isObject(voice) &&
    typeof voice.provider === "string" &&
    typeof voice.voice_id === "string"
  ) {
    config.voice = { provider: voice.provider, voice_id: voice.voice_id };
  }

  // Per-short segment overrides. Mirror parseShortConfig's contract: any
  // unknown shape is silently dropped so a malformed override can't
  // corrupt the config column. The patch layer below validates input
  // before write; this is the load-side guard.
  const introId = readOptString(raw, "intro_segment_id");
  if (introId) config.intro_segment_id = introId;
  const outroId = readOptString(raw, "outro_segment_id");
  if (outroId) config.outro_segment_id = outroId;
  if (raw.skip_intro === true) config.skip_intro = true;
  if (raw.skip_outro === true) config.skip_outro = true;

  const locks = raw._locks;
  if (isObject(locks)) {
    const lockMap: ShortLockMap = {};
    for (const k of Object.keys(locks)) {
      if (locks[k] === true) lockMap[k] = true;
    }
    config._locks = lockMap;
  }

  const editSession = raw._edit_session;
  if (
    isObject(editSession) &&
    typeof editSession.user_id === "string" &&
    typeof editSession.started_at === "string" &&
    typeof editSession.heartbeat_at === "string"
  ) {
    config._edit_session = {
      user_id: editSession.user_id,
      started_at: editSession.started_at,
      heartbeat_at: editSession.heartbeat_at,
    };
  }

  const lastSegments = raw._last_rendered_segments;
  if (isObject(lastSegments)) {
    const intro =
      typeof lastSegments.intro_segment_id === "string"
        ? lastSegments.intro_segment_id
        : null;
    const outro =
      typeof lastSegments.outro_segment_id === "string"
        ? lastSegments.outro_segment_id
        : null;
    config._last_rendered_segments = {
      intro_segment_id: intro,
      outro_segment_id: outro,
    };
  }

  const captionStyle = raw.caption_style;
  if (isObject(captionStyle)) {
    const override: ShortCaptionStyleOverride = {};
    for (const field of CAPTION_STYLE_FIELDS) {
      const v = captionStyle[field];
      if (typeof v === "string") {
        (override as Record<string, string>)[field] = v;
      }
    }
    // Only attach when at least one field is set so a stray empty
    // {} doesn't survive a round-trip and clutter the column.
    if (Object.keys(override).length > 0) {
      config.caption_style = override;
    }
  }

  return { ok: true, config };
}

// Mirror of CAPTION_STYLE_FIELDS in lib/caption-style.ts. Hardcoded here so
// this module stays importable from client components — the source-of-truth
// list lives in caption-style.ts behind a `server-only` boundary. Keep the
// two lists in sync (a unit test below pins this).
const CAPTION_STYLE_FIELDS = [
  "position_y",
  "size_scale",
  "padding_x",
  "text_transform",
  "font_weight",
  "letter_spacing",
  "line_height",
  "color",
  "active_word_color",
  "spoken_word_color",
  "outline_color",
  "outline_width",
  "entry_effect",
  "word_highlight",
] as const;
export type ShortCaptionStyleField = (typeof CAPTION_STYLE_FIELDS)[number];
export const SHORT_CAPTION_STYLE_FIELDS: ReadonlyArray<ShortCaptionStyleField> =
  CAPTION_STYLE_FIELDS;

// Seed a fresh ShortConfig from a successful short_renders row's props blob.
// The props column carries the DoodleShort composition props the renderer
// consumed; we lift the editable parts out + carry provenance fields so a
// future render-plan diff has a baseline to compare against.
//
// Returns null when props is missing / unparseable / has no frames; the
// editor page renders "no short generated yet" in that case rather than an
// empty form.
export function defaultShortConfig(
  story: Pick<StoryRow, "id">,
  shortRender: {
    id: string;
    narration_style: string | null;
    length_preset: string | null;
    props: string | null;
  } | null,
): ShortConfig | null {
  if (!shortRender || !shortRender.props) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(shortRender.props);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const rawFrames = parsed.doodle_frames;
  if (!Array.isArray(rawFrames) || rawFrames.length === 0) return null;

  // The props column from the generation drain may not carry image_prompt
  // per frame today — Phase 3 of shorts.py captures it; older rows don't.
  // We accept either shape; the editor seeds image_prompt on first edit.
  const config: ShortConfig = {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    source_render_id: shortRender.id,
    narration_style: shortRender.narration_style ?? undefined,
    length_preset: shortRender.length_preset ?? undefined,
    doodle_frames: rawFrames.flatMap((raw, idx) => {
      const parsed = parseFrame(raw, idx);
      return typeof parsed === "string" ? [] : [parsed];
    }),
    captions: Array.isArray(parsed.captions)
      ? parsed.captions.flatMap((raw, idx) => {
          const p = parseCaption(raw, idx);
          return typeof p === "string" ? [] : [p];
        })
      : [],
  };

  if (typeof parsed.character_base_url === "string") {
    config.character_base_url = parsed.character_base_url;
  } else if (typeof parsed.character_image === "string") {
    // Legacy field name the older generations used.
    config.character_base_url = parsed.character_image;
  }
  if (typeof parsed.voiceover_url === "string") {
    config.voiceover_url = parsed.voiceover_url;
  }
  if (typeof parsed.duration_ms === "number") {
    config.duration_ms = parsed.duration_ms;
  }
  if (typeof parsed.script === "string") {
    config.script = parsed.script;
  }
  return config;
}

// Apply a partial patch to a config, returning a new config (immutable).
// Mirrors lib/video-config.ts:applyConfigPatch — same shape, narrower set
// of editable paths. Supports dotted paths into doodle_frames (Phase 1
// Scenes tab) and into captions (Phase 2 Captions tab), plus the
// top-level scalars later tabs will edit.
//
// Unsupported paths are silently dropped so a client editing on an older
// build can't corrupt the column with junk; the action that calls this
// does the auth + final parseShortConfig validation.
export function applyShortConfigPatch(
  base: ShortConfig,
  patch: Record<string, unknown>,
): ShortConfig {
  let next: ShortConfig = {
    ...base,
    doodle_frames: [...base.doodle_frames],
    captions: [...base.captions],
  };
  for (const [path, value] of Object.entries(patch)) {
    next = applyOnePath(next, path, value);
  }
  return next;
}

function applyOnePath(
  cfg: ShortConfig,
  path: string,
  value: unknown,
): ShortConfig {
  // Top-level scalars the editor writes.
  if (path === "script" && (typeof value === "string" || value === null)) {
    return { ...cfg, script: typeof value === "string" ? value : undefined };
  }
  // Per-short segment override: null clears the override (falls through
  // to the per-story / global chain), a non-empty string pins a segment
  // id. Empty string is treated as a clear so the picker can wire a
  // single setter for both "inherit" and "pin specific".
  if (path === "intro_segment_id") {
    const next = { ...cfg };
    if (value === null || value === "") delete next.intro_segment_id;
    else if (typeof value === "string") next.intro_segment_id = value;
    else return cfg;
    return next;
  }
  if (path === "outro_segment_id") {
    const next = { ...cfg };
    if (value === null || value === "") delete next.outro_segment_id;
    else if (typeof value === "string") next.outro_segment_id = value;
    else return cfg;
    return next;
  }
  // Boolean flags: true sets the hard skip, false (or null) clears it.
  if (path === "skip_intro") {
    const next = { ...cfg };
    if (value === true) next.skip_intro = true;
    else if (value === false || value === null) delete next.skip_intro;
    else return cfg;
    return next;
  }
  if (path === "skip_outro") {
    const next = { ...cfg };
    if (value === true) next.skip_outro = true;
    else if (value === false || value === null) delete next.skip_outro;
    else return cfg;
    return next;
  }
  if (path === "voice") {
    if (value === null) {
      const next = { ...cfg };
      delete next.voice;
      return next;
    }
    if (
      isObject(value) &&
      typeof value.provider === "string" &&
      typeof value.voice_id === "string"
    ) {
      return {
        ...cfg,
        voice: { provider: value.provider, voice_id: value.voice_id },
      };
    }
    return cfg;
  }

  // Frame patches: `doodle_frames.<id>.<field>`.
  const frameMatch = /^doodle_frames\.([^.]+)\.([^.]+)$/.exec(path);
  if (frameMatch) {
    const frameId = frameMatch[1];
    const field = frameMatch[2];
    const frames = cfg.doodle_frames.map((f) => {
      if (f.id !== frameId) return f;
      if (field === "image_prompt" && typeof value === "string") {
        return { ...f, image_prompt: value };
      }
      if (field === "alt" && typeof value === "string") {
        return { ...f, alt: value };
      }
      if (field === "is_pinned" && typeof value === "boolean") {
        return { ...f, is_pinned: value };
      }
      return f;
    });
    return { ...cfg, doodle_frames: frames };
  }

  // Caption style overrides: `caption_style.<field>`. Values are stored as
  // strings (mirrors the resolver's string-in/typed-out flow). Patching
  // with null (or empty string) drops the override so the field falls back
  // through the global resolver chain.
  const styleMatch = /^caption_style\.([^.]+)$/.exec(path);
  if (styleMatch) {
    const field = styleMatch[1] as ShortCaptionStyleField;
    if (!CAPTION_STYLE_FIELDS.includes(field)) return cfg;
    const current = { ...(cfg.caption_style ?? {}) };
    if (value === null || value === "") {
      delete (current as Record<string, string>)[field];
    } else if (typeof value === "string") {
      (current as Record<string, string>)[field] = value;
    } else {
      return cfg;
    }
    const next = { ...cfg };
    if (Object.keys(current).length === 0) {
      delete next.caption_style;
    } else {
      next.caption_style = current;
    }
    return next;
  }

  // Caption patches: `captions.<idx>.<field>`. Captions don't have stable
  // ids — they're indexed by position so the editor's chunk inputs can
  // address each one. Out-of-range indices and invalid timing pairs are
  // silently dropped; the final parseShortConfig in the action layer
  // catches anything that would produce an unparseable config.
  const captionMatch = /^captions\.(\d+)\.([^.]+)$/.exec(path);
  if (captionMatch) {
    const idx = Number(captionMatch[1]);
    const field = captionMatch[2];
    if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.captions.length) {
      return cfg;
    }
    const captions = cfg.captions.map((c, i) => {
      if (i !== idx) return c;
      if (field === "text" && typeof value === "string") {
        return { ...c, text: value };
      }
      if (
        field === "start_ms" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= c.end_ms
      ) {
        return { ...c, start_ms: value };
      }
      if (
        field === "end_ms" &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= c.start_ms
      ) {
        return { ...c, end_ms: value };
      }
      return c;
    });
    return { ...cfg, captions };
  }

  return cfg;
}
