// Personal "your submissions" dashboard, the signed-in user's own area. Shows
// their submissions newest-first with a clear state on each, and a way to compose
// a new one or edit a draft/rejected one. Server component; anonymous visitors are
// sent to sign in. Phase 1 is read-only display plus those links; the live vote
// split on published submissions arrives with the render flow in Phase 3.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 1).

import Link from "next/link";
import { redirect } from "next/navigation";

import { ContributorCard } from "@/components/ContributorCard";
import { getContributionStats } from "@/lib/contributions";
import { getAggregateByStoryId } from "@/lib/polls";
import { getStory } from "@/lib/repo";
import {
  listUserSubmissions,
  reconcilePublishedSubmissions,
  type SubmissionRow,
} from "@/lib/submissions";
import {
  CUSTOM_REASON_CATEGORY,
  customReason,
  resolveReason,
} from "@/lib/submission-reasons";
import { readUserSession } from "@/lib/user-session";
import { getUserById } from "@/lib/users";
import { SubmissionDeleteButton } from "./SubmissionDeleteButton";

interface PublishedView {
  slug: string;
  votesA: number;
  votesB: number;
  total: number;
}

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
  quarantined: { label: "Not accepted", tone: "text-danger" },
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

function SubmissionCard({
  s,
  published,
}: {
  s: SubmissionRow;
  published: PublishedView | null;
}) {
  const state = stateOf(s.status);
  const dir = s.lang === "he" ? "rtl" : "ltr";
  const editable = s.status === "draft" || s.status === "rejected";
  const reason =
    s.reject_category === CUSTOM_REASON_CATEGORY
      ? customReason(s.reject_reason ?? "", s.lang ?? "en")
      : s.reject_category
        ? resolveReason(s.reject_category, s.lang ?? "en")
        : null;

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

      {reason && (
        <div
          dir={dir}
          className="mt-2 rounded-md border border-line bg-bg px-3 py-2 text-[13px]"
        >
          <p className="font-medium text-ink">{reason.title}</p>
          <p className="mt-0.5 text-muted">{reason.message}</p>
          {reason.fix && <p className="mt-1 text-muted">{reason.fix}</p>}
        </div>
      )}

      {published && (
        <div className="mt-2 text-[13px]">
          <Link
            href={`/v/${published.slug}`}
            className="font-mono uppercase tracking-[.15em] text-accent hover:underline"
          >
            View your published story →
          </Link>
          {published.total > 0 ? (
            <p dir={dir} className="mt-1 text-muted">
              {s.option_a_text}{" "}
              {Math.round((published.votesA / published.total) * 100)}% ·{" "}
              {s.option_b_text}{" "}
              {Math.round((published.votesB / published.total) * 100)}% ·{" "}
              {published.total} votes
            </p>
          ) : (
            <p className="mt-1 text-muted">No votes yet</p>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3 text-[12px] text-muted">
        <span>{formatDate(s.created_at)}</span>
        {editable && (
          <Link
            href={`/submissions/new?id=${s.id}`}
            className="font-mono uppercase tracking-[.15em] text-ink hover:underline"
          >
            {s.status === "rejected" ? "Fix & resubmit" : "Edit"}
          </Link>
        )}
        {s.status !== "erased" && (
          <SubmissionDeleteButton submissionId={s.id} />
        )}
      </div>
    </li>
  );
}

export default async function SubmissionsPage() {
  const session = await readUserSession();
  if (!session) redirect(`/auth/signin?next=${NEXT}`);

  // Lazy publish sync (the pilot has no completion cron), then enrich published
  // submissions with their public slug + current vote split.
  await reconcilePublishedSubmissions(session.userId);
  const [user, stats, submissions] = await Promise.all([
    getUserById(session.userId),
    getContributionStats(session.userId),
    listUserSubmissions(session.userId),
  ]);
  const profileHidden = Number(user?.profile_hidden) === 1;
  const cards = await Promise.all(
    submissions.map(async (s) => {
      if (s.status !== "published" || !s.story_id) {
        return { s, published: null as PublishedView | null };
      }
      const [story, agg] = await Promise.all([
        getStory(s.story_id),
        getAggregateByStoryId(s.story_id),
      ]);
      const published: PublishedView | null = story?.slug
        ? {
            slug: story.slug,
            votesA: Number(agg?.votes_a ?? 0),
            votesB: Number(agg?.votes_b ?? 0),
            total: Number(agg?.total_votes ?? 0),
          }
        : null;
      return { s, published };
    }),
  );

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

      <div className="mt-6">
        <ContributorCard
          name={user?.name?.trim() || "You"}
          pictureUrl={user?.picture_url ?? null}
          memberSince={user?.created_at ?? null}
          stats={stats}
        />
        <p className="mt-2 text-center text-[12px] text-muted">
          {profileHidden ? (
            <>
              Your public profile is hidden.{" "}
              <Link
                href="/auth/account"
                className="text-ink underline decoration-line hover:decoration-accent"
              >
                Manage visibility
              </Link>
            </>
          ) : (
            <Link
              href={`/u/${session.userId}`}
              className="text-ink underline decoration-line hover:decoration-accent"
            >
              View your public profile →
            </Link>
          )}
        </p>
      </div>

      {cards.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          You haven&apos;t submitted anything yet. Share a dilemma and the
          community votes on it.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {cards.map(({ s, published }) => (
            <SubmissionCard key={s.id} s={s} published={published} />
          ))}
        </ul>
      )}
    </div>
  );
}
