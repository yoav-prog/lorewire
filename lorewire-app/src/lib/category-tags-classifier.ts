// TS multi-tag classifier for the admin dry-run reclassification (PR: admin
// trigger for _plans/2026-07-01-category-taxonomy-multitag.md). Mirrors the
// Python `pipeline/stages.py:classify_story_tags` so the admin path and the
// pipeline path pick tags with the same rules. Kept as a TS copy so
// the admin action runs in Vercel (which already has the DB + LLM key), with
// no cross-runtime job plumbing.
//
// Contract:
//   - Returns 1..maxTags {slug, confidence} ordered most-confident first; the
//     first is the story's PRIMARY. Closed-set guarded (a model inventing a
//     slug never becomes a tag), confidence clamped to [0,1], deduped keeping
//     the highest per slug.
//   - Returns [] on LLM failure, empty body, or unparseable output, so the
//     caller routes the story to the review queue instead of guessing.

import "server-only";

import { chatCompletion } from "@/lib/llm";
import { selected as selectedModel } from "@/lib/models";

export interface TagCategory {
  slug: string;
  label: string;
  description?: string | null;
}

export interface StoryTag {
  slug: string;
  confidence: number;
}

export interface ClassifyTagsInput {
  title: string | null | undefined;
  body: string | null | undefined;
  categories: TagCategory[];
  maxTags?: number;
}

// Same window as classify_category / the Python classifier.
const BODY_PROMPT_CAP = 2000;

function buildPrompt(title: string, body: string, categories: TagCategory[]): string {
  const options = categories
    .map((c) => `- ${c.slug}: ${c.description || c.label}`)
    .join("\n");
  const snippet = body.slice(0, BODY_PROMPT_CAP);
  return (
    "You tag short retold-from-Reddit stories with LoreWire categories.\n" +
    "Categories (slug: what it means):\n" +
    `${options}\n\n` +
    "Pick the 1 to 3 categories that BEST fit the story below. Prefer fewer " +
    "tags — use just one when only one clearly fits. Return ONLY a JSON array " +
    'like [{"slug": "<a slug above>", "confidence": <0.0-1.0>}], ordered ' +
    "most-confident first, no prose, no code fences.\n\n" +
    `Title: ${title || "(no title)"}\n` +
    `Story:\n${snippet}`
  );
}

/** Grab the first `[` through the last `]` so code fences / prose around the
 *  JSON array don't break parsing. Mirrors the Python `_parse_tag_json`. */
function parseTagJson(raw: string): unknown[] {
  const text = (raw ?? "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const data: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function classifyStoryTags(
  input: ClassifyTagsInput,
): Promise<StoryTag[]> {
  const maxTags = input.maxTags ?? 3;
  const categories = input.categories ?? [];
  if (categories.length === 0) return [];
  const title = (input.title ?? "").trim();
  const body = (input.body ?? "").trim();
  // Nothing to classify on -> review queue (matches classify_category's
  // empty-body skip).
  if (!body) return [];

  const modelId = await selectedModel("llm");
  const result = await chatCompletion({
    modelId,
    messages: [{ role: "user", content: buildPrompt(title, body, categories) }],
    temperature: 0,
  });
  if (!result.ok) {
    console.warn("[classify-story-tags] llm failed", { error: result.error });
    return [];
  }

  const parsed = parseTagJson(result.content);
  if (parsed.length === 0) {
    console.warn("[classify-story-tags] non-matching response", {
      raw: result.content.slice(0, 80),
    });
    return [];
  }

  const validSlugs = new Set(categories.map((c) => c.slug));
  const best = new Map<string, number>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { slug?: unknown; confidence?: unknown };
    const slug = typeof rec.slug === "string" ? rec.slug.trim() : "";
    if (!validSlugs.has(slug)) continue;
    let conf = Number(rec.confidence);
    if (!Number.isFinite(conf)) conf = 0;
    conf = Math.max(0, Math.min(1, conf));
    if (!best.has(slug) || conf > (best.get(slug) as number)) best.set(slug, conf);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([slug, confidence]) => ({ slug, confidence }));
}
