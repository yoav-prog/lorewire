// Shared LLM auto-draft service for polls. Single source of truth so
// every "new content created" hook + the admin backfill action + the
// /api/admin/poll-suggest endpoint all produce the same shape of
// auto-drafted question.
//
// 2026-06-18 polls plan extension: every article/story must have a
// poll by default. The hook calls this service synchronously on
// create — best-effort: if the LLM call fails or the output fails
// validation, we INSERT a draft poll using the category preset with
// `enabled = 0`. That keeps the data invariant ("every content piece
// has a polls row") while leaving the bad-output case as a draft the
// admin can promote later. ✓ data always exists; ✗ may not always
// render publicly until an admin reviews.

import "server-only";
import { chatCompletion } from "@/lib/llm";
import { selected } from "@/lib/models";
import {
  getPollByArticleId,
  getPollByStoryId,
  getPresetForCategory,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  upsertPoll,
  validatePollInputs,
} from "@/lib/polls";

interface SuggestPayload {
  question: string;
  optionA: string;
  optionB: string;
}

interface StorySubject {
  kind: "story";
  storyId: string;
  title: string | null;
  body: string | null;
  category: string | null;
}

interface ArticleSubject {
  kind: "article";
  articleId: string;
  title: string | null;
  /** Plain-text body — caller responsible for the Tiptap→text extract. */
  bodyText: string;
  type: string | null;
}

export type AutoDraftSubject = StorySubject | ArticleSubject;

export interface AutoDraftResult {
  ok: boolean;
  pollId?: string;
  /** True when the LLM produced usable output AND the poll was
   *  inserted enabled=1. False when we fell back to a draft
   *  preset (LLM failed / output rejected / non-JSON) — caller
   *  should surface that to the admin so the draft gets review. */
  ai: boolean;
  /** Brief tag for observability when ai=false. */
  fallbackReason?: "llm_failed" | "non_json" | "validation_failed";
  error?: string;
}

/** Auto-draft a poll for the subject and upsert it. Idempotent —
 *  callers can fire this on every create / save without checking
 *  first.
 *
 *  Lifecycle by existing-poll state:
 *   - No poll: try LLM. On success → insert enabled=1. On failure
 *     (empty body / LLM error / non-JSON / validation reject) →
 *     insert preset draft enabled=0. Data row always exists.
 *   - Poll exists with enabled=1: NEVER overwrite. Admin's choice
 *     is the source of truth.
 *   - Poll exists with enabled=0 (i.e. an earlier fallback draft):
 *     try LLM. On success → promote to enabled=1. On failure →
 *     leave the draft as-is. This is the "article got real content
 *     later, upgrade it" path the save-action hook relies on.
 */
export async function autoDraftPollForSubject(
  subject: AutoDraftSubject,
): Promise<AutoDraftResult> {
  // Idempotency: if a poll already exists AND it's enabled (an
  // admin-saved poll), leave it alone. Disabled = draft fallback we
  // wrote ourselves; safe to upgrade.
  const existing =
    subject.kind === "story"
      ? await getPollByStoryId(subject.storyId)
      : await getPollByArticleId(subject.articleId);
  if (existing && existing.enabled === 1) {
    return { ok: true, pollId: existing.id, ai: true };
  }

  // Resolve preset + LLM body once for both branches.
  const categoryForPreset =
    subject.kind === "story" ? subject.category : subject.type;
  const preset = getPresetForCategory(categoryForPreset);
  const modelId = await selected("llm");
  const title = subject.title ?? "";
  const bodyText =
    subject.kind === "story"
      ? (subject.body ?? "").slice(0, 4000)
      : subject.bodyText.slice(0, 4000);

  // Empty body — skip LLM entirely; insert the preset directly as a
  // draft. With no text the model would either hallucinate or
  // refuse; using the preset is honest about what we know.
  if (!bodyText.trim()) {
    return await insertFallback(
      subject,
      preset,
      categoryForPreset,
      "validation_failed",
    );
  }

  const subjectLabel =
    subject.kind === "story" ? "Story" : "Article";
  const result = await chatCompletion({
    modelId,
    jsonMode: true,
    temperature: 0.5,
    messages: [
      {
        role: "system",
        content: [
          `You write engagement polls for Lorewire ${subjectLabel.toLowerCase()}s.`,
          "Output strict JSON only, no prose, no markdown fences.",
          "Voice: short, emotional, opinionated — the question should",
          "make someone want to vote without reading the piece twice.",
          "Avoid neutral framings. Avoid 'I think' or 'maybe'.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `${subjectLabel} title: ${title}`,
          `${subjectLabel} category: ${categoryForPreset ?? "Drama"}`,
          `Preset style — question: "${preset.question}"; options: "${preset.optionA}" vs "${preset.optionB}". Match this energy.`,
          "",
          `${subjectLabel} body:`,
          bodyText,
          "",
          "Return strict JSON with these keys:",
          `- question: string, max ${POLL_QUESTION_MAX} characters, ends with a question mark.`,
          `- optionA: string, max ${POLL_OPTION_MAX} characters — one of the two sides.`,
          `- optionB: string, max ${POLL_OPTION_MAX} characters — the other side.`,
          "Side labels must be actual characters / positions in the piece (eg 'Wife' / 'Husband', 'Yes' / 'No') — not 'Option A' / 'Option B'.",
        ].join("\n"),
      },
    ],
  });

  if (!result.ok) {
    console.warn("[polls autodraft llm failed]", {
      subject: subject.kind,
      id: subjectId(subject),
      error: result.error.slice(0, 200),
    });
    return await insertFallback(
      subject,
      preset,
      categoryForPreset,
      "llm_failed",
    );
  }

  let parsed: Partial<SuggestPayload>;
  try {
    parsed = JSON.parse(result.content) as Partial<SuggestPayload>;
  } catch {
    console.warn("[polls autodraft non-json]", {
      subject: subject.kind,
      id: subjectId(subject),
      preview: result.content.slice(0, 200),
    });
    return await insertFallback(
      subject,
      preset,
      categoryForPreset,
      "non_json",
    );
  }

  const validated = validatePollInputs({
    question: parsed.question,
    optionA: parsed.optionA,
    optionB: parsed.optionB,
  });
  if (!validated.ok) {
    console.warn("[polls autodraft validation failed]", {
      subject: subject.kind,
      id: subjectId(subject),
      error: validated.error,
    });
    return await insertFallback(
      subject,
      preset,
      categoryForPreset,
      "validation_failed",
    );
  }

  const upsertResult = await upsertPoll({
    ...(subject.kind === "story"
      ? { storyId: subject.storyId }
      : { articleId: subject.articleId }),
    question: validated.cleaned.question,
    optionA: validated.cleaned.optionA,
    optionB: validated.cleaned.optionB,
    enabled: true,
    category: categoryForPreset,
  });
  if (!upsertResult.ok) {
    return {
      ok: false,
      ai: false,
      error: upsertResult.error,
      fallbackReason: "validation_failed",
    };
  }
  console.info("[polls autodraft ok]", {
    subject: subject.kind,
    id: subjectId(subject),
    poll_id: upsertResult.pollId,
    model: result.model,
  });
  return { ok: true, pollId: upsertResult.pollId, ai: true };
}

/** Fallback insert when the LLM path didn't produce usable output.
 *  Uses the category preset values with enabled=0 so the public
 *  widget hides until an admin reviews. The data invariant is
 *  preserved: every subject has a polls row. */
async function insertFallback(
  subject: AutoDraftSubject,
  preset: { question: string; optionA: string; optionB: string },
  category: string | null,
  reason: AutoDraftResult["fallbackReason"],
): Promise<AutoDraftResult> {
  const upsertResult = await upsertPoll({
    ...(subject.kind === "story"
      ? { storyId: subject.storyId }
      : { articleId: subject.articleId }),
    question: preset.question,
    optionA: preset.optionA,
    optionB: preset.optionB,
    enabled: false, // draft — admin promotes via the editor
    category,
  });
  return {
    ok: upsertResult.ok,
    pollId: upsertResult.pollId,
    ai: false,
    fallbackReason: reason,
    error: upsertResult.error,
  };
}

function subjectId(s: AutoDraftSubject): string {
  return s.kind === "story" ? s.storyId : s.articleId;
}

/** Extract plain text from a Tiptap JSON document. Mirrors the helper
 *  in /api/admin/seo-suggest + /api/admin/article-poll-suggest;
 *  re-exposed here so the article-creation hook can call this
 *  directly without going through an endpoint. */
export function tiptapToPlainText(raw: string | null): string {
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
