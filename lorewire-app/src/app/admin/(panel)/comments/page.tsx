// /admin/comments — the human side of the hybrid moderator. Lists every
// comment the AI did not auto-resolve: "Needs review" (held — borderline,
// low-confidence, or appealed) and "Quarantined" (flagged as a severe category
// like CSAM or credible threats; preserved, never auto-deleted). One query
// joins the author + article so the page is a single trip.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 5).

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import Breadcrumb from "@/app/admin/Breadcrumb";
import { getSetting } from "@/lib/repo";
import { listModerationQueue, type ModerationQueueRow } from "@/lib/comments";
import { ModerationActions } from "./ModerationActions";
import { CommentsKillSwitch } from "./CommentsKillSwitch";

export const dynamic = "force-dynamic";

const LABEL = "font-mono text-[11px] uppercase tracking-wider text-muted";

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default async function CommentsModerationPage() {
  await requireAdmin();
  const rows = await listModerationQueue(200);
  const held = rows.filter((r) => r.status === "held");
  const quarantined = rows.filter((r) => r.status === "quarantined");
  const siteEnabled = (await getSetting("comments.enabled")) !== "0";

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin", label: "Overview" }]} />

      <header className="space-y-1">
        <h1 className="font-display text-[24px] font-extrabold tracking-tightest text-ink">
          Comment review
        </h1>
        <p className="text-[13px] text-muted">
          The AI publishes the clearly-clean and rejects the clearly-bad on its
          own. What lands here is the borderline minority it held for a human,
          plus anything flagged as severe. Approve to publish; reject to keep it
          down.
        </p>
      </header>

      <CommentsKillSwitch enabled={siteEnabled} />

      {quarantined.length > 0 && (
        <section className="space-y-3">
          <div className="rounded-xl border border-cat-entitled/40 bg-cat-entitled/10 px-4 py-3">
            <p className="text-[13px] font-semibold text-cat-entitled">
              Quarantined — handle with care
            </p>
            <p className="mt-1 text-[12px] text-muted">
              These were flagged as a severe category (e.g. sexual content
              involving minors, or credible threats). They are preserved, never
              auto-deleted. Follow your reporting policy before you act.
            </p>
          </div>
          <div className="space-y-3">
            {quarantined.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className={LABEL}>Needs review ({held.length})</h2>
        {held.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
            <p className="text-[14px] text-ink">Nothing waiting.</p>
            <p className="mt-1 text-[13px] text-muted">
              The moderator is keeping up. Borderline comments will appear here
              when it wants a second opinion.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {held.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function QueueCard({ row }: { row: ModerationQueueRow }) {
  const confidencePct =
    typeof row.moderation_confidence === "number"
      ? `${Math.round(row.moderation_confidence * 100)}%`
      : null;
  // Postgres returns COUNT(*) as a string; SQLite as a number. Coerce so the
  // chip and pluralization are correct on both.
  const reports = Number(row.open_reports) || 0;
  const articleHref =
    row.article_language && row.article_slug
      ? `/articles/${row.article_language}/${row.article_slug}`
      : `/admin/articles/${row.article_id}`;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">
              {row.author_name || "Reader"}
            </span>
            {row.is_guest === 1 && (
              <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                Guest
              </span>
            )}
            {row.parent_id && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                reply
              </span>
            )}
            <span className="font-mono text-[10px] text-muted">
              {ago(row.created_at)}
            </span>
          </div>

          <p
            dir="auto"
            className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink"
          >
            {row.body}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {row.moderation_category && (
              <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                {row.moderation_category}
              </span>
            )}
            {confidencePct && (
              <span className="font-mono text-[10px] text-muted">
                confidence {confidencePct}
              </span>
            )}
            {reports > 0 && (
              <span className="rounded-full border border-cat-entitled/40 bg-cat-entitled/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cat-entitled">
                {reports} report{reports === 1 ? "" : "s"}
              </span>
            )}
            <Link
              href={articleHref}
              className="font-mono text-[10px] text-muted underline decoration-line hover:text-ink hover:decoration-accent"
            >
              {row.article_title || "view article"}
            </Link>
          </div>

          {row.moderation_reason && (
            <p className="text-[12px] italic text-muted">
              AI: {row.moderation_reason}
            </p>
          )}
        </div>

        <ModerationActions commentId={row.id} />
      </div>
    </div>
  );
}
