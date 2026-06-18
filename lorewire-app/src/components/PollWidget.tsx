"use client";

// Public-facing engagement-poll widget. Phase 2 of
// _plans/2026-06-17-engagement-polls.md.
//
// Shared between /v/[slug] and the article reader so both surfaces
// render the same component with the same vote contract. The parent
// server component does the fetching (poll row + aggregate +
// has-this-cookie-already-voted) and passes everything in as props;
// this component owns the click → fetch → reveal flow.
//
// State machine:
//   initialVotedSide=null + total<floor   → "Be one of the first to vote"
//                                            + two buttons.
//   initialVotedSide=null + total>=floor  → two buttons (results stay
//                                            hidden until the user
//                                            decides — no peek-then-
//                                            skip).
//   initialVotedSide set OR just-voted    → percentages + total +
//                                            "You picked X" pill.
//
// The pre-vote-with-existing-floor case is intentional: if we showed
// percentages before they voted, the lazy user would skim them and
// bounce. Hiding the result until commit IS the engagement primitive.

import { useState, useTransition } from "react";
// Phase 2 of _plans/2026-06-17-engagement-polls.md. Client component
// imports from `polls-shared` so Turbopack doesn't pull the server-
// only db driver into the browser bundle. See the comment at the
// top of lib/polls.ts.
import type { PollResultView, PollSide } from "@/lib/polls-shared";

interface PollWidgetProps {
  /** 2026-06-18 standalone-article polls (plan §15): the widget
   *  identifies the POLL directly, not the subject. The parent
   *  server-resolves the poll row and passes the id in. Lets one
   *  widget serve both story polls and article polls without
   *  branching on subject kind. */
  pollId: string;
  question: string;
  optionA: string;
  optionB: string;
  /** Server-rendered initial result so the post-vote percentages
   *  paint without a hydration flash. Null when the poll has no
   *  votes yet (the widget renders the pre-vote state regardless). */
  initialResult: PollResultView | null;
  /** Which side the requesting cookie has already chosen on this
   *  poll, if any. Drives the initial render — when set, the widget
   *  lands in the post-vote state immediately. */
  initialVotedSide: PollSide | null;
  /** Phase 4 of _plans/2026-06-17-engagement-polls.md. Optional
   *  follow-up story shown under the post-vote state. The parent
   *  page resolves it server-side from the same-category Divisive
   *  rail, excluding the current story; passing null hides the
   *  link. The pair captures "after voting X, I clicked Y" — the
   *  raw signal V3 personalization will eventually consume. */
  followUp?: { href: string; title: string } | null;
}

type VotedSide = PollSide | null;

export function PollWidget({
  pollId,
  question,
  optionA,
  optionB,
  initialResult,
  initialVotedSide,
  followUp = null,
}: PollWidgetProps) {
  const [votedSide, setVotedSide] = useState<VotedSide>(initialVotedSide);
  const [result, setResult] = useState<PollResultView | null>(initialResult);
  const [pending, startVote] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function castVote(side: PollSide): void {
    if (pending || votedSide) return;
    setError(null);
    // Optimistic: paint the post-vote state immediately. The fetch
    // patches the percentages on response; on failure we revert.
    const prevSide = votedSide;
    const prevResult = result;
    setVotedSide(side);
    startVote(async () => {
      try {
        const resp = await fetch("/api/polls/vote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ pollId, side }),
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
          setError(data.error ?? `Vote failed (${resp.status})`);
          return;
        }
        setResult(data.result);
      } catch (err) {
        setVotedSide(prevSide);
        setResult(prevResult);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const totalVotes = result?.totalVotes ?? 0;
  const hasFloor = result?.hasFloor ?? false;
  const pctA = result?.pctA ?? 0;
  const pctB = result?.pctB ?? 0;
  const showResults = Boolean(votedSide);

  return (
    <section
      aria-label="Story poll"
      data-testid="poll-widget"
      className="rounded-2xl border border-line bg-surface p-5"
    >
      <h2 className="font-display text-[18px] font-bold leading-snug text-ink">
        {question}
      </h2>

      {!showResults ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <PollButton
              label={optionA}
              disabled={pending}
              onClick={() => castVote("A")}
            />
            <PollButton
              label={optionB}
              disabled={pending}
              onClick={() => castVote("B")}
            />
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-muted">
            {hasFloor
              ? `${totalVotes.toLocaleString()} votes so far — pick a side to reveal the split.`
              : "Be one of the first to vote."}
          </p>
        </>
      ) : (
        <div className="mt-4 space-y-3">
          <PollResultRow
            label={optionA}
            pct={pctA}
            highlighted={votedSide === "A"}
            hasFloor={hasFloor}
          />
          <PollResultRow
            label={optionB}
            pct={pctB}
            highlighted={votedSide === "B"}
            hasFloor={hasFloor}
          />
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
            {hasFloor
              ? `${totalVotes.toLocaleString()} votes`
              : `${totalVotes.toLocaleString()} vote${totalVotes === 1 ? "" : "s"} — percentages reveal once more voters chime in.`}{" "}
            · You picked{" "}
            <span className="text-ink">
              {votedSide === "A" ? optionA : optionB}
            </span>
            .
          </p>

          {followUp && (
            <a
              href={followUp.href}
              className="group mt-1 flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-4 py-3 text-[14px] text-ink transition-colors hover:border-accent"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  See another close call
                </span>
                <span className="font-semibold leading-snug">
                  {followUp.title}
                </span>
              </span>
              <span
                aria-hidden
                className="text-[18px] text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
              >
                →
              </span>
            </a>
          )}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-cat-entitled/40 bg-cat-entitled/10 px-3 py-2 text-[12px] text-cat-entitled"
        >
          {error}
        </p>
      )}
    </section>
  );
}

function PollButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl border border-line bg-bg px-5 py-3 text-[15px] font-semibold text-ink transition-colors hover:border-accent hover:bg-surface2 focus:outline-none focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function PollResultRow({
  label,
  pct,
  highlighted,
  hasFloor,
}: {
  label: string;
  pct: number;
  highlighted: boolean;
  hasFloor: boolean;
}) {
  // Width of the inline progress bar mirrors pct on a floor-met poll;
  // pre-floor we show a flat track with no fill so a freshly-voted
  // 100%/0% never gets advertised.
  const width = hasFloor ? `${Math.max(0, Math.min(100, pct))}%` : "0%";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={
            highlighted
              ? "font-semibold text-ink"
              : "text-ink"
          }
        >
          {label}
          {highlighted && (
            <span className="ml-2 rounded-full border border-accent/50 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent">
              Your pick
            </span>
          )}
        </span>
        <span className="font-mono text-[13px] text-ink">
          {hasFloor ? `${pct}%` : "—"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg">
        <div
          aria-hidden
          className={`h-full transition-[width] duration-500 ${
            highlighted ? "bg-accent" : "bg-line"
          }`}
          style={{ width }}
        />
      </div>
    </div>
  );
}
