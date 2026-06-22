// LLM auto-draft endpoint for the article-poll editor. Mirrors
// /api/admin/poll-suggest (story polls) but reads the article's
// Tiptap document → plain text for the prompt body.
//
// 2026-06-18 standalone-article polls (plan §15).
//
// Cost (rule 8): single chat-completion per click. With the active
// LLM at typical article body lengths (~3-5K plain-text chars) this
// stays well under $0.01 per call.
//
// Security (rule 13): admin-gated. Article id must resolve to a
// real row before any LLM call so spamming the endpoint with
// garbage ids can't burn budget. Prompt template is fixed server-
// side; user can't inject system instructions. LLM output is gated
// through the same validatePollInputs boundary the form uses —
// a model hallucinating over-length labels or identical sides is
// rejected the same way a bad admin form submission is.

import { NextRequest } from "next/server";
import { requireCapability } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import { selected } from "@/lib/models";
import { chatCompletion } from "@/lib/llm";
import {
  getPresetForCategory,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  validatePollInputs,
} from "@/lib/polls";

interface SuggestPayload {
  question: string;
  optionA: string;
  optionB: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  await requireCapability("content.manage");
  let body: { articleId?: string };
  try {
    body = (await req.json()) as { articleId?: string };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const articleId = body.articleId?.trim();
  if (!articleId) {
    return Response.json({ error: "articleId required" }, { status: 400 });
  }

  const article = await getArticle(articleId);
  if (!article) {
    return Response.json({ error: "Article not found" }, { status: 404 });
  }

  const modelId = await selected("llm");
  // Article polls don't have story-style category presets (Drama /
  // Entitled / etc). Use the article TYPE as the preset key — the
  // CATEGORY_POLL_PRESETS map doesn't include news / feature /
  // listicle / review, so getPresetForCategory falls back to the
  // Drama preset. Acceptable: the preset is just a voice cue, not
  // a hard constraint, and the model still reads the article body.
  const preset = getPresetForCategory(article.type);
  // Cap body at 4000 chars: enough context for the model to pick
  // the right two sides, cheap enough that the call stays under a
  // penny.
  const bodyText = extractPlainText(article.document).slice(0, 4000);

  const result = await chatCompletion({
    modelId,
    jsonMode: true,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: [
          "You write engagement polls for Lorewire articles.",
          "Output strict JSON only, no prose, no markdown fences.",
          "Voice: short, emotional, opinionated — the question should",
          "make someone want to vote without reading the article twice.",
          "Avoid neutral framings. Avoid 'I think' or 'maybe'.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Article title: ${article.title ?? ""}`,
          `Article type: ${article.type ?? "feature"}`,
          `Preset style — question: "${preset.question}"; options: "${preset.optionA}" vs "${preset.optionB}". Match this energy.`,
          "",
          "Article body (plain text):",
          bodyText,
          "",
          "Return strict JSON with these keys:",
          `- question: string, max ${POLL_QUESTION_MAX} characters, ends with a question mark.`,
          `- optionA: string, max ${POLL_OPTION_MAX} characters — one of the two sides.`,
          `- optionB: string, max ${POLL_OPTION_MAX} characters — the other side.`,
          "Side labels must be the actual positions or characters discussed in the article (eg 'Yes' / 'No', 'Apple' / 'Samsung') — not 'Option A' / 'Option B'.",
        ].join("\n"),
      },
    ],
  });

  if (!result.ok) {
    console.warn("[article polls suggest] llm failed", {
      article_id: articleId,
      model: modelId,
      error: result.error.slice(0, 200),
    });
    return Response.json({ error: result.error }, { status: 502 });
  }

  let parsed: Partial<SuggestPayload>;
  try {
    parsed = JSON.parse(result.content) as Partial<SuggestPayload>;
  } catch {
    console.warn("[article polls suggest] non-json response", {
      article_id: articleId,
      model: modelId,
      preview: result.content.slice(0, 200),
    });
    return Response.json(
      { error: "Model returned non-JSON output. Try again or pick a different model." },
      { status: 502 },
    );
  }

  const validated = validatePollInputs({
    question: parsed.question,
    optionA: parsed.optionA,
    optionB: parsed.optionB,
  });
  if (!validated.ok) {
    console.warn("[article polls suggest] llm output rejected", {
      article_id: articleId,
      model: modelId,
      error: validated.error,
    });
    return Response.json(
      { error: `Model output didn't pass validation: ${validated.error}` },
      { status: 502 },
    );
  }

  console.info("[article polls suggest] ok", {
    article_id: articleId,
    model: modelId,
    question_len: validated.cleaned.question.length,
  });

  return Response.json({
    suggestion: validated.cleaned,
    model: result.model,
    provider: result.provider,
  });
}

// Plain-text walk over a Tiptap-style ProseMirror doc. Concatenates
// text nodes with spaces between top-level blocks. Defensive against
// non-object children and malformed docs — anything we can't read
// becomes an empty string. Mirrors the helper in
// /api/admin/seo-suggest/route.ts; kept inline here to avoid an
// implicit cross-route import dependency.
function extractPlainText(raw: string | null): string {
  if (!raw) return "";
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return "";
  }
  const out: string[] = [];
  walk(doc, out);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function walk(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.text === "string") {
    out.push(n.text);
  }
  if (Array.isArray(n.content)) {
    for (const child of n.content) walk(child, out);
  }
}
