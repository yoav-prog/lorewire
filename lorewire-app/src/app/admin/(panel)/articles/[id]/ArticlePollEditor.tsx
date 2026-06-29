"use client";

// Per-article poll editor. 2026-06-18 standalone-article polls
// (plan §15 of _plans/2026-06-17-engagement-polls.md). Mirrors the
// PollEditor for stories — same shape, same trust boundary
// (validatePollInputs), different server action + suggest endpoint
// and article-type-keyed preset seed.
//
// One poll per article. The article reader's resolution priority is
// "article-own > linked-story" so authoring a poll here overrides
// any inherited story poll on this article's slug.

import { useState, useTransition } from "react";
import { saveArticlePollAction } from "@/app/admin/actions";
import {
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  type PollRow,
} from "@/lib/polls-shared";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

interface ArticlePollEditorProps {
  articleId: string;
  articleType: string | null;
  /** Existing article poll if one was authored, else null. */
  poll: PollRow | null;
  presetQuestion: string;
  presetOptionA: string;
  presetOptionB: string;
}

export function ArticlePollEditor({
  articleId,
  articleType,
  poll,
  presetQuestion,
  presetOptionA,
  presetOptionB,
}: ArticlePollEditorProps) {
  const [question, setQuestion] = useState<string>(
    poll?.question ?? presetQuestion,
  );
  const [optionA, setOptionA] = useState<string>(
    poll?.option_a_text ?? presetOptionA,
  );
  const [optionB, setOptionB] = useState<string>(
    poll?.option_b_text ?? presetOptionB,
  );
  const [enabled, setEnabled] = useState<boolean>(
    poll ? poll.enabled === 1 : true,
  );

  const [isSaving, startSave] = useTransition();
  const [isDrafting, startDraft] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);

  function onSave(): void {
    setError(null);
    setSavedAt(null);
    const fd = new FormData();
    fd.set("article_id", articleId);
    fd.set("question", question);
    fd.set("option_a", optionA);
    fd.set("option_b", optionB);
    fd.set("enabled", enabled ? "1" : "0");
    startSave(async () => {
      const r = await saveArticlePollAction(fd);
      if (!r.ok) {
        setError(r.error ?? "Save failed");
        return;
      }
      setSavedAt(new Date().toISOString());
      if (typeof window !== "undefined") {
        console.info("[admin ui] article poll saved", {
          articleId,
          created: r.created ?? false,
        });
      }
    });
  }

  function onAutoDraft(): void {
    setDraftError(null);
    setDraftModel(null);
    startDraft(async () => {
      try {
        const resp = await fetch("/api/admin/article-poll-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ articleId }),
        });
        const data = (await resp.json()) as {
          error?: string;
          model?: string;
          suggestion?: { question: string; optionA: string; optionB: string };
        };
        if (!resp.ok || !data.suggestion) {
          setDraftError(data.error ?? `Suggest failed (${resp.status})`);
          return;
        }
        setQuestion(data.suggestion.question);
        setOptionA(data.suggestion.optionA);
        setOptionB(data.suggestion.optionB);
        setDraftModel(data.model ?? null);
        if (typeof window !== "undefined") {
          console.info("[admin ui] article poll auto-drafted", {
            articleId,
            model: data.model ?? null,
          });
        }
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const dirty =
    question !== (poll?.question ?? presetQuestion) ||
    optionA !== (poll?.option_a_text ?? presetOptionA) ||
    optionB !== (poll?.option_b_text ?? presetOptionB) ||
    enabled !== (poll ? poll.enabled === 1 : true);

  return (
    <div
      className="rounded-xl border border-line bg-surface p-4"
      data-testid="article-poll-editor"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className={LABEL}>Engagement poll</div>
        <button
          type="button"
          onClick={onAutoDraft}
          disabled={isDrafting}
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isDrafting ? "Drafting…" : "Auto-draft from article"}
        </button>
      </div>

      <p className="mb-3 text-[12px] text-muted">
        One question, two sides. Shows at the bottom of the public
        article reader. Article polls override any linked-story poll
        on the same article.
        {articleType && (
          <>
            {" "}
            Preset for type{" "}
            <span className="font-mono">{articleType}</span>.
          </>
        )}
      </p>

      <div className="space-y-3">
        <div>
          <label className={LABEL} htmlFor={`article-poll-question-${articleId}`}>
            Question
          </label>
          <input
            id={`article-poll-question-${articleId}`}
            value={question}
            maxLength={POLL_QUESTION_MAX}
            onChange={(e) => setQuestion(e.target.value)}
            className={FIELD}
          />
          <p className="mt-0.5 font-mono text-[10px] text-muted">
            {question.length} / {POLL_QUESTION_MAX}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor={`article-poll-a-${articleId}`}>
              Option A
            </label>
            <input
              id={`article-poll-a-${articleId}`}
              value={optionA}
              maxLength={POLL_OPTION_MAX}
              onChange={(e) => setOptionA(e.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`article-poll-b-${articleId}`}>
              Option B
            </label>
            <input
              id={`article-poll-b-${articleId}`}
              value={optionB}
              maxLength={POLL_OPTION_MAX}
              onChange={(e) => setOptionB(e.target.value)}
              className={FIELD}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-line"
          />
          <span>Show this poll on the article reader.</span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving || !dirty}
            className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? "Saving…" : poll ? "Save poll" : "Create poll"}
          </button>
          {savedAt && !dirty && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-cat-wholesome">
              Saved
            </span>
          )}
          {dirty && !isSaving && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              Unsaved changes
            </span>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-2 text-[12px] text-cat-entitled">
            {error}
          </p>
        )}
        {draftError && (
          <p className="rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-2 text-[12px] text-cat-entitled">
            Auto-draft: {draftError}
          </p>
        )}
        {draftModel && !draftError && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Drafted by <span className="text-ink">{draftModel}</span> —
            review and Save.
          </p>
        )}
      </div>
    </div>
  );
}
