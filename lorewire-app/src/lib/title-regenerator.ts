// One-click title regenerator for the admin (plan:
// _plans/2026-06-25-title-length-gate.md, Layer 3).
//
// The Python pipeline produces the initial branded title and now has
// its own validator + retry + salvage path. This module mirrors that
// logic in TypeScript so an admin who spots a too-long title in the
// short editor can fix it with one click, without round-tripping
// through the Python worker queue.
//
// The brand voice + length cap match the pipeline. If the two ever
// drift, the symptom is "regenerated titles don't sound like worker-
// generated titles" — easy to spot, easy to fix here.
//
// Best-effort: a failed regenerate returns `{ ok: false, error }` and
// leaves `stories.title` untouched. The admin can click again or edit
// the title field directly.

import "server-only";

import { z } from "zod";
import { chatCompletion, type ChatMessage } from "@/lib/llm";
import { getStory, updateStory } from "@/lib/repo";

// --- Length policy (must agree with pipeline/stages.py) -------------------

export const TITLE_MAX_CHARS = 50;
export const TITLE_MAX_WORDS = 8;

// Pinned model — matches the Python pipeline (`openai/gpt-5-nano`) so the
// voice stays identical across the worker path and the admin-recovery
// path. If the pipeline switches model, switch here too.
const DEFAULT_MODEL = "openai/gpt-5-nano";

// --- Style anchors (must agree with pipeline/stages.py TITLE_STYLE_EXAMPLES)
const TITLE_STYLE_EXAMPLES = [
  "THE $800 ENVELOPE",
  "THE NEIGHBOR'S FENCE",
  "SHE REPLIED ALL",
  "WRONG NUMBER, RIGHT GUY",
  "GIVE ME YOUR SEAT",
  "THE PARKING SPOT WAR",
  "IT'S MY BIRTHDAY MONTH",
  "THE WEDDING CRASHER",
  "MY ROOMMATE'S 3AM RULES",
];

// --- Validation -----------------------------------------------------------

/** Zod schema mirroring `_title_within_bounds` in the Python pipeline.
 *  Rejects empty, over-length, and over-word-count titles. Used by the
 *  regenerator AND exported so tests can pin the contract. */
export const TitleSchema = z
  .string()
  .trim()
  .min(3, "title is too short")
  .max(TITLE_MAX_CHARS, `title must be at most ${TITLE_MAX_CHARS} characters`)
  .refine(
    (s) => s.split(/\s+/).length <= TITLE_MAX_WORDS,
    `title must be at most ${TITLE_MAX_WORDS} words`,
  );

const TitlePayloadSchema = z.object({
  title: TitleSchema,
});

/** Strict structured-output schema mirroring the Zod shape. Used in the
 *  LLM call's `response_format = json_schema` so the model emits parsable
 *  JSON without us having to strip code fences. */
const TITLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      type: "string",
      minLength: 3,
      maxLength: TITLE_MAX_CHARS,
    },
  },
} as const;

// --- Prompt builders ------------------------------------------------------

export function systemPrompt(): string {
  const examples = TITLE_STYLE_EXAMPLES.map((t) => `- ${t}`).join("\n");
  return `You write headlines for LoreWire, where true internet stories are retold as short, vivid pieces. You will receive an article body. Return a short branded title that matches the LoreWire voice:

- ALL CAPS
- 2 to 6 words
- at most ${TITLE_MAX_CHARS} characters total
- evocative, not clickbait
- no question marks
- no Reddit-isms ("AITA", "WIBTA", "TIFU")
- no leading "THE STORY OF"

Matching voice examples:
${examples}

Return ONLY the JSON object {"title": "..."}. No surrounding prose, no markdown fences.`;
}

export function userPrompt(args: { body: string; category: string }): string {
  return [
    `Category: ${args.category}`,
    ``,
    `Article body:`,
    `"""`,
    args.body,
    `"""`,
  ].join("\n");
}

// --- Observability --------------------------------------------------------

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[title regen ${event}]`, JSON.stringify(fields));
}

// --- Generation -----------------------------------------------------------

export type RegenerateResult =
  | {
      ok: true;
      title: string;
      previousTitle: string | null;
      model: string;
    }
  | {
      ok: false;
      error: string;
      stage: "story-not-found" | "story-missing-body" | "llm" | "parse" | "schema" | "db";
    };

/** Read a story, ask the LLM for a fresh branded title within the
 *  length policy, validate the response, and persist it to
 *  `stories.title`. Never throws — callers branch on `ok`. */
export async function regenerateTitleForStory(
  storyId: string,
): Promise<RegenerateResult> {
  const t0 = Date.now();

  const story = await getStory(storyId);
  if (!story) {
    return { ok: false, error: "story not found", stage: "story-not-found" };
  }
  // Need a body to ground the prompt. A story with no body is either
  // mid-pipeline or broken — refuse rather than emit a hallucinated title.
  const body = (story.body ?? "").trim();
  if (body.length < 20) {
    log("skip_no_body", { story_id: storyId, body_chars: body.length });
    return {
      ok: false,
      error: "story has no body text to base a title on",
      stage: "story-missing-body",
    };
  }

  const previousTitle = story.title ?? null;
  const category = story.category ?? "Stories";

  log("call_start", {
    story_id: storyId,
    model: DEFAULT_MODEL,
    body_chars: body.length,
    previous_title_chars: previousTitle?.length ?? 0,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt({ body, category }) },
  ];

  const llmResult = await chatCompletion({
    modelId: DEFAULT_MODEL,
    messages,
    // Reasoning model: omit temperature, use max_completion_tokens, set
    // the strict JSON schema so the response is parseable as-is.
    omitTemperature: true,
    maxCompletionTokens: 2000,
    reasoningEffort: "minimal",
    jsonSchema: {
      name: "lorewire_branded_title",
      schema: TITLE_JSON_SCHEMA as unknown as Record<string, unknown>,
    },
  });

  if (!llmResult.ok) {
    log("llm_failed", {
      story_id: storyId,
      latency_ms: Date.now() - t0,
      error: llmResult.error.slice(0, 300),
    });
    return { ok: false, error: llmResult.error, stage: "llm" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    log("parse_failed", {
      story_id: storyId,
      raw_first_300: llmResult.content.slice(0, 300),
    });
    return {
      ok: false,
      error: `LLM response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      stage: "parse",
    };
  }

  const validation = TitlePayloadSchema.safeParse(parsed);
  if (!validation.success) {
    log("schema_failed", {
      story_id: storyId,
      zod_first_issue: validation.error.issues[0]?.message ?? "unknown",
    });
    return {
      ok: false,
      error: `LLM title failed schema: ${validation.error.issues[0]?.message ?? "unknown"}`,
      stage: "schema",
    };
  }

  // ALL CAPS is part of the brand voice. Enforce here rather than trust
  // the LLM (some return Title Case despite the system prompt).
  const newTitle = validation.data.title.toUpperCase();

  try {
    await updateStory(storyId, { title: newTitle });
  } catch (err) {
    log("db_failed", {
      story_id: storyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: `failed to persist title: ${err instanceof Error ? err.message : String(err)}`,
      stage: "db",
    };
  }

  log("ok", {
    story_id: storyId,
    latency_ms: Date.now() - t0,
    previous_chars: previousTitle?.length ?? 0,
    new_chars: newTitle.length,
    new_words: newTitle.split(/\s+/).length,
  });

  return {
    ok: true,
    title: newTitle,
    previousTitle,
    model: DEFAULT_MODEL,
  };
}
