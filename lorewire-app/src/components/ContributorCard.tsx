// Presentational contributor card: avatar, name, rank badge, a progress bar to
// the next rank, the three contribution counts, and member-since. Server
// component (no interactivity) so it renders on both the public profile page and
// the signed-in dashboard from the same shape. The math lives in
// lib/contributor-rank.ts. Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import type { ContributionStats } from "@/lib/contributions";

function monogram(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

function formatMonth(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-2 text-center">
      <div className="text-xl font-bold text-ink">{n}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[.15em] text-muted">
        {label}
      </div>
    </div>
  );
}

export function ContributorCard({
  name,
  pictureUrl,
  memberSince,
  stats,
}: {
  name: string;
  pictureUrl: string | null;
  memberSince: string | null;
  stats: ContributionStats;
}) {
  const { rank } = stats;
  const since = formatMonth(memberSince);
  const pct = Math.round(rank.progress * 100);

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-center gap-4">
        {pictureUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pictureUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface2 text-lg font-bold text-ink">
            {monogram(name)}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold text-ink">{name}</h1>
          <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5">
            <span className="font-mono text-[11px] uppercase tracking-[.15em] text-accent">
              {rank.name}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[.12em] text-muted">
          {rank.points} pts
          {rank.next ? ` · ${rank.toNext} to ${rank.next}` : " · top rank"}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-2">
        <Stat n={stats.submissions} label="Submissions" />
        <Stat n={stats.comments} label="Comments" />
        <Stat n={stats.votes} label="Votes" />
      </div>

      {since && (
        <p className="mt-4 text-[12px] text-muted">Contributing since {since}</p>
      )}
    </div>
  );
}
