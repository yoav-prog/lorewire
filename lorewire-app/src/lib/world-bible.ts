// TS mirror of `pipeline/world_bible.py` — types + a defensive
// parser/reader for the world bible stored under
// `stories.pipeline_cache.world_bible` (moved off video_config
// 2026-06-14 — see `_plans/2026-06-14-pipeline-cache-column.md`).
//
// MUST stay in sync with the Python side. The admin's bible panel
// reads through this module; the worker writes through the Python
// module. A parity test pins the shape so a Python-side change that
// breaks the TS reader fails CI loudly.
//
// Pure module — no I/O, no React, safe to import on the server side.

/** Cache shape marker. Stories with a different marker are treated
 *  as missing so a stale snapshot doesn't render in the inspector. */
export const WORLD_BIBLE_BUILT_WITH = "world_bible_v1";

/** Caps mirror the Python side. The bible panel can use these to
 *  show "X/4 characters slots used" without re-parsing magic numbers. */
export const MAX_CHARACTERS = 4;
export const MAX_SUB_CHARACTERS = 4;
export const MAX_LOCATIONS = 3;
export const MAX_ITEMS = 5;

export type CharacterRole = "lead" | "supporting" | "background";

export interface BibleCharacter {
  /** `char_<sha1[:8]>` for main characters, `sub_<sha1[:8]>` for
   *  sub-characters. Stable across rebuilds (name-derived). */
  id: string;
  name: string;
  role: CharacterRole;
  /** Compact prose: hair, build, clothing, accessories — restated
   *  verbatim in every scene prompt that includes this character. */
  visual_cues: string;
  /** Canonical headshot URL, used as kie image_input. `null` when
   *  ref-gen hasn't run yet OR failed (scene gen falls back to text). */
  reference_image_url: string | null;
}

export interface BibleLocation {
  id: string;
  name: string;
  visual_cues: string;
  reference_image_url: string | null;
}

export interface BibleItem {
  id: string;
  name: string;
  visual_cues: string;
}

export interface WorldBible {
  built_with: typeof WORLD_BIBLE_BUILT_WITH;
  characters: BibleCharacter[];
  sub_characters: BibleCharacter[];
  locations: BibleLocation[];
  items: BibleItem[];
}

const VALID_ROLES: readonly CharacterRole[] = ["lead", "supporting", "background"];

function readString(raw: unknown, fallback = ""): string {
  if (typeof raw === "string") return raw;
  return fallback;
}

function readRole(raw: unknown, fallback: CharacterRole): CharacterRole {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase().trim();
    for (const r of VALID_ROLES) {
      if (lower === r) return r;
    }
  }
  return fallback;
}

function readRefUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCharacter(raw: unknown, defaultRole: CharacterRole): BibleCharacter | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readString(o.id).trim();
  const name = readString(o.name).trim();
  const cues = readString(o.visual_cues).trim();
  if (!id || !name || !cues) return null;
  return {
    id,
    name,
    role: readRole(o.role, defaultRole),
    visual_cues: cues,
    reference_image_url: readRefUrl(o.reference_image_url),
  };
}

function parseLocation(raw: unknown): BibleLocation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readString(o.id).trim();
  const name = readString(o.name).trim();
  const cues = readString(o.visual_cues).trim();
  if (!id || !name || !cues) return null;
  return {
    id,
    name,
    visual_cues: cues,
    reference_image_url: readRefUrl(o.reference_image_url),
  };
}

function parseItem(raw: unknown): BibleItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readString(o.id).trim();
  const name = readString(o.name).trim();
  const cues = readString(o.visual_cues).trim();
  if (!id || !name || !cues) return null;
  return { id, name, visual_cues: cues };
}

/**
 * Coerce an unknown blob (from `JSON.parse(story.video_config)`) into
 * a typed `WorldBible`. Returns `null` on missing field, wrong marker,
 * or non-object input. Individual entity lists are independently
 * tolerant — a malformed locations array does NOT invalidate the
 * whole bible.
 */
export function parseWorldBible(raw: unknown): WorldBible | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.built_with !== WORLD_BIBLE_BUILT_WITH) return null;

  const characters: BibleCharacter[] = [];
  if (Array.isArray(o.characters)) {
    for (const entry of o.characters) {
      const parsed = parseCharacter(entry, "supporting");
      if (parsed) characters.push(parsed);
      if (characters.length >= MAX_CHARACTERS) break;
    }
  }

  const sub_characters: BibleCharacter[] = [];
  if (Array.isArray(o.sub_characters)) {
    for (const entry of o.sub_characters) {
      const parsed = parseCharacter(entry, "background");
      if (parsed) sub_characters.push(parsed);
      if (sub_characters.length >= MAX_SUB_CHARACTERS) break;
    }
  }

  const locations: BibleLocation[] = [];
  if (Array.isArray(o.locations)) {
    for (const entry of o.locations) {
      const parsed = parseLocation(entry);
      if (parsed) locations.push(parsed);
      if (locations.length >= MAX_LOCATIONS) break;
    }
  }

  const items: BibleItem[] = [];
  if (Array.isArray(o.items)) {
    for (const entry of o.items) {
      const parsed = parseItem(entry);
      if (parsed) items.push(parsed);
      if (items.length >= MAX_ITEMS) break;
    }
  }

  return {
    built_with: WORLD_BIBLE_BUILT_WITH,
    characters,
    sub_characters,
    locations,
    items,
  };
}

/**
 * Read the world bible from a `stories.pipeline_cache` JSON string.
 * Callers that want to handle the 2026-06-14 transition can pass
 * `stories.pipeline_cache ?? stories.video_config` so a story
 * persisted before the migration still surfaces its bible in the
 * inspector until the next pipeline write moves the cache to the
 * new column. The field shape inside both columns is identical
 * (`{ world_bible: {...} }`), so one reader covers both.
 */
export function readWorldBible(
  cacheJson: string | null | undefined,
): WorldBible | null {
  if (!cacheJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cacheJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const bible = (parsed as { world_bible?: unknown }).world_bible;
  return parseWorldBible(bible);
}

/** Look up the lead character. Falls back to the first character when
 *  none marked. Returns `null` when the bible has no characters. */
export function leadCharacter(bible: WorldBible | null): BibleCharacter | null {
  if (!bible || bible.characters.length === 0) return null;
  for (const c of bible.characters) {
    if (c.role === "lead") return c;
  }
  return bible.characters[0];
}
