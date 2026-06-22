// Server endpoint for the "Auto-fill SEO" button in the article editor.
// Loads the article, walks the Tiptap document for plain text, prompts the
// active LLM model (Settings → Models) for SEO metadata, and returns a slim
// JSON shape the client panel can map onto the existing meta_title /
// meta_description inputs.
//
// Cost (rule 8): a single chat-completion call per click. With gpt-5.4-mini
// at typical article lengths (3-5K input chars) this is well under $0.01
// per call. The UI surfaces the model name so the admin can see what they
// just spent on.
//
// Security (rule 13): admin-gated. Article id resolves to a real row before
// any LLM call so an attacker can't burn budget by spamming the endpoint
// with garbage ids. The prompt template is fixed server-side; the user
// can't inject system instructions.

import { NextRequest } from "next/server";
import { requireCapability } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import { selected } from "@/lib/models";
import { chatCompletion } from "@/lib/llm";
import { getSiteSeo } from "@/lib/site-seo";

interface Suggestions {
  meta_title?: string;
  meta_description?: string;
  keywords?: string[];
  og_image_alt?: string;
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
  const seo = await getSiteSeo();

  const plainBody = extractPlainText(article.document).slice(0, 8000);

  const result = await chatCompletion({
    modelId,
    jsonMode: true,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: [
          "You generate SEO metadata for a publication.",
          "Output strict JSON only, no prose, no markdown fences.",
          `Brand: ${seo.siteName}. Audience: general readers on the open web.`,
          "Voice: plain, factual, no marketing fluff, no superlatives.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          "Generate SEO metadata for this article.",
          "",
          `Title: ${article.title ?? ""}`,
          `Subtitle: ${article.subtitle ?? ""}`,
          `Summary: ${article.summary ?? ""}`,
          "",
          "Body (plain text):",
          plainBody,
          "",
          "Return strict JSON with these keys:",
          '- meta_title: string, max 60 characters, sentence case, no trailing period.',
          '- meta_description: string, max 160 characters, one sentence, factual.',
          '- keywords: string[], 5–10 short tags relevant to discovery.',
          '- og_image_alt: string, one sentence describing an ideal hero image.',
        ].join("\n"),
      },
    ],
  });

  if (!result.ok) {
    console.warn("[seo-suggest] llm failed", {
      article_id: articleId,
      model: modelId,
      error: result.error.slice(0, 200),
    });
    return Response.json({ error: result.error }, { status: 502 });
  }

  let parsed: Suggestions;
  try {
    parsed = JSON.parse(result.content) as Suggestions;
  } catch {
    console.warn("[seo-suggest] non-json response", {
      article_id: articleId,
      model: modelId,
      preview: result.content.slice(0, 200),
    });
    return Response.json(
      { error: "Model returned non-JSON output. Try again or pick a different model." },
      { status: 502 },
    );
  }

  // Defensive normalization: cap lengths and coerce keyword shape.
  const suggestions: Suggestions = {
    meta_title: typeof parsed.meta_title === "string"
      ? parsed.meta_title.slice(0, 70)
      : undefined,
    meta_description: typeof parsed.meta_description === "string"
      ? parsed.meta_description.slice(0, 200)
      : undefined,
    keywords: Array.isArray(parsed.keywords)
      ? parsed.keywords
          .filter((k): k is string => typeof k === "string")
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, 10)
      : undefined,
    og_image_alt: typeof parsed.og_image_alt === "string"
      ? parsed.og_image_alt.slice(0, 200)
      : undefined,
  };

  console.info("[seo-suggest] ok", {
    article_id: articleId,
    model: modelId,
    has_title: Boolean(suggestions.meta_title),
    has_desc: Boolean(suggestions.meta_description),
    keyword_count: suggestions.keywords?.length ?? 0,
  });

  return Response.json({ suggestions, model: result.model, provider: result.provider });
}

// Recursive plain-text walk over a Tiptap-style ProseMirror doc. Concatenates
// text nodes with newlines between top-level blocks. Defensive against
// non-object children and malformed docs — anything we can't read becomes
// an empty string.
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
