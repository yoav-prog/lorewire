"use client";

// Per-wire engagement-poll surface. Lives inside the WireCard control bar,
// directly above the title row, so the question + answer options sit in a
// clear visual wrapper — the request that originated this plan
// (_plans/2026-06-25-wires-poll-wrapper.md). Companion to the floating
// VOTE pill (`WirePollPill`) over the video.
//
// State machine (mirrors PollWidget):
//   initialVotedSide=null + total<floor       → "Be one of the first" + 2 buttons
//   initialVotedSide=null + total>=floor      → vote count tease + 2 buttons
//   initialVotedSide set OR optimistic vote   → animated bars + verdict kicker
//
// Visual language: dark surface that sits cleanly inside the WireCard's
// black control bar; thin amber→blue gradient strip on the left edge
// signals "two-sided poll" before the user reads a word; buttons keep the
// brand-typography display font; the user's pick after vote gets the
// brand accent red so the poll still feels like Lorewire. Animations are
// pure Tailwind transitions — no motion library — so the bundle stays
// small and the interaction respects prefers-reduced-motion via the
// transition-*-reduce pattern Tailwind already applies.

import { useState, useTransition } from "react";
import type {
  PollResultView,
  PollSide,
  WirePollData,
} from "@/lib/polls-shared";

export interface WirePollPanelProps {
  /** The story id the poll belongs to. Threaded through to the vote flow
   *  so the post-vote Top-10 signal credits the right story (mirrors the
   *  pattern in PollWidget). */
  storyId: string;
  poll: WirePollData;
  /** Bumped by the parent (WireCard) when it wants the panel to flash a
   *  hint — e.g. the floating pill was tapped while the panel was visible.
   *  Re-rendering with a new value triggers a one-shot pulse on the
   *  buttons so the eye lands here. */
  pulseNonce?: number;
  /** Fired after a successful vote AND before the result paints. Lets
   *  the parent flip its floating-pill state from "vote" → "% agree"
   *  without subscribing to the panel's internal state. */
  onVoted?: (side: PollSide, result: PollResultView) => void;
}

type VotedSide = PollSide | null;

export function WirePollPanel({
  storyId,
  poll,
  pulseNonce = 0,
  onVoted,
}: WirePollPanelProps) {
  const [votedSide, setVotedSide] = useState<VotedSide>(poll.initialVotedSide);
  const [result, setResult] = useState<PollResultView | null>(poll.initialResult);
  const [pending, startVote] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function castVote(side: PollSide): void {
    if (pending || votedSide) return;
    setError(null);
    const prevSide = votedSide;
    const prevResult = result;
    // Optimistic paint of the post-vote state. The fetch patches the
    // percentages on response; revert on failure.
    setVotedSide(side);
    console.info("[wires poll vote start]", { pollId: poll.pollId, side });
    startVote(async () => {
      try {
        const resp = await fetch("/api/polls/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ pollId: poll.pollId, side }),
        });
        const data = (await resp.json()) as {
          ok?: boolean;
          inserted?: boolean;
          result?: PollResultView;
          error?: string;
        };
        if (!resp.ok || !data.ok || !data.result) {
          setVotedSide(prevSide);
          setResult(prevResult);
          console.warn("[wires poll vote error]", {
            pollId: poll.pollId,
            status: resp.status,
            body_error: data.error,
          });
          setError("Couldn't record your vote. Try again in a moment.");
          return;
        }
        setResult(data.result);
        console.info("[wires poll vote result]", {
          pollId: poll.pollId,
          inserted: Boolean(data.inserted),
          pctA: data.result.pctA,
          pctB: data.result.pctB,
          totalVotes: data.result.totalVotes,
        });
        onVoted?.(side, data.result);
        // Top 10 ranking signal (mirrors PollWidget). Dynamic import keeps
        // the server-action module out of the panel's initial bundle.
        if (data.inserted) {
          import("@/app/actions")
            .then((m) => m.recordStoryEventAction(storyId, "poll_vote"))
            .catch(() => {
              /* event emit is best-effort */
            });
        }
      } catch (err) {
        setVotedSide(prevSide);
        setResult(prevResult);
        console.warn("[wires poll vote network-error]", {
          pollId: poll.pollId,
          err: String(err),
        });
        setError("Couldn't reach the server. Check your connection.");
      }
    });
  }

  const totalVotes = result?.totalVotes ?? 0;
  const hasFloor = result?.hasFloor ?? false;
  const pctA = result?.pctA ?? 0;
  const pctB = result?.pctB ?? 0;
  const showResults = Boolean(votedSide);

  // Post-vote verdict copy. Skipped when the floor hasn't been reached —
  // no honest majority to claim yet.
  const verdict = (() => {
    if (!showResults || !hasFloor || !votedSide) return null;
    const userPct = votedSide === "A" ? pctA : pctB;
    if (userPct >= 60) return "You're with the majority.";
    if (userPct <= 40) return "You're in the minority.";
    return "It's a close call.";
  })();

  return (
    <section
      aria-label="Story poll"
      data-testid="wire-poll-panel"
      data-pulse={pulseNonce}
      className="relative overflow-hidden rounded-2xl border border-line bg-[#0e0e10]"
    >
      {/* Two-sided accent strip on the left edge. Amber→blue gradient
          signals "two opinions" before the user reads a word — without
          screaming color across the whole card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
        style={{
          background:
            "linear-gradient(180deg, #F59E0B 0%, #F59E0B 48%, #3B82F6 52%, #3B82F6 100%)",
        }}
      />

      <div className="px-4 py-3.5">
        {/* Kicker row: small uppercase mono, identifies the surface and
            (when the floor is met) shows the vote count for trust. */}
        <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[.22em] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            POLL · {showResults ? "Your verdict" : "You decide"}
          </span>
          {hasFloor && (
            <span className="tabular-nums text-ink/70">
              {totalVotes.toLocaleString()} votes
            </span>
          )}
        </div>

        {/* Question — big, brand-voice display type. Two lines max so the
            panel height stays predictable inside the control bar. */}
        <h3 className="mt-2 line-clamp-2 font-display text-[15.5px] font-black uppercase leading-[1.15] tracking-tight text-ink">
          {poll.question}
        </h3>

        {!showResults ? (
          <WirePollChoices
            optionA={poll.optionA}
            optionB={poll.optionB}
            pending={pending}
            pulseNonce={pulseNonce}
            onVote={castVote}
          />
        ) : (
          <WirePollResults
            optionA={poll.optionA}
            optionB={poll.optionB}
            pctA={pctA}
            pctB={pctB}
            votedSide={votedSide}
            hasFloor={hasFloor}
          />
        )}

        {/* Footer microcopy — pre-vote: floor tease, post-vote: verdict. */}
        <p className="mt-3 font-mono text-[10px] uppercase tracking-[.18em] text-muted">
          {!showResults
            ? hasFloor
              ? "Tap a side to reveal the split."
              : "Be one of the first to vote."
            : hasFloor
              ? verdict
              : `${totalVotes.toLocaleString()} vote${
                  totalVotes === 1 ? "" : "s"
                } — split reveals once more voters chime in.`}
        </p>

        {error && (
          <p
            role="alert"
            className="mt-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 font-body text-[11px] text-accent"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/* ─── Pre-vote: two thumb-zone buttons side by side ─────────────────────── */

function WirePollChoices({
  optionA,
  optionB,
  pending,
  pulseNonce,
  onVote,
}: {
  optionA: string;
  optionB: string;
  pending: boolean;
  pulseNonce: number;
  onVote: (side: PollSide) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <WirePollChoiceButton
        side="A"
        label={optionA}
        accentHex="#F59E0B"
        disabled={pending}
        pulseNonce={pulseNonce}
        onClick={() => onVote("A")}
      />
      <WirePollChoiceButton
        side="B"
        label={optionB}
        accentHex="#3B82F6"
        disabled={pending}
        pulseNonce={pulseNonce}
        onClick={() => onVote("B")}
      />
    </div>
  );
}

function WirePollChoiceButton({
  side,
  label,
  accentHex,
  disabled,
  pulseNonce,
  onClick,
}: {
  side: PollSide;
  label: string;
  accentHex: string;
  disabled: boolean;
  pulseNonce: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // The whole video stage above is a single tap target (play/pause),
        // and the WireCard control bar is its sibling, but we still stop
        // propagation defensively so a stray double-tap doesn't bubble up
        // and like the wire when the user means to vote.
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      data-side={side}
      // 48px min-height matches Apple/Material's thumb-zone guidance;
      // padding lets the label breathe without bloating panel height.
      className="group relative flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-line bg-bg/50 px-3 py-2 text-center text-ink transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0 active:scale-[.98] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        // Inline because the option hues are deliberately outside the
        // brand token palette — they're poll-only and live alongside the
        // accent strip's amber→blue split.
        borderColor: `${accentHex}55`,
        boxShadow: `inset 0 0 0 1px ${accentHex}22`,
      }}
    >
      {/* Pulse ring re-triggers whenever pulseNonce changes (the pill
          taps "view the poll" while the panel is on-screen). Pure CSS
          animation — runs once per nonce update. The keyframe uses
          `currentColor` for the ring hue so we set `color` to the
          option accent here. */}
      <span
        key={pulseNonce}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl opacity-0"
        style={{
          color: accentHex,
          animation:
            pulseNonce > 0 ? "wire-poll-pulse 900ms ease-out 1" : undefined,
        }}
      />
      <span
        aria-hidden
        className="font-mono text-[9px] uppercase tracking-[.22em]"
        style={{ color: accentHex }}
      >
        {side}
      </span>
      <span className="line-clamp-1 font-display text-[13px] font-bold uppercase leading-tight tracking-tight">
        {label}
      </span>
    </button>
  );
}

/* ─── Post-vote: stacked result bars with animated fill ─────────────────── */

function WirePollResults({
  optionA,
  optionB,
  pctA,
  pctB,
  votedSide,
  hasFloor,
}: {
  optionA: string;
  optionB: string;
  pctA: number;
  pctB: number;
  votedSide: VotedSide;
  hasFloor: boolean;
}) {
  return (
    <div className="mt-3 space-y-2">
      <WirePollResultRow
        side="A"
        label={optionA}
        pct={pctA}
        accentHex="#F59E0B"
        highlighted={votedSide === "A"}
        hasFloor={hasFloor}
      />
      <WirePollResultRow
        side="B"
        label={optionB}
        pct={pctB}
        accentHex="#3B82F6"
        highlighted={votedSide === "B"}
        hasFloor={hasFloor}
      />
    </div>
  );
}

function WirePollResultRow({
  side,
  label,
  pct,
  accentHex,
  highlighted,
  hasFloor,
}: {
  side: PollSide;
  label: string;
  pct: number;
  accentHex: string;
  highlighted: boolean;
  hasFloor: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const width = hasFloor ? `${clamped}%` : "0%";
  return (
    <div
      data-side={side}
      data-highlighted={highlighted}
      className="relative overflow-hidden rounded-xl border border-line bg-bg/40 px-3 py-2.5"
      style={{
        borderColor: highlighted ? accentHex : undefined,
        boxShadow: highlighted ? `inset 0 0 0 1px ${accentHex}66` : undefined,
      }}
    >
      {/* Animated fill bar. Width transition gives the satisfying "result
          reveal" without dragging in a motion library. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-700 ease-out"
        style={{
          width,
          background: highlighted
            ? `linear-gradient(90deg, ${accentHex}40 0%, ${accentHex}22 100%)`
            : `${accentHex}18`,
        }}
      />
      <div className="relative flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full font-display text-[10px] font-black uppercase tracking-tight"
          style={{
            background: highlighted ? accentHex : "transparent",
            color: highlighted ? "#0e0e10" : accentHex,
            border: highlighted ? "none" : `1px solid ${accentHex}88`,
          }}
        >
          {side}
        </span>
        <span className="flex-1 truncate font-display text-[13px] font-bold uppercase leading-tight tracking-tight text-ink">
          {label}
        </span>
        {highlighted && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-[8.5px] font-bold uppercase tracking-[.18em] text-bg">
            You
          </span>
        )}
        <span
          className="font-display text-[15px] font-black tabular-nums tracking-tight text-ink"
          style={{ color: highlighted ? accentHex : undefined }}
        >
          {hasFloor ? `${clamped}%` : "—"}
        </span>
      </div>
    </div>
  );
}
