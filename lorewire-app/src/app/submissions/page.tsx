// Personal "your submissions" dashboard, the signed-in user's own area. Shows
// their submissions newest-first with a clear state on each, and a way to compose
// a new one or edit a draft/rejected one. Server component; anonymous visitors are
// sent to sign in. Phase 1 is read-only display plus those links; the live vote
// split on published submissions arrives with the render flow in Phase 3.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 1).

import Link from "next/link";
import { redirect } from "next/navigation";

import { listUserSubmissions, type SubmissionRow } from "@/lib/submissions";
import { readUserSession } from "@/lib/user-session";

export const dynamic = "force-dynamic";

const NEXT = encodeURIComponent("/submissions");

// Friendly, plain-language state shown to the author. Keep these kind: a
// submission is something they made, so "Needs another look" reads better than
// "Rejected". `tone` picks the badge color token.
const STATE: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "text-muted" },
  pending_text_check: { label: "In review", tone: "text-muted" },
  pending_review: { label: "In review", tone: "text-muted" },
  rejected: { label: "Needs another look", tone: "text-danger" },
  approved: { label: "Approved — making your video", tone: "text-ink" },
  rendering: { label: "Approved — making your video", tone: "text-ink" },
  published: { label: "Live", tone: "text-accent" },
  unpublished: { label: "Removed", tone: "text-muted" },
  erased: { label: "Removed", tone: "text-muted" },
};

function stateOf(status: string): { label: string; tone: string } {
  return STATE[status] ?? { label: status, tone: "text-muted" };
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SubmissionCard({ s }: { s: SubmissionRow }) {
  const state = stateOf(s.status);
  const dir = s.lang === "he" ? "rtl" : "ltr";
  const editable = s.status === "draft" || s.status === "rejected";

  return (
    <li className="rounded-md border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <h2 dir={dir} className="text-sm font-medium text-ink">
          {s.title}
        </h2>
        <span
          className={`shrink-0 text-[11px] font-mono uppercase tracking-[.15em] ${state.tone}`}
        >
          {state.label}
        </span>
      </div>
      <p dir={dir} className="mt-1 text-sm text-muted">
        {s.dilemma_question}
      </p>
      <div className="mt-2 flex items-center gap-3 text-[12px] text-muted">
        <span>{formatDate(s.created_at)}</span>
        {editable && (
          <Link
            href={`/submissions/new?id=${s.id}`}
            className="font-mono uppercase tracking-[.15em] text-ink hover:underline"
          >
            Edit
          </Link>
        )}
      </div>
    </li>
  );
}

export default async function SubmissionsPage() {
  const session = await readUserSession();
  if (!session) redirect(`/auth/signin?next=${NEXT}`);

  const submissions = await listUserSubmissions(session.userId);

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-[.2em] text-muted hover:text-ink"
      >
        ← Back
      </Link>
      <div className="mt-4 flex items-end justify-between gap-3">
        <h1 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">
          Your submissions
        </h1>
        <Link
          href="/submissions/new"
          className="shrink-0 rounded-md border border-ink bg-ink px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90"
        >
          New submission
        </Link>
      </div>

      {submissions.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          You haven&apos;t submitted anything yet. Share a dilemma and the
          community votes on it.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {submissions.map((s) => (
            <SubmissionCard key={s.id} s={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
