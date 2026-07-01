"use client";

// Runs the multi-tag reclassification dry-run (admin-gated server action) and
// renders the coverage report: how many stories land confidently, the review
// queue, the confidence spread, and per-category primary coverage. Writes
// nothing — this is the artifact to review before applying. Mirrors the
// BackfillButton pattern. Plan: _plans/2026-07-01-category-taxonomy-multitag.md.

import { useState, useTransition } from "react";
import { dryRunReclassifyTagsAction } from "./actions";
import type { TagReport } from "@/lib/reclassify-tags";

export function ReclassifyDryRunButton() {
  const [running, start] = useTransition();
  const [report, setReport] = useState<TagReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function onClick(): void {
    setErr(null);
    start(async () => {
      try {
        setReport(await dryRunReclassifyTagsAction());
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">
            Multi-tag coverage dry-run
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Classifies every story into the new categories and reports what it
            would do. Writes nothing. This can take up to a minute while it
            calls the model per story.
          </p>
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={running}
          className="shrink-0 rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {running ? "Classifying…" : "Run dry-run"}
        </button>
      </div>

      {report && (
        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-2 gap-2 font-mono text-[11px] text-muted sm:grid-cols-4">
            <Cell label="Stories" value={report.total} />
            <Cell label="Auto-tagged" value={report.autoTagged} accent />
            <Cell label="Review queue" value={report.reviewQueue} warn={report.reviewQueue > 0} />
            <Cell label="Floor" value={report.confidenceFloor} />
          </dl>

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Confidence
            </p>
            <dl className="grid grid-cols-3 gap-2 font-mono text-[11px] text-muted">
              <Cell label="High (≥0.8)" value={report.confidenceBuckets.high} />
              <Cell label="Mid (0.6-0.8)" value={report.confidenceBuckets.mid} />
              <Cell label="Low (<0.6)" value={report.confidenceBuckets.low} />
            </dl>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Primary category coverage
            </p>
            {Object.keys(report.primaryCounts).length === 0 ? (
              <p className="text-[12px] text-muted">
                None — check that the 17 categories are seeded and the model
                key is set.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 font-mono text-[12px] text-ink sm:grid-cols-2">
                {Object.entries(report.primaryCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([slug, n]) => (
                    <li key={slug} className="flex items-center justify-between gap-2 border-b border-line/60 py-0.5">
                      <span className="truncate">{slug}</span>
                      <span className="text-muted">{n}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          {report.reviewQueue > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Review queue ({report.reviewQueue}) — the model couldn&apos;t place
                these confidently
              </p>
              <ul className="space-y-0.5 text-[12px] text-muted">
                {report.proposals
                  .filter((p) => p.needsReview)
                  .slice(0, 25)
                  .map((p) => (
                    <li key={p.id} className="truncate">
                      {p.title || p.id}
                      {p.primary ? (
                        <span className="text-muted/70">
                          {" "}
                          — best guess {p.primary} ({p.primaryConfidence.toFixed(2)})
                        </span>
                      ) : (
                        <span className="text-muted/70"> — no match</span>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {err && (
        <p className="mt-3 rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-2 text-[12px] text-cat-entitled">
          {err}
        </p>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: number;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="uppercase tracking-wider">{label}</dt>
      <dd
        className={
          warn
            ? "font-display text-[16px] font-bold text-cat-entitled"
            : accent
              ? "font-display text-[16px] font-bold text-accent"
              : "font-display text-[16px] font-bold text-ink"
        }
      >
        {typeof value === "number" && Number.isInteger(value)
          ? value.toLocaleString()
          : value}
      </dd>
    </div>
  );
}
