// New / edit submission form. Signed-in users compose their own story + a
// two-option dilemma. With ?id=<submission> it loads that submission for editing,
// but only when the caller owns it and it is still a draft or a rejection. Server
// component: resolves the session and sends anonymous visitors to sign in first,
// so the URL alone can't reach the form unauthenticated.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 1).

import Link from "next/link";
import { redirect } from "next/navigation";

import { getSubmissionById } from "@/lib/submissions";
import { readUserSession } from "@/lib/user-session";
import SubmissionForm from "./SubmissionForm";

export const dynamic = "force-dynamic";

const NEXT = encodeURIComponent("/submissions/new");

export default async function NewSubmissionPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const session = await readUserSession();
  if (!session) redirect(`/auth/signin?next=${NEXT}`);

  const { id } = await searchParams;
  let editing: Awaited<ReturnType<typeof getSubmissionById>> = null;
  if (id) {
    const existing = await getSubmissionById(id);
    // Only the owner may edit, and only a draft or a rejected submission.
    if (
      existing &&
      existing.user_id === session.userId &&
      (existing.status === "draft" || existing.status === "rejected")
    ) {
      editing = existing;
    }
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <Link
        href="/submissions"
        className="inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-[.2em] text-muted hover:text-ink"
      >
        ← Your submissions
      </Link>
      <h1 className="mt-4 font-display text-2xl font-bold uppercase tracking-tight text-ink">
        {editing ? "Edit your dilemma" : "Submit a dilemma"}
      </h1>
      <p className="mt-2 text-sm text-muted">
        Tell your own story, or a made-up one, and ask the question you want people
        to vote on. A person reviews it before it goes live. Keep it about you:
        don&apos;t name or describe real people.
      </p>

      <SubmissionForm
        id={editing?.id ?? null}
        wasRejected={editing?.status === "rejected"}
        initial={
          editing
            ? {
                title: editing.title,
                body: editing.body,
                question: editing.dilemma_question,
                optionA: editing.option_a_text,
                optionB: editing.option_b_text,
                lang: editing.lang === "he" ? "he" : "en",
              }
            : null
        }
      />
    </div>
  );
}
