// Where does the brand intro sit inside a rendered story MP4? Every render
// splices the intro segment into the final file, but at a position that
// depends on the splice generation:
//
//   paced hook-first   [hook | fade+gap | intro | gap | body | outro]
//                      (2026-06-29 onward — props carry hook_end_ms AND
//                      hook_tail_hold_ms; the seams add black beats)
//   unpaced hook-first [hook | intro | body | outro]
//                      (the one-day 2026-06-28 generation — hook_end_ms
//                      without hook_tail_hold_ms; hard cuts, no pads)
//   intro-first        [intro | body | outro]
//                      (everything older, and long-form video)
//
// This module is the PURE half of the Skip Intro feature: the timeline math
// (mirroring video/server/ffmpeg.ts + render.ts, the same numbers Cloud Run
// splices with), the defensive props-JSON readers, and the client-side
// guards the players use. No data-layer imports — the DB-walking resolver
// lives in intro-window-resolve.ts so client components can import the
// types + guards from here without dragging server-only modules into the
// bundle. Plan: _plans/2026-07-04-skip-intro.md.

/** The skippable intro region in the FINAL MP4 timeline. `start_ms` is where
 *  hook/story content stops (the fade into the intro begins); `end_ms` is the
 *  seek target — the first moment of story content after the intro. */
export interface IntroWindow {
  start_ms: number;
  end_ms: number;
}

// ─── Paced-splice constants (ms) ──────────────────────────────────────────────
// Mirrors of video/server/ffmpeg.ts HOOK_FIRST_* (seconds there) and
// render.ts MIN_HOOK_AUDIO_TAIL_HOLD_SEC. If those change, a NEW render is
// unaffected (the dispatcher persists the window explicitly at render time);
// only the read-time derivation for old rows would drift — keep in sync.
export const INTRO_FADE_MS = 450;
export const INTRO_HOOK_GAP_MS = 1100;
export const INTRO_INTRO_GAP_MS = 900;
export const INTRO_TAIL_HOLD_FALLBACK_MS = 300;
export const INTRO_TAIL_HOLD_MIN_MS = 150;

/** The derived skip target must leave at least this much story after it —
 *  a window butting against the end of the file means the derivation is
 *  wrong for this row (constants drifted, odd render), so fail closed. */
const MIN_STORY_AFTER_INTRO_MS = 1_000;

/** Hide the button / stop auto-skipping this close to the window's end so a
 *  skip never becomes a zero-length seek. */
export const INTRO_WINDOW_END_SLACK_MS = 50;

export type SpliceGeneration =
  | "paced-hook-first"
  | "unpaced-hook-first"
  | "intro-first";

/** Which splice generation produced a row, judged by which hook fields its
 *  props carry. hook_end_ms and hook_tail_hold_ms shipped one day apart, so
 *  "hook boundary without a tail hold" pins the unpaced 2026-06-28 renders. */
export function classifySpliceGeneration(
  hookEndMs: number | null,
  hookTailHoldMs: number | null,
): SpliceGeneration {
  if (hookEndMs === null) return "intro-first";
  if (hookTailHoldMs === null) return "unpaced-hook-first";
  return "paced-hook-first";
}

export interface DeriveIntroWindowArgs {
  generation: SpliceGeneration;
  /** Required (> 0) for the hook-first generations; ignored for intro-first. */
  hookEndMs?: number | null;
  /** Paced only. Null → the splice's constant fallback hold; otherwise
   *  floored the same way Cloud Run floors it. */
  hookTailHoldMs?: number | null;
  /** video_segments.duration_ms of the spliced intro. */
  introDurationMs: number | null;
  /** Real MP4 length when known (props.assembled_duration_ms) — sanity clamp. */
  assembledDurationMs?: number | null;
}

/** Compute the intro window for one row. Returns null whenever the inputs
 *  can't support a confident answer — a missing button is harmless, a wrong
 *  jump into the story is a bug. */
export function deriveIntroWindow(
  args: DeriveIntroWindowArgs,
): IntroWindow | null {
  const introDur = positiveOrNull(args.introDurationMs);
  if (introDur === null) return null;

  let startMs: number;
  let endMs: number;
  if (args.generation === "intro-first") {
    startMs = 0;
    endMs = introDur;
  } else {
    const hookEnd = positiveOrNull(args.hookEndMs ?? null);
    if (hookEnd === null) return null;
    if (args.generation === "paced-hook-first") {
      const rawHold =
        typeof args.hookTailHoldMs === "number" &&
        Number.isFinite(args.hookTailHoldMs) &&
        args.hookTailHoldMs >= 0
          ? args.hookTailHoldMs
          : INTRO_TAIL_HOLD_FALLBACK_MS;
      const tailHold = Math.max(INTRO_TAIL_HOLD_MIN_MS, rawHold);
      startMs = hookEnd + tailHold;
      endMs =
        startMs + INTRO_FADE_MS + INTRO_HOOK_GAP_MS + introDur + INTRO_INTRO_GAP_MS;
    } else {
      startMs = hookEnd;
      endMs = hookEnd + introDur;
    }
  }

  const assembled = positiveOrNull(args.assembledDurationMs ?? null);
  if (assembled !== null && endMs + MIN_STORY_AFTER_INTRO_MS > assembled) {
    return null;
  }
  return { start_ms: Math.round(startMs), end_ms: Math.round(endMs) };
}

// ─── Props-JSON readers ───────────────────────────────────────────────────────
// stories.props is TEXT and may be NULL / malformed / from an older pipeline
// generation; every reader degrades to null silently (same contract as the
// duration.ts readers).

/** props.hook_end_ms — the cold-open hook boundary. Null unless a finite
 *  positive number (0 means "no hook", same as the dispatcher treats it). */
export function hookEndMsFromPropsJson(
  props: string | null | undefined,
): number | null {
  return positiveOrNull(numberField(props, "hook_end_ms"));
}

/** props.hook_tail_hold_ms — the per-video audio hold. Unlike hook_end_ms,
 *  0 is a VALID value (a hook that butts into the next line), so only
 *  missing / non-finite / negative becomes null. */
export function hookTailHoldMsFromPropsJson(
  props: string | null | undefined,
): number | null {
  const n = numberField(props, "hook_tail_hold_ms");
  if (n === null || !Number.isFinite(n) || n < 0) return null;
  return n;
}

/** The explicit window the dispatcher persists at render-finish
 *  (intro_start_ms / intro_end_ms). Ground truth when present — rows
 *  rendered after the Skip Intro feature shipped never need derivation. */
export function introWindowFromPropsJson(
  props: string | null | undefined,
): IntroWindow | null {
  const start = numberField(props, "intro_start_ms");
  const end = positiveOrNull(numberField(props, "intro_end_ms"));
  if (start === null || !Number.isFinite(start) || start < 0) return null;
  if (end === null || end <= start) return null;
  return { start_ms: Math.round(start), end_ms: Math.round(end) };
}

// ─── Player-side guards ───────────────────────────────────────────────────────

/** Belt-and-braces check against the REAL element duration once the browser
 *  knows it: a window whose seek target lands at/after the end of the file
 *  must never skip (or show a button that jumps to black). Null duration
 *  (metadata not loaded yet) → trust the server-resolved window. */
export function introWindowUsable(
  window: IntroWindow | null | undefined,
  videoDurationMs: number | null,
): window is IntroWindow {
  if (!window) return false;
  if (window.start_ms < 0 || window.end_ms <= window.start_ms) return false;
  if (videoDurationMs === null) return true;
  return window.end_ms + MIN_STORY_AFTER_INTRO_MS <= videoDurationMs;
}

/** Is playback time `tMs` inside the skippable region? The end is slacked so
 *  a skip is never a zero-length seek. */
export function isInIntroWindow(tMs: number, window: IntroWindow): boolean {
  return (
    tMs >= window.start_ms && tMs < window.end_ms - INTRO_WINDOW_END_SLACK_MS
  );
}

// ─── Internals ────────────────────────────────────────────────────────────────

function positiveOrNull(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function numberField(
  props: string | null | undefined,
  key: string,
): number | null {
  if (!props) return null;
  try {
    const parsed = JSON.parse(props) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const raw = parsed[key];
    return typeof raw === "number" ? raw : null;
  } catch {
    return null;
  }
}
