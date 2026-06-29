"use client";

// Client form backing the submission page. Posts to POST /api/submissions with
// the lw_user cookie. English-only for the pilot — the moderation, the reason
// taxonomy and the viewer already handle Hebrew, so re-enabling it later is just
// restoring the language toggle and the per-field `dir`. Two actions: save a
// draft, or submit for review.

import { useState } from "react";
import { useRouter } from "next/navigation";

interface InitialValues {
  title: string;
  body: string;
  question: string;
  optionA: string;
  optionB: string;
  lang: "en" | "he";
}

const LABEL = "text-[12px] font-mono uppercase tracking-[.2em] text-muted";
const INPUT =
  "mt-1 block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-60";

export default function SubmissionForm({
  id,
  initial,
  wasRejected,
}: {
  id: string | null;
  initial: InitialValues | null;
  wasRejected: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [optionA, setOptionA] = useState(initial?.optionA ?? "");
  const [optionB, setOptionB] = useState(initial?.optionB ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(action: "submit" | "draft") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          id,
          action,
          title,
          body,
          question,
          optionA,
          optionB,
          lang: "en",
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? "Couldn't save. Try again.");
        return;
      }
      router.push("/submissions");
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-6 space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void send("submit");
      }}
    >
      {wasRejected && (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted">
          Make your edits below and send it back in.
        </p>
      )}

      <label className="block">
        <span className={LABEL}>Title</span>
        <input
          type="text"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          className={INPUT}
          placeholder="A short headline for your dilemma"
        />
      </label>

      <label className="block">
        <span className={LABEL}>Your story</span>
        <textarea
          rows={6}
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
          className={INPUT}
          placeholder="What happened? Tell it from your side."
        />
        <span className="mt-1 block text-[12px] text-muted">
          Keep it about you. Don&apos;t name or describe real people, the post
          gets turned into a public video.
        </span>
      </label>

      <label className="block">
        <span className={LABEL}>The dilemma</span>
        <input
          type="text"
          maxLength={200}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
          className={INPUT}
          placeholder="The question people will vote on"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={LABEL}>Option A</span>
          <input
            type="text"
            maxLength={60}
            value={optionA}
            onChange={(e) => setOptionA(e.target.value)}
            disabled={busy}
            className={INPUT}
            placeholder="e.g. You're right"
          />
        </label>
        <label className="block">
          <span className={LABEL}>Option B</span>
          <input
            type="text"
            maxLength={60}
            value={optionB}
            onChange={(e) => setOptionB(e.target.value)}
            disabled={busy}
            className={INPUT}
            placeholder="e.g. You're wrong"
          />
        </label>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-60"
        >
          {wasRejected ? "Resubmit for review" : "Submit for review"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void send("draft")}
          className="rounded-md border border-line px-4 py-2 text-sm font-medium text-ink hover:border-ink disabled:opacity-60"
        >
          Save draft
        </button>
      </div>
    </form>
  );
}
