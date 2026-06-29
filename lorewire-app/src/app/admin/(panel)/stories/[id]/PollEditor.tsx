"use client";

// Per-story poll editor. Phase 1 of
// _plans/2026-06-17-engagement-polls.md.
//
// One poll per story: question, two short option labels, enabled toggle.
// "Auto-draft from story" hits /api/admin/poll-suggest — the same LLM
// gateway the SEO panel uses — and fills the three text inputs from the
// model's JSON output. The Save button writes through savePollAction;
// the validation that lives in lib/polls.ts is the single trust
// boundary so the same error messages render here, on auto-draft, and
// on the LLM endpoint.
//
// Pattern: matches StoryAspectControl + the SeoSuggestPanel — client
// component holding form state, server action on submit, fetch on the
// auto-draft secondary action. Sits inside the sidebar of the story
// edit page so the editor never has to scroll past the asset grid.

import { useState, useTransition } from "react";
import { savePollAction } from "@/app/admin/actions";
// Phase 2/3 of _plans/2026-06-17-engagement-polls.md. Client
// components import from `polls-shared` to avoid Turbopack pulling
// the server-only db driver into the browser bundle. See the comment
// at the top of lib/polls.ts for the build-time failure this fixes.
import {
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  type PollRow,
  type StoryCategory,
} from "@/lib/polls-shared";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

interface PollEditorProps {
  storyId: string;
  storyCategory: StoryCategory | string | null;
  /** The existing poll if one was authored, plus the resolved preset
   *  defaults so a brand-new poll lands the editor with non-empty
   *  seed values matched to the category. */
  poll: PollRow | null;
  presetQuestion: string;
  presetOptionA: string;
  presetOptionB: string;
}

export function PollEditor({
  storyId,
  storyCategory,
  poll,
  presetQuestion,
  presetOptionA,
  presetOptionB,
}: PollEditorProps) {
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
    // Brand-new polls default to ENABLED so the admin doesn't author a
    // poll and forget the toggle. Existing polls keep their last
    // setting (so "park a draft" stays meaningful once we have one).
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
    fd.set("story_id", storyId);
    fd.set("question", question);
    fd.set("option_a", optionA);
    fd.set("option_b", optionB);
    fd.set("enabled", enabled ? "1" : "0");
    startSave(async () => {
      const r = await savePollAction(fd);
      if (!r.ok) {
        setError(r.error ?? "Save failed");
        return;
      }
      setSavedAt(new Date().toISOString());
      if (typeof window !== "undefined") {
        console.info("[admin ui] poll saved", {
          storyId,
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
        const resp = await fetch("/api/admin/poll-suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storyId }),
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
          console.info("[admin ui] poll auto-drafted", {
            storyId,
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
      data-testid="poll-editor"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className={LABEL}>Engagement poll</div>
        <button
          type="button"
          onClick={onAutoDraft}
          disabled={isDrafting}
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isDrafting ? "Drafting…" : "Auto-draft from story"}
        </button>
      </div>

      <p className="mb-3 text-[12px] text-muted">
        One question, two sides. Shows at the bottom of{" "}
        <code className="font-mono text-[11px]">/v/{storyId.slice(0, 8)}</code>{" "}
        and burns into the short&apos;s end card when Phase 3 ships.
        {storyCategory && (
          <>
            {" "}
            Preset for{" "}
            <span className="font-mono">{String(storyCategory)}</span>: keep it,
            edit it, or auto-draft.
          </>
        )}
      </p>

      <div className="space-y-3">
        <div>
          <label className={LABEL} htmlFor={`poll-question-${storyId}`}>
            Question
          </label>
          <input
            id={`poll-question-${storyId}`}
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
            <label className={LABEL} htmlFor={`poll-a-${storyId}`}>
              Option A
            </label>
            <input
              id={`poll-a-${storyId}`}
              value={optionA}
              maxLength={POLL_OPTION_MAX}
              onChange={(e) => setOptionA(e.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`poll-b-${storyId}`}>
              Option B
            </label>
            <input
              id={`poll-b-${storyId}`}
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
          <span>Show this poll on /v/[slug] and the article reader.</span>
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
            Drafted by <span className="text-ink">{draftModel}</span> — review
            and Save.
          </p>
        )}
      </div>
    </div>
  );
}
