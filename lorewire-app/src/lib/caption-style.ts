// Per-story caption style resolution.
//
// The caption template lives in settings_kv at four tiers:
//   caption.story.<story_id>.<bare>    per-story override (highest priority)
//   caption.cat.<category>.<bare>       per-category override
//   caption.<bare>                      global value
//   DEFAULTS[<bare>]                    bake-the-bin floor
//
// Phase 5 of _plans/2026-06-12-video-aspect-ratio.md adds an aspect
// dimension on top of every tier so the admin can tune a 16:9-specific
// caption position without disturbing the 9:16 default. When an aspect
// is supplied to resolveCaptionStyle, each tier first looks for its
// aspect-specific subkey then falls back to the aspect-agnostic key at
// the same tier:
//
//   caption.story.<id>.<aspect>.<bare>  per-story per-aspect (highest)
//   caption.story.<id>.<bare>           per-story aspect-agnostic
//   caption.cat.<cat>.<aspect>.<bare>   per-category per-aspect
//   caption.cat.<cat>.<bare>            per-category aspect-agnostic
//   caption.<aspect>.<bare>             global per-aspect
//   caption.<bare>                      global aspect-agnostic
//   DEFAULTS[<bare>]                    floor
//
// When `aspect` is undefined the resolver walks the pre-Phase-5 four-tier
// chain unchanged so every existing call site stays byte-identical.
//
// resolveCaptionStyle walks the chain and returns:
//   - effective: the value the renderer should use
//   - source: which tier it came from (so the UI can show "inherited from global")
//   - storyOverride: the raw per-story value (so the UI can render it in the input)
//
// All values are stored as strings (settings_kv is a TEXT column); the
// renderer-side coercion to number / hex happens at the call site so the
// resolver stays string-clean.

import "server-only";
import { getSetting } from "@/lib/repo";
import { type VideoAspect } from "@/lib/aspect";

/** Settings-key segment for an aspect. Colons aren't safe inside the
 *  dotted key namespace, so 16:9 / 9:16 become 16x9 / 9x16. */
export function captionAspectSegment(aspect: VideoAspect): string {
  return aspect === "16:9" ? "16x9" : "9x16";
}

export const CAPTION_STYLE_FIELDS = [
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

export type CaptionStyleField = (typeof CAPTION_STYLE_FIELDS)[number];

// Floor values used when no admin override exists at any tier. These mirror
// the constants in src/app/admin/(panel)/templates/page.tsx — keep them in
// sync. The Remotion composition reads `effective` for each field; a fresh
// install renders with these and nothing else.
export const CAPTION_DEFAULTS: Record<CaptionStyleField, string> = {
  position_y: "0.55",
  size_scale: "1",
  padding_x: "64",
  text_transform: "uppercase",
  letter_spacing: "-0.5",
  line_height: "1.05",
  font_weight: "900",
  color: "#facc15",
  outline_color: "#0f172a",
  outline_width: "6",
  active_word_color: "#ffffff",
  spoken_word_color: "rgba(250, 204, 21, 0.45)",
  entry_effect: "fade",
  word_highlight: "karaoke",
};

export type CaptionStyleSource =
  | "story"
  | "story-aspect"
  | "category"
  | "category-aspect"
  | "global"
  | "global-aspect"
  | "default";

export interface ResolvedCaptionField {
  /** The value the renderer should use. */
  effective: string;
  /** Which tier the effective value came from. */
  source: CaptionStyleSource;
  /** Per-story explicit override; null when none set. */
  storyOverride: string | null;
  /** What the field would inherit if storyOverride were cleared (cat → global → default). */
  inheritedFromParent: string;
}

export interface ResolvedCaptionStyle {
  fields: Record<CaptionStyleField, ResolvedCaptionField>;
}

export async function resolveCaptionStyle(opts: {
  storyId: string;
  category: string | null;
  /** Optional aspect — when supplied, the resolver walks per-aspect tiers
   *  in front of the aspect-agnostic tiers. When undefined, the resolver
   *  is byte-identical to the pre-Phase-5 four-tier chain. */
  aspect?: VideoAspect;
}): Promise<ResolvedCaptionStyle> {
  const { storyId, category, aspect } = opts;
  const aspectSeg = aspect ? captionAspectSegment(aspect) : null;
  const fields = {} as Record<CaptionStyleField, ResolvedCaptionField>;

  async function readTrimmed(key: string): Promise<string | null> {
    const raw = await getSetting(key);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }

  await Promise.all(
    CAPTION_STYLE_FIELDS.map(async (bare) => {
      // Pull every candidate at the same time so the network round-trips
      // overlap. Each await is at most one settings_kv lookup so the
      // worst-case cost is O(tiers) per field, parallel across fields.
      const [
        storyAspectVal,
        storyVal,
        catAspectVal,
        catVal,
        globalAspectVal,
        globalVal,
      ] = await Promise.all([
        aspectSeg
          ? readTrimmed(`caption.story.${storyId}.${aspectSeg}.${bare}`)
          : Promise.resolve(null),
        readTrimmed(`caption.story.${storyId}.${bare}`),
        category && aspectSeg
          ? readTrimmed(`caption.cat.${category}.${aspectSeg}.${bare}`)
          : Promise.resolve(null),
        category
          ? readTrimmed(`caption.cat.${category}.${bare}`)
          : Promise.resolve(null),
        aspectSeg ? readTrimmed(`caption.${aspectSeg}.${bare}`) : Promise.resolve(null),
        readTrimmed(`caption.${bare}`),
      ]);

      // Inherited-from-parent: what the field would become if the story
      // override (either tier) were cleared. UI uses this for the
      // placeholder text on the story-scope form.
      const inheritedFromParent =
        catAspectVal ??
        catVal ??
        globalAspectVal ??
        globalVal ??
        CAPTION_DEFAULTS[bare];

      // Effective: the value the renderer reads, picked in priority
      // order story-aspect -> story -> cat-aspect -> cat -> global-aspect
      // -> global -> default.
      let effective: string;
      let source: CaptionStyleSource;
      if (storyAspectVal !== null) {
        effective = storyAspectVal;
        source = "story-aspect";
      } else if (storyVal !== null) {
        effective = storyVal;
        source = "story";
      } else if (catAspectVal !== null) {
        effective = catAspectVal;
        source = "category-aspect";
      } else if (catVal !== null) {
        effective = catVal;
        source = "category";
      } else if (globalAspectVal !== null) {
        effective = globalAspectVal;
        source = "global-aspect";
      } else if (globalVal !== null) {
        effective = globalVal;
        source = "global";
      } else {
        effective = CAPTION_DEFAULTS[bare];
        source = "default";
      }

      // storyOverride still surfaces either tier-aspect or tier-agnostic
      // so the editor's input picks up whatever the admin wrote.
      const storyOverride = storyAspectVal ?? storyVal ?? null;

      fields[bare] = {
        effective,
        source,
        storyOverride,
        inheritedFromParent,
      };
    }),
  );
  return { fields };
}

// Browser-safe view of the resolved style. Used by the live preview to apply
// the values inside the Remotion composition. All numeric fields come through
// as `number`, color fields stay as `string` for direct CSS use.

export interface CaptionStyleForPreview {
  position_y: number;
  size_scale: number;
  padding_x: number;
  text_transform: "uppercase" | "none" | "lowercase";
  font_weight: number;
  letter_spacing: number;
  line_height: number;
  color: string;
  active_word_color: string;
  spoken_word_color: string;
  outline_color: string;
  outline_width: number;
  entry_effect: "none" | "fade" | "pop" | "slide-up";
  word_highlight: "none" | "karaoke" | "color" | "scale" | "background";
}

const TEXT_TRANSFORMS = new Set(["uppercase", "none", "lowercase"] as const);
const ENTRY_EFFECTS = new Set(["none", "fade", "pop", "slide-up"] as const);
const WORD_HIGHLIGHTS = new Set([
  "none",
  "karaoke",
  "color",
  "scale",
  "background",
] as const);

export function toPreview(
  style: ResolvedCaptionStyle,
): CaptionStyleForPreview {
  const num = (bare: CaptionStyleField, fallback: number): number => {
    const raw = style.fields[bare].effective;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const oneOf = <T extends string>(
    bare: CaptionStyleField,
    allowed: Set<T>,
    fallback: T,
  ): T => {
    const raw = style.fields[bare].effective;
    return (allowed as Set<string>).has(raw) ? (raw as T) : fallback;
  };
  return {
    position_y: num("position_y", 0.55),
    size_scale: num("size_scale", 1),
    padding_x: num("padding_x", 64),
    text_transform: oneOf("text_transform", TEXT_TRANSFORMS, "uppercase"),
    font_weight: num("font_weight", 900),
    letter_spacing: num("letter_spacing", -0.5),
    line_height: num("line_height", 1.05),
    color: style.fields.color.effective,
    active_word_color: style.fields.active_word_color.effective,
    spoken_word_color: style.fields.spoken_word_color.effective,
    outline_color: style.fields.outline_color.effective,
    outline_width: num("outline_width", 6),
    entry_effect: oneOf("entry_effect", ENTRY_EFFECTS, "fade"),
    word_highlight: oneOf("word_highlight", WORD_HIGHLIGHTS, "karaoke"),
  };
}
