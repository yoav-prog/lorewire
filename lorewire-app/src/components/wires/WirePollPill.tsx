"use client";

// Floating poll affordance over the WireCard video stage. Two states:
//
//   pre-vote  → "POLL · VOTE" with a pulsing accent dot. Signals "there
//               is something to do here" without covering the artwork.
//   voted     → ambient social proof — the user's pick + the % of voters
//               who agreed (or just a "VOTED" check when the poll hasn't
//               crossed the public floor yet). Sits steady, no pulse.
//
// Tapping the pill either side calls the parent's `onClick` so the
// WireCard can request the panel below to flash (see WirePollPanel's
// `pulseNonce` prop). Keyboard activation (Enter / Space) is the default
// button behavior — no custom handling needed.
//
// Plan: _plans/2026-06-25-wires-poll-wrapper.md.

import type { PollResultView, PollSide } from "@/lib/polls-shared";

export interface WirePollPillProps {
  /** Side this viewer has voted on, if any. Drives pre-vote vs voted
   *  rendering. Null = pre-vote. */
  votedSide: PollSide | null;
  /** Server-resolved (or just-fetched) result view. Null when the poll
   *  has no votes yet — pre-vote pill stays in the "VOTE" state, and a
   *  fresh post-vote pill falls back to the "VOTED" check until the
   *  parent patches the result in. */
  result: PollResultView | null;
  /** Fired on tap. Parent uses this to flash the panel below (which
   *  contains the answer buttons or result bars). */
  onClick: () => void;
}

// Hue tokens kept in sync with WirePollPanel's per-side accents so the
// pill's "% agreed" badge color matches the bar the user picked.
const OPTION_HEX: Record<PollSide, string> = {
  A: "#F59E0B",
  B: "#3B82F6",
};

export function WirePollPill({ votedSide, result, onClick }: WirePollPillProps) {
  const voted = votedSide !== null;
  const hasFloor = result?.hasFloor ?? false;
  // The user's % is what we show post-vote — honest about whether their
  // pick was majority or minority. We never invert to make the user feel
  // they "won"; the badge color carries the side, the number is the truth.
  const userPct = voted
    ? votedSide === "A"
      ? result?.pctA ?? 0
      : result?.pctB ?? 0
    : 0;
  const accentHex = voted ? OPTION_HEX[votedSide] : "var(--color-accent)";

  return (
    <button
      type="button"
      onClick={(e) => {
        // The video stage owns play/pause via its own pointer handlers;
        // a stray bubble-up would toggle playback on every pill tap.
        e.stopPropagation();
        console.info("[wires poll pill click]", {
          state: voted ? "results" : "vote",
        });
        onClick();
      }}
      aria-label={
        voted
          ? hasFloor
            ? `Your side is at ${userPct}% — view full results`
            : "You voted — view full results"
          : "Vote on this poll"
      }
      data-state={voted ? "voted" : "vote"}
      className="group inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-ink active:scale-95 transition-all duration-150"
      style={{
        background: "rgba(0,0,0,.55)",
        backdropFilter: "blur(6px)",
        // Subtle accent border so the pill reads as a control, not chrome.
        boxShadow: voted
          ? `inset 0 0 0 1px ${accentHex}66`
          : "inset 0 0 0 1px rgba(232, 70, 43, .55)",
      }}
    >
      {!voted ? (
        <>
          <span
            aria-hidden
            className="relative inline-grid h-2 w-2 place-items-center"
          >
            {/* Pulsing dot — the "this needs your attention" signal. */}
            <span
              className="wire-poll-pill-pulse absolute inset-0 rounded-full bg-accent"
            />
            <span className="relative h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="font-mono text-[10px] font-bold uppercase tracking-[.22em]">
            POLL · VOTE
          </span>
        </>
      ) : (
        <>
          <span
            aria-hidden
            className="grid h-4 w-4 place-items-center rounded-full"
            style={{ background: accentHex }}
          >
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none">
              <path
                d="m5 12 5 5L20 7"
                stroke="#0e0e10"
                strokeWidth={3.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span
            className="font-mono text-[10px] font-bold uppercase tracking-[.22em] tabular-nums"
            style={{ color: accentHex }}
          >
            {hasFloor ? `${userPct}%` : "VOTED"}
          </span>
        </>
      )}
    </button>
  );
}
