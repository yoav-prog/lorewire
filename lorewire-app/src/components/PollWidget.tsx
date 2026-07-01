"use client";

// Public-facing engagement-poll widget. Phase 2 of
// _plans/2026-06-17-engagement-polls.md.
//
// Shared between /v/[slug], the article reader, and the homepage
// DetailModal (DesktopShell + AppShell). The parent resolves the
// poll row + aggregate + has-this-cookie-already-voted server-side
// and passes everything in as props; this component owns the
// click → fetch → reveal flow.
//
// State machine:
//   initialVotedSide=null + total<floor   → "Be one of the first" + duel tiles
//   initialVotedSide=null + total>=floor  → vote count tease + duel tiles
//                                            (percentages stay hidden until
//                                            commit — no peek-then-skip)
//   initialVotedSide set OR just-voted    → result bars + verdict kicker
//
// Visual language (2026-06-19 redesign): "duel" layout with a center
// VS chip pre-vote, animated full-width bars post-vote, and a
// verdict kicker telling the user where they landed in the split.
// Built for the homepage DetailModal where the widget has to look
// like it belongs next to the cinematic hero, not a SaaS form.

import { useState, useTransition } from "react";
// Phase 2 of _plans/2026-06-17-engagement-polls.md. Client component
// imports from `polls-shared` so Turbopack doesn't pull the server-
// only db driver into the browser bundle. See the comment at the
// top of lib/polls.ts.
import type { PollResultView, PollSide } from "@/lib/polls-shared";
import { markVotedStory } from "@/lib/voted-stories";

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
  /** Phase 1 of _plans/2026-06-25-top10-ranking.md. When the poll is
   *  attached to a story (the common case in the home detail modal),
   *  passing the story id wires the post-vote success path to emit a
   *  `poll_vote` event so the Top 10 ranking can credit the story.
   *  Article-only polls leave this undefined. */
  storyId?: string;
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
  storyId,
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
          // Server error strings ("forbidden origin", "rate limited",
          // "poll not available") are operator-facing diagnostics, not
          // user copy. Map to a single user-friendly line and log the
          // raw text once for ops. The error label was previously
          // rendering "forbidden origin" verbatim on prod when
          // NEXT_PUBLIC_SITE_ORIGIN was unset on Vercel — the
          // server-side cause is operator action, not user action.
          console.warn("[polls vote ui error]", {
            status: resp.status,
            body_error: data.error,
          });
          setError("Couldn't record your vote. Try again in a moment.");
          return;
        }
        setResult(data.result);
        // Reactive vote overlay: drop this story from the "You Didn't Vote
        // Yet" rail this session, no refresh (lib/voted-stories). Marked on
        // any successful vote (not just `inserted`) so a re-vote stays
        // consistent with the server seed; idempotent. Article-only polls
        // have no storyId and skip it.
        if (storyId) markVotedStory(storyId);
        // Top 10 ranking signal (Phase 1 of
        // _plans/2026-06-25-top10-ranking.md). Story polls credit the
        // story; article-only polls have no storyId and skip the emit.
        if (storyId && data.inserted) {
          import("@/app/actions")
            .then((m) => m.recordStoryEventAction(storyId, "poll_vote"))
            .catch(() => {
              /* event emit is best-effort */
            });
        }
      } catch (err) {
        setVotedSide(prevSide);
        setResult(prevResult);
        console.warn("[polls vote ui network-error]", {
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

  // Kicker copy used post-vote: tells the user where they landed.
  // Tuned so it never reads as condescending — small typography,
  // factual phrasing. Skipped when the floor hasn't been reached
  // (no honest majority to claim yet).
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
      data-testid="poll-widget"
      className="relative overflow-hidden rounded-2xl border border-line bg-surface"
      style={{
        backgroundImage:
          "radial-gradient(120% 95% at 85% 0%, rgba(232,70,43,.10), transparent 55%), radial-gradient(80% 60% at 0% 100%, rgba(232,70,43,.06), transparent 60%)",
      }}
    >
      {/* Hairline accent strip at the top — small but instantly readable
          as "this section means something." */}
      <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-accent via-accent/70 to-transparent" />

      <div className="px-5 py-6 sm:px-7 sm:py-7">
        {/* Kicker row — small uppercase mono, gives the widget identity
            and tells the user up front what they're looking at. */}
        <div className="flex items-center justify-between gap-3 font-mono text-[10.5px] uppercase tracking-[.22em] text-muted">
          <span className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            {showResults ? "Your verdict" : "You decide"}
          </span>
          {hasFloor && (
            <span className="tabular-nums text-ink/70">
              {totalVotes.toLocaleString()} votes
            </span>
          )}
        </div>

        {/* Question — big, brand-voice display type. Tracks tight to
            match the rest of the modal headings. */}
        <h2 className="mt-3 font-display text-[22px] font-black uppercase leading-[1.05] tracking-tight text-ink sm:text-[26px]">
          {question}
        </h2>

        {!showResults ? (
          <DuelTiles
            optionA={optionA}
            optionB={optionB}
            pending={pending}
            onVote={castVote}
          />
        ) : (
          <ResultStack
            optionA={optionA}
            optionB={optionB}
            pctA={pctA}
            pctB={pctB}
            votedSide={votedSide}
            hasFloor={hasFloor}
          />
        )}

        {/* Footer line. Pre-vote: floor tease. Post-vote: verdict kicker. */}
        <p className="mt-5 font-mono text-[11px] uppercase tracking-[.18em] text-muted">
          {!showResults
            ? hasFloor
              ? "Pick a side to reveal the split."
              : "Be one of the first to vote."
            : hasFloor
              ? verdict
              : `${totalVotes.toLocaleString()} vote${totalVotes === 1 ? "" : "s"} — split reveals once more voters chime in.`}
        </p>

        {followUp && showResults && (
          <a
            href={followUp.href}
            className="group mt-5 flex items-center justify-between gap-3 rounded-xl border border-line bg-bg/60 px-4 py-3 text-ink transition-colors hover:border-accent hover:bg-bg"
          >
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[.18em] text-muted">
                Next close call
              </span>
              <span className="font-display text-[15px] font-bold uppercase leading-tight tracking-tight">
                {followUp.title}
              </span>
            </span>
            <span
              aria-hidden
              className="text-[20px] text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
            >
              →
            </span>
          </a>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 font-body text-[12px] text-accent"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/* ─── Pre-vote duel: two big tiles with a VS chip between them. ─── */

function DuelTiles({
  optionA,
  optionB,
  pending,
  onVote,
}: {
  optionA: string;
  optionB: string;
  pending: boolean;
  onVote: (side: PollSide) => void;
}) {
  return (
    <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-stretch gap-3 sm:gap-4">
      <DuelTile
        letter="A"
        label={optionA}
        disabled={pending}
        onClick={() => onVote("A")}
      />
      <div
        aria-hidden
        className="flex items-center justify-center"
      >
        <span className="font-display text-[12px] font-black uppercase tracking-[.2em] rounded-full border border-line bg-bg/80 px-2.5 py-1 text-muted">
          VS
        </span>
      </div>
      <DuelTile
        letter="B"
        label={optionB}
        disabled={pending}
        onClick={() => onVote("B")}
      />
    </div>
  );
}

function DuelTile({
  letter,
  label,
  disabled,
  onClick,
}: {
  letter: "A" | "B";
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group relative flex flex-col items-center justify-center gap-2 rounded-xl border border-line bg-bg/60 px-3 py-5 text-center text-ink transition-all duration-150 hover:-translate-y-0.5 hover:border-accent hover:bg-bg active:translate-y-0 active:scale-[.99] focus:outline-none focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60 sm:py-6"
    >
      <span className="font-mono text-[10px] uppercase tracking-[.22em] text-muted transition-colors group-hover:text-accent">
        Side {letter}
      </span>
      <span className="font-display text-[16px] font-black uppercase leading-tight tracking-tight sm:text-[18px]">
        {label}
      </span>
      <span
        aria-hidden
        className="mt-1 font-mono text-[9.5px] uppercase tracking-[.22em] text-muted opacity-0 transition-opacity group-hover:opacity-100"
      >
        Tap to vote
      </span>
    </button>
  );
}

/* ─── Post-vote: stacked result rows with animated bars. ─── */

function ResultStack({
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
    <div className="mt-5 space-y-3">
      <ResultRow
        letter="A"
        label={optionA}
        pct={pctA}
        highlighted={votedSide === "A"}
        hasFloor={hasFloor}
      />
      <ResultRow
        letter="B"
        label={optionB}
        pct={pctB}
        highlighted={votedSide === "B"}
        hasFloor={hasFloor}
      />
    </div>
  );
}

function ResultRow({
  letter,
  label,
  pct,
  highlighted,
  hasFloor,
}: {
  letter: "A" | "B";
  label: string;
  pct: number;
  highlighted: boolean;
  hasFloor: boolean;
}) {
  // Width of the inline progress bar mirrors pct on a floor-met poll;
  // pre-floor we show a flat track with no fill so a freshly-voted
  // 100%/0% never gets advertised.
  const clamped = Math.max(0, Math.min(100, pct));
  const width = hasFloor ? `${clamped}%` : "0%";
  return (
    <div
      className={`relative overflow-hidden rounded-xl border px-4 py-3 transition-colors ${
        highlighted
          ? "border-accent/60 bg-accent/[.06]"
          : "border-line bg-bg/40"
      }`}
    >
      {/* Animated fill bar sits behind the row content. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-700 ease-out ${
          highlighted ? "bg-accent/25" : "bg-ink/[.08]"
        }`}
        style={{ width }}
      />
      <div className="relative flex items-center gap-3">
        <span
          aria-hidden
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display text-[12px] font-black uppercase tracking-tight ${
            highlighted
              ? "bg-accent text-bg"
              : "border border-line bg-bg/70 text-ink/70"
          }`}
        >
          {letter}
        </span>
        <span className="flex-1 truncate font-display text-[15px] font-bold uppercase leading-tight tracking-tight text-ink sm:text-[16px]">
          {label}
        </span>
        {highlighted && (
          <span className="font-mono text-[9.5px] uppercase tracking-[.22em] text-accent">
            Your pick
          </span>
        )}
        <span
          className={`font-display text-[18px] font-black tabular-nums tracking-tight sm:text-[20px] ${
            highlighted ? "text-accent" : "text-ink/70"
          }`}
        >
          {hasFloor ? `${clamped}%` : "—"}
        </span>
      </div>
    </div>
  );
}
