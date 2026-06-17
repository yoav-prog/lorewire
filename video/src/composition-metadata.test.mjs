// Contract guard for deriveCompositionMetadata's duration math, using Node's
// built-in runner (node:test). Run via:
//   node --test src/composition-metadata.test.mjs
//
// Node can't import the .ts source directly (extensionless imports), so — same
// convention as mouth-timing.test.mjs — we mirror the ONE line that matters in
// plain JS and assert the invariant the shorts outro fix depends on: the
// rendered body is `duration_ms + end_hold_ms` long, so it always covers the
// full narration (the Python side floors duration_ms at the real audio length)
// plus the post-roll hold before the outro splices on.
//
// Mirror of composition-metadata.ts:
//   renderedMs = max(1, (clipEnd ?? duration_ms) - (clipStart ?? 0)) + endHoldMs
//   durationInFrames = max(1, ceil(renderedMs / 1000 * FPS))

import { test } from "node:test";
import assert from "node:assert/strict";

const FPS = 30;

function durationInFrames(cfg) {
  const clipStart = cfg.clip_start_ms ?? 0;
  const clipEnd = cfg.clip_end_ms ?? cfg.duration_ms;
  const endHoldMs = Math.max(0, cfg.end_hold_ms ?? 0);
  const renderedMs = Math.max(1, clipEnd - clipStart) + endHoldMs;
  return Math.max(1, Math.ceil((renderedMs / 1000) * FPS));
}

test("end_hold extends the body past the narration", () => {
  // duration_ms is floored at the real audio length upstream, so an 8s body
  // means 8s of narration. The +1.5s hold must land entirely AFTER it.
  const withHold = durationInFrames({ duration_ms: 8000, end_hold_ms: 1500 });
  const noHold = durationInFrames({ duration_ms: 8000, end_hold_ms: 0 });
  assert.equal(noHold, Math.ceil((8000 / 1000) * FPS)); // 240 frames = 8.0s
  assert.equal(withHold, Math.ceil((9500 / 1000) * FPS)); // 285 frames = 9.5s
  assert.ok(withHold > noHold);
  // The body covers the narration with the full hold to spare.
  assert.ok(withHold / FPS >= 8000 / 1000 + 1.5 - 1e-9);
});

test("a missing end_hold is byte-identical to the pre-hold render", () => {
  assert.equal(
    durationInFrames({ duration_ms: 12345 }),
    durationInFrames({ duration_ms: 12345, end_hold_ms: 0 }),
  );
});
