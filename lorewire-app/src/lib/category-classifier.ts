// LLM category classifier used by the admin "reclassify stories" action.
// Mirrors `pipeline/stages.py:classify_category` so the front-end backfill
// path and the live pipeline path tag stories with the same rules. See
// _plans/2026-06-21-category-classifier-and-pills.md.
//
// Contract:
//   - Returns a category from CATEGORIES, never null, never anything else.
//   - LLM failure -> returns the fallback. Network blips never overwrite
//     a working subreddit-map default with garbage.
//   - Closed-enum match is case-insensitive, output is canonical-cased so
//     downstream code can compare without normalising every read site.

import "server-only";

import { CATEGORIES } from "@/app/admin/ui";
import { chatCompletion } from "@/lib/llm";
import { selected as selectedModel } from "@/lib/models";

export type StoryCategory = (typeof CATEGORIES)[number];

export interface ClassifyInput {
  title: string | null | undefined;
  body: string | null | undefined;
  fallback: string;
}

export interface ClassifyResult {
  category: string;
  llmOk: boolean;
  source: "llm" | "fallback";
  reason?: string;
}

// Cap the body so a 12kb article doesn't blow the prompt budget. The
// classifier only needs the first ~2k chars to pick a tag accurately;
// the Python side uses the same window for the same reason.
const BODY_PROMPT_CAP = 2000;

function buildPrompt(title: string, body: string): string {
  const options = CATEGORIES.join(", ");
  const snippet = body.slice(0, BODY_PROMPT_CAP);
  return (
    "You tag short retold-from-Reddit stories with one of these LoreWire " +
    `categories: ${options}.\n` +
    "Pick the ONE that best fits the story below. Reply with just the " +
    "category word, exactly as spelled, no punctuation, no explanation.\n\n" +
    `Title: ${title || "(no title)"}\n` +
    `Story:\n${snippet}`
  );
}

function normaliseResponse(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip surrounding quotes / punctuation, then take the first word the
  // model emitted. Models that "explain" their pick still pass: "Humor —
  // sitcom beat" -> "Humor".
  const firstWord = trimmed.split(/\s+/)[0].replace(/^[.,;:!?"'`]+|[.,;:!?"'`]+$/g, "");
  if (!firstWord) return null;
  const lower = firstWord.toLowerCase();
  for (const cat of CATEGORIES) {
    if (lower === cat.toLowerCase()) return cat;
  }
  return null;
}

export async function classifyCategory(
  input: ClassifyInput,
): Promise<ClassifyResult> {
  const fallback = ensureValidFallback(input.fallback);
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  // Skip the LLM call entirely when there's nothing to classify on. A
  // story with no body would just get back whatever the model guesses
  // from the title — fallback is the honest choice.
  if (!body) {
    return { category: fallback, llmOk: false, source: "fallback", reason: "empty-body" };
  }
  const modelId = await selectedModel("llm");
  const result = await chatCompletion({
    modelId,
    messages: [{ role: "user", content: buildPrompt(title, body) }],
    temperature: 0,
  });
  if (!result.ok) {
    console.warn("[classify-category] llm failed", {
      model: modelId,
      error: result.error,
    });
    return {
      category: fallback,
      llmOk: false,
      source: "fallback",
      reason: result.error,
    };
  }
  const matched = normaliseResponse(result.content);
  if (!matched) {
    console.warn("[classify-category] non-matching response", {
      raw: result.content.slice(0, 80),
    });
    return {
      category: fallback,
      llmOk: true,
      source: "fallback",
      reason: `non-matching: ${result.content.slice(0, 40)}`,
    };
  }
  return { category: matched, llmOk: true, source: "llm" };
}

// Mid-tier safety: if a stored category drifted to something outside the
// closed set (a hand-edit typo, a migration artifact), fall back to
// "Entitled" instead of letting an invalid value cascade. "Drama" would
// be the kindest default, but Drama is the exact value the backfill is
// trying to clean up, so picking it here would silently re-Drama every
// orphan row. Entitled is the second-largest category and least likely
// to be wrong if the model also fails.
function ensureValidFallback(value: string): string {
  return (CATEGORIES as readonly string[]).includes(value) ? value : "Entitled";
}
