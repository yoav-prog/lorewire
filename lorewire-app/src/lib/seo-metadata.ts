// LLM-generated per-platform SEO metadata for shorts. Plan:
// _plans/2026-06-24-llm-seo-metadata.md.
//
// One LLM call per story produces all four platforms' metadata
// (YouTube title/description/tags, TikTok caption, Facebook caption,
// Instagram caption). Persisted on stories.seo_metadata_json.
//
// The publishers (publish-to-{facebook,instagram,youtube,tiktok}.ts)
// prefer this metadata over their template defaults when it's
// present and well-formed. If it's missing, malformed, or stale,
// they fall through to the existing template (Phase 1 behavior).
// Backwards compatible — never blocks publishing.
//
// Model: kie/gemini-3-5-flash via lib/llm.ts (OpenAI-compatible chat
// completions with strict structured output via response_format =
// json_schema). Settings key `publisher.seo.kie_model` lets admin
// swap the model without code change.
//
// Best-effort: any failure here (LLM down, malformed output, network
// error) logs + returns; the caller continues with templates. The
// publish path never crashes because of an SEO metadata hiccup.

import "server-only";

import { z } from "zod";
import { all, one, run } from "@/lib/db";
import { chatCompletion, type ChatMessage } from "@/lib/llm";
import { getSetting } from "@/lib/repo";

// --- Types + Zod schema (runtime validation of the LLM output) ------------

export const YouTubeMetadataSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(5000),
  tags: z.array(z.string().min(1)).min(3).max(12),
});

export const TikTokMetadataSchema = z.object({
  // Includes inline hashtags. Hard-capped at 2200 by TikTok.
  caption: z.string().min(1).max(2200),
});

export const FacebookMetadataSchema = z.object({
  caption: z.string().min(1).max(63206),
});

export const InstagramMetadataSchema = z.object({
  caption: z.string().min(1).max(2200),
});

export const SeoMetadataSchema = z.object({
  youtube: YouTubeMetadataSchema,
  tiktok: TikTokMetadataSchema,
  facebook: FacebookMetadataSchema,
  instagram: InstagramMetadataSchema,
});

export type YouTubeMetadata = z.infer<typeof YouTubeMetadataSchema>;
export type TikTokMetadata = z.infer<typeof TikTokMetadataSchema>;
export type FacebookMetadata = z.infer<typeof FacebookMetadataSchema>;
export type InstagramMetadata = z.infer<typeof InstagramMetadataSchema>;
export type SeoMetadata = z.infer<typeof SeoMetadataSchema>;

// --- Settings keys ---------------------------------------------------------

export const SETTING_AUTO_REGENERATE = "publisher.seo.auto_regenerate_on_render";
export const SETTING_KIE_MODEL = "publisher.seo.kie_model";
export const DEFAULT_MODEL = "kie/gemini-3-5-flash";

// --- Observability ---------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[seo_metadata ${event}]`, JSON.stringify(fields));
}

// --- Prompt builders -------------------------------------------------------

/** System prompt: per-platform SEO rules + brand voice. Stable across
 *  every call so the cache layer can detect prompt drift later if we
 *  ever introduce versioning. */
export function systemPrompt(): string {
  return `You write per-platform SEO metadata for short videos on LoreWire, a publisher of one-minute hand-drawn shorts about true internet stories. Your audience is people scrolling shorts on YouTube, TikTok, Instagram, and Facebook.

You will receive a short's title, category, and narration script (what viewers actually hear). Generate metadata for all four platforms. Make every field about THIS specific story — not generic boilerplate. Use specific nouns and concrete details from the narration. Hook the viewer in the first 50 characters of every caption.

Per-platform rules:

YouTube:
- title: 4-6 words ideally, max 100 chars. Focus keyword in the first 3 words. Clarity over cleverness. No clickbait.
- description: 150-200 words. First two sentences carry the SEO weight. Open by repeating the hook then expand. Include the article URL once. End with 3-5 inline hashtags (#Shorts plus niche tags).
- tags: 5-8 entries. Mix specific (the actual story noun phrases) and broad ("storytime", "reddit stories"). No hashtag prefix.

TikTok:
- caption: 150-300 characters sweet spot, max 2200. Front-load the hook in the first 50 chars. 3-5 inline hashtags. NEVER use #fyp or #foryou (saturated, zero signal). Use one broad niche tag, one mid-tier, one or two specific.

Facebook:
- caption: hook-first short paragraph. Include the article URL. No hashtags (Facebook ignores them).

Instagram:
- caption: hook-first. Up to 2200 chars but 150-300 is the sweet spot. 3-5 inline hashtags at the end.

Brand voice: curious, direct, story-first. Never sensational. Never "you won't believe what happened next" style. The story is interesting on its own; let it speak.

Return ONLY valid JSON matching the schema. No markdown fences, no commentary.`;
}

export function userPrompt(args: {
  title: string;
  category: string;
  teleprompter: string;
  articleUrl: string;
}): string {
  return [
    `Story title: ${args.title}`,
    `Category: ${args.category}`,
    `Article URL: ${args.articleUrl}`,
    ``,
    `Narration script (what viewers hear):`,
    `"""`,
    args.teleprompter,
    `"""`,
  ].join("\n");
}

/** JSON Schema mirroring the Zod shape — used for the strict
 *  structured-output mode in chatCompletion (response_format =
 *  json_schema). Kept in sync manually because zod-to-json-schema
 *  isn't installed and the shape is small. */
export const SEO_METADATA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["youtube", "tiktok", "facebook", "instagram"],
  properties: {
    youtube: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "tags"],
      properties: {
        title: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 5000 },
        tags: {
          type: "array",
          minItems: 3,
          maxItems: 12,
          items: { type: "string" },
        },
      },
    },
    tiktok: {
      type: "object",
      additionalProperties: false,
      required: ["caption"],
      properties: {
        caption: { type: "string", maxLength: 2200 },
      },
    },
    facebook: {
      type: "object",
      additionalProperties: false,
      required: ["caption"],
      properties: {
        caption: { type: "string" },
      },
    },
    instagram: {
      type: "object",
      additionalProperties: false,
      required: ["caption"],
      properties: {
        caption: { type: "string", maxLength: 2200 },
      },
    },
  },
} as const;

// --- Generation -----------------------------------------------------------

export interface GenerateArgs {
  storyId: string;
  title: string;
  category: string | null;
  teleprompter: string;
  articleUrl: string;
}

export type GenerateResult =
  | { ok: true; metadata: SeoMetadata; model: string }
  | { ok: false; error: string; stage: "settings" | "llm" | "parse" | "schema" };

/** Generate fresh SEO metadata for a story. Best-effort: returns
 *  `{ ok: false }` on any failure with a stage tag so the caller can
 *  decide what to do (typically: log and fall through to templates).
 *  Never throws. */
export async function generateSeoMetadata(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const t0 = Date.now();
  const model =
    (await getSetting(SETTING_KIE_MODEL))?.trim() || DEFAULT_MODEL;

  log("generate_start", {
    story_id: args.storyId,
    model,
    title_chars: args.title.length,
    teleprompter_chars: args.teleprompter.length,
    category: args.category ?? "(none)",
  });

  if (!args.teleprompter || args.teleprompter.trim().length < 20) {
    log("skip_short_input", {
      story_id: args.storyId,
      teleprompter_chars: args.teleprompter?.length ?? 0,
    });
    return {
      ok: false,
      error: "teleprompter too short to generate metadata",
      stage: "settings",
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content: userPrompt({
        title: args.title,
        category: args.category ?? "Stories",
        teleprompter: args.teleprompter,
        articleUrl: args.articleUrl,
      }),
    },
  ];

  const llmResult = await chatCompletion({
    modelId: model,
    messages,
    temperature: 0.7,
    jsonSchema: {
      name: "lorewire_seo_metadata",
      schema: SEO_METADATA_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  });

  if (!llmResult.ok) {
    log("kie_call_failed", {
      story_id: args.storyId,
      model,
      latency_ms: Date.now() - t0,
      error: llmResult.error.slice(0, 300),
    });
    return { ok: false, error: llmResult.error, stage: "llm" };
  }

  log("kie_call_ok", {
    story_id: args.storyId,
    model,
    latency_ms: Date.now() - t0,
    response_chars: llmResult.content.length,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    log("parse_failed", {
      story_id: args.storyId,
      raw_first_300: llmResult.content.slice(0, 300),
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: `LLM response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      stage: "parse",
    };
  }

  const validation = SeoMetadataSchema.safeParse(parsed);
  if (!validation.success) {
    log("validation_failed", {
      story_id: args.storyId,
      zod_errors_first_3: validation.error.issues
        .slice(0, 3)
        .map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
    });
    return {
      ok: false,
      error: `LLM output failed schema: ${validation.error.issues[0]?.message ?? "unknown"}`,
      stage: "schema",
    };
  }

  return { ok: true, metadata: validation.data, model };
}

// --- DB I/O ---------------------------------------------------------------

interface StorySeoRow {
  id: string;
  title: string | null;
  category: string | null;
  teleprompter: string | null;
  updated_at: string | null;
  seo_metadata_json: string | null;
  seo_metadata_generated_at: string | null;
}

export async function loadSeoMetadata(
  storyId: string,
): Promise<SeoMetadata | null> {
  const row = await one<{ seo_metadata_json: string | null }>(
    "SELECT seo_metadata_json FROM stories WHERE id = ?",
    [storyId],
  );
  if (!row?.seo_metadata_json) return null;
  try {
    const parsed = JSON.parse(row.seo_metadata_json);
    const v = SeoMetadataSchema.safeParse(parsed);
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

export async function saveSeoMetadata(
  storyId: string,
  metadata: SeoMetadata,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    `UPDATE stories
       SET seo_metadata_json = ?,
           seo_metadata_generated_at = ?
     WHERE id = ?`,
    [JSON.stringify(metadata), now, storyId],
  );
  log("save_ok", { story_id: storyId, generated_at: now });
}

/** Pure: should we regenerate? True when:
 *   - no metadata exists yet, OR
 *   - the story was updated AFTER the last metadata generation (the
 *     teleprompter was probably re-rendered).
 *  Both timestamps may be NULL on legacy rows; treat NULL generated_at
 *  as "needs regen", NULL updated_at as "freshness unknown, regen". */
export function isStale(
  generatedAt: string | null,
  storyUpdatedAt: string | null,
): boolean {
  if (!generatedAt) return true;
  if (!storyUpdatedAt) return true;
  const g = Date.parse(generatedAt);
  const u = Date.parse(storyUpdatedAt);
  if (!Number.isFinite(g) || !Number.isFinite(u)) return true;
  return u > g;
}

// --- Idempotent orchestrator ---------------------------------------------

export interface EnsureArgs {
  storyId: string;
  articleUrl: string;
  /** Force regeneration even if existing metadata is fresh. The admin's
   *  "Regenerate" button sets this. */
  force?: boolean;
}

export type EnsureResult =
  | { status: "skipped"; reason: string }
  | { status: "generated"; metadata: SeoMetadata; model: string }
  | { status: "failed"; error: string };

/** The render route's entry point. Pulls the story row, decides
 *  whether to regenerate based on the auto_regenerate setting +
 *  staleness, generates if needed, persists. Best-effort: a failure
 *  is logged but never thrown — publishing continues with templates. */
export async function ensureSeoMetadataForStory(
  args: EnsureArgs,
): Promise<EnsureResult> {
  const rows = await all<StorySeoRow>(
    `SELECT id, title, category, teleprompter, updated_at,
            seo_metadata_json, seo_metadata_generated_at
       FROM stories
      WHERE id = ?`,
    [args.storyId],
  );
  const row = rows[0];
  if (!row) {
    log("skip_missing_story", { story_id: args.storyId });
    return { status: "skipped", reason: "story not found" };
  }

  if (!args.force) {
    const autoOn =
      ((await getSetting(SETTING_AUTO_REGENERATE)) ?? "1") !== "0";
    if (!autoOn) {
      log("skip_auto_off", { story_id: args.storyId });
      return { status: "skipped", reason: "auto-regenerate setting off" };
    }
    const stale = isStale(row.seo_metadata_generated_at, row.updated_at);
    if (!stale) {
      log("skip_fresh", {
        story_id: args.storyId,
        generated_at: row.seo_metadata_generated_at,
      });
      return { status: "skipped", reason: "metadata is fresh" };
    }
  }

  const result = await generateSeoMetadata({
    storyId: args.storyId,
    title: row.title ?? args.storyId,
    category: row.category,
    teleprompter: row.teleprompter ?? "",
    articleUrl: args.articleUrl,
  });

  if (!result.ok) {
    return { status: "failed", error: result.error };
  }

  await saveSeoMetadata(args.storyId, result.metadata);
  return { status: "generated", metadata: result.metadata, model: result.model };
}
