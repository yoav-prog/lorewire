"use client";

// Self-contained homepage rail card for the three derived poll rails
// (divisive / agreed / unpopular). Phase 4.5 of
// _plans/2026-06-17-engagement-polls.md.
//
// Renders directly from RailCardRow — no static-catalog lookup, no
// dependency on lib/stories.STORIES. This sidesteps the existing
// curation system's silent-failure mode where DB-only story ids
// can't render because tryById() only knows the static seed catalog.
// Curation will inherit this approach in its own follow-up; we ship
// the derived rails clean today.
//
// The card is intentionally NOT a poster art tile — the engagement
// signal IS the card. Showing the question + the split is what makes
// "Most divisive" recognizable on first glance. A user reading the
// homepage understands the rail's premise without a headline.

import Link from "next/link";
import type { PollRailKind, RailCardRow } from "@/lib/polls-shared";

interface PollRailCardProps {
  row: RailCardRow;
  /** Surface kind drives the footer copy (divisiveness vs agreement
   *  vs "your pick was minority") so the card reads as part of its
   *  specific rail. */
  kind: PollRailKind;
}

export function PollRailCard({ row, kind }: PollRailCardProps) {
  const href = row.slug ? `/v/${row.slug}` : `/v/${row.storyId}`;
  const pctA = Math.round(
    (row.votesA / Math.max(1, row.totalVotes)) * 100,
  );
  const pctB = 100 - pctA;
  return (
    <Link
      href={href}
      className="group relative block shrink-0 overflow-hidden rounded-lg border border-line bg-surface transition-transform duration-200 hover:scale-[1.03] hover:border-accent"
      style={{ width: 280 }}
    >
      {/* Subtle hero image as a textured backdrop so the card has
          visual weight beyond the text block. When the story has no
          hero we let the surface colour show through; the typography
          carries the card either way. */}
      {row.heroImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.heroImage}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover opacity-[0.18] transition-opacity duration-200 group-hover:opacity-25"
        />
      )}
      <div className="relative flex flex-col gap-3 p-4">
        {row.category && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            {row.category}
          </span>
        )}
        <h3 className="font-display text-[15px] font-bold leading-snug text-ink">
          {row.question}
        </h3>
        <div className="space-y-1.5">
          <SplitRow
            label={row.optionAText}
            pct={pctA}
            accent
          />
          <SplitRow label={row.optionBText} pct={pctB} accent={false} />
        </div>
        <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-muted">
          <span>{row.totalVotes.toLocaleString()} votes</span>
          <span>{kindFooter(kind, row.divisiveness)}</span>
        </div>
      </div>
    </Link>
  );
}

function SplitRow({
  label,
  pct,
  accent,
}: {
  label: string;
  pct: number;
  accent: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-[12px] text-ink">
        <span className="truncate">{label}</span>
        <span className="font-mono">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg/60">
        <div
          aria-hidden
          className={`h-full transition-[width] duration-500 ${
            accent ? "bg-accent" : "bg-line"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function kindFooter(kind: PollRailKind, divisiveness: number): string {
  if (kind === "divisive") return `${divisiveness.toFixed(2)} split`;
  if (kind === "agreed") return `${(1 - divisiveness).toFixed(2)} agreement`;
  return "your minority pick";
}
