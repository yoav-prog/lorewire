// Diff a current ShortConfig against the baseline short_render's props to
// pick the cheapest render lane that will produce a correct MP4.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (Lane A in Phase 2,
// Lane B in Phase 3, Lane C in Phase 4).
//
//   Lane noop  — nothing changed since the last render; no work to do.
//   Lane A     — captions text/timing changed; voice + frames identical.
//                Cost ≈ $0.05 (Cloud Run render only).
//   Lane B     — script or voice changed (implies new audio).
//                Cost ≈ $0.10 (TTS + render). [Phase 3]
//   Lane C     — frame urls or prompts changed (implies scene regen).
//                Cost ≈ $0.05 per touched scene + $0.05 render. [Phase 4]
//
// Priority when multiple categories changed: C > B > A. The most expensive
// touch wins because it subsumes the cheaper ones — a scene regen also
// re-renders the assembly, etc.

import "server-only";
import type { ShortConfig, ShortFrame } from "@/lib/short-config";

export type ShortRenderLane = "noop" | "A" | "B" | "C";

export interface ShortRenderPlan {
  lane: ShortRenderLane;
  /** Frame ids whose url or prompt diverges from the baseline. Empty on
   *  Lane A / B / noop; populated on Lane C. */
  touched_scene_ids: string[];
  /** Cheap estimate in cents (so cost copy in the UI matches reality
   *  closely enough that the admin can decide before clicking). */
  estimated_cost_cents: number;
  /** Per-category booleans the UI can show as a "what's changing" list. */
  diffs: {
    captions: boolean;
    script: boolean;
    voice: boolean;
    voiceover_url: boolean;
    frames: string[]; // touched frame ids
    /** True when the resolved intro or outro for THIS short differs from
     *  what the last successful render spliced. Drives a Lane A trigger
     *  on intro/outro override changes — the assembly re-renders with the
     *  new segment without touching the body of the short. */
    segments: boolean;
    /** True when the current poll (question + option labels) differs
     *  from what was baked into the last render's burnt-in question
     *  card. Also true when a poll was added or removed since the
     *  last render. Drives a Lane A trigger so the burnt-in card
     *  catches up to the on-site widget after an admin edit. */
    poll: boolean;
  };
  /** Human-readable rationale the UI surfaces next to the lane choice. */
  reason: string;
}

/** Currently-resolved 9:16 intro / outro for the short. Passed by the
 *  caller so the planner stays pure (no DB access). Null entries mean
 *  "no segment will splice" — either skip flag or resolver miss. */
export interface CurrentResolvedSegments {
  intro_segment_id: string | null;
  outro_segment_id: string | null;
}

/** Current poll fingerprint for the short. Phase 3 polish of
 *  _plans/2026-06-17-engagement-polls.md. The renderer bakes a
 *  question_card into the tail of every short whose story has an
 *  enabled poll; when the admin later edits the question or option
 *  labels the previously-rendered MP4 is now stale. Passing this in
 *  lets the planner trigger Lane A (assembly-only) on a poll edit —
 *  the body video stays identical, only the end card needs a new
 *  draw.
 *
 *  Null = no live poll on this story (or the poll was disabled);
 *  null with a baseline that had a card means the card should
 *  disappear — also a Lane A trigger. */
export interface CurrentPoll {
  question: string;
  option_a: string;
  option_b: string;
}

interface BaselineProps {
  doodle_frames?: unknown;
  captions?: unknown;
  voiceover_url?: unknown;
  voice?: unknown;
  script?: unknown;
  question_card?: unknown;
}

// Cost knobs. Per the plan; these are estimates the UI surfaces — the actual
// charge is set by the worker on completion. Centralized so a single tweak
// updates both the lane plan and any future cost-budget guards.
const LANE_A_CENTS = 5; // Cloud Run /render call
const LANE_B_CENTS = 10; // TTS + render
const LANE_C_PER_SCENE_CENTS = 5; // per-scene kie i2i
const LANE_C_ASSEMBLY_CENTS = 5; // render assembly after regen

export function planShortRender(
  current: ShortConfig,
  baselinePropsJson: string | null,
  currentSegments?: CurrentResolvedSegments,
  currentPoll?: CurrentPoll | null,
): ShortRenderPlan {
  const baseline = parseBaseline(baselinePropsJson);

  const captionsChanged = !sameCaptions(current.captions, baseline.captions);
  const scriptChanged = !sameScalar(current.script, baseline.script);
  const voiceChanged = !sameVoice(current.voice, baseline.voice);
  const voiceoverUrlChanged = !sameScalar(
    current.voiceover_url,
    baseline.voiceover_url,
  );
  const touchedFrames = diffFrames(current.doodle_frames, baseline.doodle_frames);
  // Caption style: if the editor has any caption_style override, it's a
  // Lane A trigger (assembly-only — frames/voice unchanged). Folded into
  // `captionsChanged` so the existing Lane A reason copy stays accurate.
  const styleChanged = hasCaptionStyleOverride(current.caption_style);
  const captionsOrStyleChanged = captionsChanged || styleChanged;
  // Segments: compare the resolved current pick against what the last
  // successful render spliced (stamped on short_config by the render
  // route). Drives Lane A on intro/outro override changes even when
  // captions/voice/frames are untouched. Skipped when caller didn't
  // supply currentSegments (back-compat for callers that haven't been
  // updated yet — they just lose the segment-change detection).
  const segmentsChanged = currentSegments
    ? !sameSegments(currentSegments, current._last_rendered_segments, current)
    : false;
  // Poll question card: compare current poll text against what was
  // baked into baseline.question_card. Phase 3 polish of
  // _plans/2026-06-17-engagement-polls.md. Lane A trigger because the
  // burnt-in card is a render-time projection — body video stays the
  // same length, only the tail frame needs a new draw. Skipped when
  // the caller passes `undefined` (back-compat for the existing test
  // suite that hasn't been updated yet).
  const pollChanged =
    currentPoll === undefined
      ? false
      : !sameQuestionCard(currentPoll, baseline.question_card);
  const captionsOrStyleOrSegmentsOrPollChanged =
    captionsOrStyleChanged || segmentsChanged || pollChanged;

  // Lane C wins when any frame diverges from the baseline (the editor's
  // per-scene regen has happened OR the user edited a prompt without a
  // regen click yet). For Phase 2 we detect it but the executable path
  // lands in Phase 4 — the UI surfaces the cost + "not implemented yet."
  if (touchedFrames.length > 0) {
    return {
      lane: "C",
      touched_scene_ids: touchedFrames,
      estimated_cost_cents:
        touchedFrames.length * LANE_C_PER_SCENE_CENTS + LANE_C_ASSEMBLY_CENTS,
      diffs: {
        captions: captionsChanged,
        script: scriptChanged,
        voice: voiceChanged,
        voiceover_url: voiceoverUrlChanged,
        frames: touchedFrames,
        segments: segmentsChanged,
        poll: pollChanged,
      },
      reason: `${touchedFrames.length} scene${
        touchedFrames.length === 1 ? "" : "s"
      } changed — needs per-scene regen + assembly`,
    };
  }

  // Lane B catches script + voice + audio-url changes.
  if (scriptChanged || voiceChanged || voiceoverUrlChanged) {
    return {
      lane: "B",
      touched_scene_ids: [],
      estimated_cost_cents: LANE_B_CENTS,
      diffs: {
        captions: captionsChanged,
        script: scriptChanged,
        voice: voiceChanged,
        voiceover_url: voiceoverUrlChanged,
        frames: [],
        segments: segmentsChanged,
        poll: pollChanged,
      },
      reason: scriptChanged
        ? "Script changed — needs voice resynthesis + assembly"
        : voiceChanged
          ? "Voice changed — needs voice resynthesis + assembly"
          : "Voiceover url changed — needs assembly with new audio",
    };
  }

  if (captionsOrStyleOrSegmentsOrPollChanged) {
    return {
      lane: "A",
      touched_scene_ids: [],
      estimated_cost_cents: LANE_A_CENTS,
      diffs: {
        captions: captionsChanged,
        script: false,
        voice: false,
        voiceover_url: false,
        frames: [],
        segments: segmentsChanged,
        poll: pollChanged,
      },
      // Reason priority: captions > caption-style > segments > poll.
      // Captions are the most "the viewer will notice"; the poll card
      // is the least disruptive change (only the 2.5s tail). Surfaces
      // the highest-impact reason first so the admin understands why
      // the re-render is suggested.
      reason: captionsChanged
        ? "Captions changed — assembly-only re-render"
        : styleChanged
          ? "Caption style changed — assembly-only re-render"
          : segmentsChanged
            ? "Intro/outro changed — assembly-only re-render"
            : "Poll question changed — re-render to update the burnt-in card",
    };
  }

  return {
    lane: "noop",
    touched_scene_ids: [],
    estimated_cost_cents: 0,
    diffs: {
      captions: false,
      script: false,
      voice: false,
      voiceover_url: false,
      frames: [],
      segments: false,
      poll: false,
    },
    reason: "No edits since the last successful render",
  };
}

/** True when the current poll matches what was baked into the
 *  baseline render's question card. Handles every combo of
 *  presence/absence:
 *    - both null   → same (nothing to render either way)
 *    - both set    → diff question + option_a + option_b
 *    - one set     → changed (card needs to appear or disappear)
 *  Whitespace is trimmed before comparing because the editor
 *  validator does the same trim on save — a trailing space the admin
 *  added shouldn't trigger a re-render. */
function sameQuestionCard(
  current: CurrentPoll | null,
  baseline: unknown,
): boolean {
  const baselineCard =
    baseline && typeof baseline === "object" && !Array.isArray(baseline)
      ? (baseline as {
          question?: unknown;
          option_a?: unknown;
          option_b?: unknown;
        })
      : null;
  if (!current && !baselineCard) return true;
  if (!current || !baselineCard) return false;
  const baseQ =
    typeof baselineCard.question === "string"
      ? baselineCard.question.trim()
      : "";
  const baseA =
    typeof baselineCard.option_a === "string"
      ? baselineCard.option_a.trim()
      : "";
  const baseB =
    typeof baselineCard.option_b === "string"
      ? baselineCard.option_b.trim()
      : "";
  return (
    current.question.trim() === baseQ &&
    current.option_a.trim() === baseA &&
    current.option_b.trim() === baseB
  );
}

function sameSegments(
  current: CurrentResolvedSegments,
  baseline: ShortConfig["_last_rendered_segments"],
  config: ShortConfig,
): boolean {
  if (baseline) {
    return (
      current.intro_segment_id === baseline.intro_segment_id &&
      current.outro_segment_id === baseline.outro_segment_id
    );
  }
  // No baseline stamped yet — either the short was rendered before the
  // stamping code shipped, or this is a brand-new short. We can't tell
  // for sure if the rendered MP4 already has the current segments. If
  // the admin set ANY per-short override (intro/outro pin or skip), they
  // clearly want it applied — surface Lane A so they can render. With
  // no override set we stay conservative (return "same") so a fresh
  // short doesn't false-positive into Lane A on every page load.
  const hasOverride =
    !!config.intro_segment_id ||
    !!config.outro_segment_id ||
    !!config.skip_intro ||
    !!config.skip_outro;
  return !hasOverride;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseBaseline(raw: string | null): BaselineProps {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BaselineProps;
    }
  } catch {
    // Unparseable baseline → treat as if no baseline exists. Lane decision
    // falls through to whichever category has changes; in practice the
    // captions / frames / script tests against `undefined` baseline will
    // all show as "changed" — that's the right behavior because we have
    // no proof the baseline matches and a re-render is cheap insurance.
  }
  return {};
}

function sameScalar<T>(a: T, b: unknown): boolean {
  if (a === undefined && (b === undefined || b === null)) return true;
  return a === b;
}

function sameVoice(
  a: ShortConfig["voice"],
  b: unknown,
): boolean {
  const ax = a ?? null;
  const bx =
    b && typeof b === "object" && !Array.isArray(b)
      ? (b as { provider?: unknown; voice_id?: unknown })
      : null;
  if (!ax && !bx) return true;
  if (!ax || !bx) return false;
  return ax.provider === bx.provider && ax.voice_id === bx.voice_id;
}

function sameCaptions(
  current: ShortConfig["captions"],
  baseline: unknown,
): boolean {
  if (!Array.isArray(baseline)) return current.length === 0;
  if (current.length !== baseline.length) return false;
  for (let i = 0; i < current.length; i++) {
    const c = current[i];
    const b = baseline[i] as
      | { start_ms?: unknown; end_ms?: unknown; text?: unknown }
      | null
      | undefined;
    if (!b || typeof b !== "object") return false;
    if (c.text !== b.text) return false;
    if (c.start_ms !== b.start_ms) return false;
    if (c.end_ms !== b.end_ms) return false;
  }
  return true;
}

// Returns the set of frame ids whose url or image_prompt diverges between
// the current config and the baseline. New frame ids in current (not in
// baseline) count as changed; missing-from-current frames don't (we only
// re-render what the editor has).
function hasCaptionStyleOverride(
  override: ShortConfig["caption_style"],
): boolean {
  if (!override) return false;
  return Object.values(override).some(
    (v) => typeof v === "string" && v.length > 0,
  );
}

function diffFrames(current: ShortFrame[], baseline: unknown): string[] {
  const baselineMap = new Map<string, { url: unknown; image_prompt: unknown }>();
  if (Array.isArray(baseline)) {
    for (const raw of baseline) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as { id?: unknown; url?: unknown; image_prompt?: unknown };
      if (typeof f.id === "string") {
        baselineMap.set(f.id, { url: f.url, image_prompt: f.image_prompt });
      }
    }
  }
  const touched: string[] = [];
  for (const f of current) {
    const b = baselineMap.get(f.id);
    if (!b) {
      touched.push(f.id);
      continue;
    }
    if (f.url !== b.url) {
      touched.push(f.id);
      continue;
    }
    const currentPrompt = f.image_prompt ?? null;
    const baselinePrompt =
      typeof b.image_prompt === "string" ? b.image_prompt : null;
    if (currentPrompt !== baselinePrompt) {
      touched.push(f.id);
    }
  }
  return touched;
}
