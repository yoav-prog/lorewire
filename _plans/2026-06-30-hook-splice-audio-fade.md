# 2026-06-30 — Hook-first splice: smooth audio at the body→intro cut

## Goal

Stop clipping the last word of the cold-open hook when the TTS runs the
hook line directly into the next sentence (gap = 0 case). The
`assembled_duration_ms = 37184` render for `idea_a744e0a033b0` ("Her
wedding dress was destroyed") cuts the "d" in "destroyed" before its
decay finishes, because PR #166's gap-sized tail-hold computed 0 for
this story (no silence between sentences in the TTS output) and the
splice cut the body audio hard at the caption boundary.

## Why D, not A or C

- **A — minimum hold floor.** Floors `tailHoldSec` at e.g. 120 ms.
  Bleeds up to 120 ms of next sentence's first syllable into the held
  frame. Subtle but real artifact in the other direction.
- **C — two-cut splice (visual vs. audio).** Decouples
  `hookVideoEndSec` (caption boundary) from `hookAudioEndSec` (word +
  decay). When `gap = 0`, even C can only either bleed next sentence or
  clip the previous word — the audio overlap is baked into the TTS
  output. C is the right answer for the rare case where the snap moved
  the visual cut significantly *earlier* than the natural word end, but
  it doesn't solve `gap = 0` cleanly.
- **D — audio crossfade at the cut.** Add an `afade=t=out` on the
  body_hook tail (last ~80 ms before the cut). The consonant decays
  smoothly into silence instead of being hard-clipped. No bleed (audio
  goes to silence, not into next sentence). No video/audio desync.

D fixes every `gap = 0` story we render going forward; C lands later as
a separate PR for the snap-moved-visual-cut case.

## Constraints

- **No pipeline / dispatcher / data-model changes.** D is a pure ffmpeg
  argv change in `video/server/ffmpeg.ts`. The existing `tailHoldSec`,
  `hookEndSec`, `fadeSec`, `hookGapSec`, `introGapSec` semantics stay
  unchanged.
- **No regression for stories with a natural gap.** When the body
  audio at the cut is already silence, fading out silence is a no-op.
- **No regression for the non-hook-first path** (`hookFirstActive =
  false` — legacy `[intro][body][outro]`). The fade only applies inside
  `hookFirstPacedFilter`.
- **Cap the fade duration so it never extends past the natural audio
  end.** Body_hook audio plays for `hookEndSec + tailHoldSec`. The
  fade-out can't begin before t=0. Clamp the fade duration to
  `min(audioFadeSec, hookEndSec + tailHoldSec)` so a very short hook
  (< 80 ms — unlikely but possible) doesn't generate a negative
  `afade` start time.

## Concrete change

### `video/server/ffmpeg.ts`

1. New constant: `HOOK_FIRST_AUDIO_TAIL_FADE_SEC = 0.08` (80 ms).
   Co-located with the other `HOOK_FIRST_*` seam constants. Sized for
   natural consonant decay (typical 'd', 't', 'k' release is ~50–80
   ms); long enough to mask a hard cut, short enough to feel like the
   word ended naturally.

2. In `hookFirstPacedFilter`, for `i === 0` (body_hook), insert an
   `afade=t=out` BEFORE the existing `apad` so the fade is applied to
   the body audio before silence padding is appended:

   ```
   [0:a:0]afade=t=out:st=<aEnd - audioFadeSec>:d=<audioFadeSec>,apad=pad_dur=<...>[pa0]
   ```

   Where `aEnd = hookEndSec + tailHoldSec` (the existing computed value
   — the natural end of body_hook's body audio before silence padding).

   Effective fade duration = `min(audioFadeSec, aEnd)` — clamp so a
   pathologically short hook doesn't generate a negative `st`.

### What does NOT change

- Video path on body_hook (trim + freeze + fade-out + black-pad) is
  byte-identical.
- Audio path on body_rest, intro, outro is byte-identical.
- The `tailHoldSec` semantics (gap-sized) stay PR #166's design.
- Non-paced hook-first path (no fade/gap seams) — unchanged.
- The legacy `[intro][body][outro]` splice — unchanged.

## Tests

Three new cases in `video/server/ffmpeg.test.mjs`:

1. **`hookFirstPacedFilter` includes `afade=t=out` on body_hook audio
   when paced is active.** Asserts the substring
   `afade=t=out:st=<computed>:d=0.08` appears in the filter graph
   between `[0:a:0]` and the `apad`.

2. **The afade `st` is `aEnd - audioFadeSec` for typical values.**
   E.g. `hookEndSec = 2.0`, `tailHoldSec = 0` (the user's case) →
   `aEnd = 2.0` → `st = 1.92`.

3. **For a pathologically short hook (`hookEndSec + tailHoldSec <
   audioFadeSec`), the fade duration clamps to `aEnd` and `st = 0`.**
   No negative start time reaches ffmpeg.

Plus regression coverage: assert the non-paced hook-first path (no
fade seams) and the legacy non-hook-first path don't carry the new
filter — only `hookFirstPacedFilter` does.

## Observability

The existing `[cloud-run splice ffmpeg]` log line already dumps the
full argv to Cloud Run logs, so the new filter shape is visible in
production without any code change. No new log line needed.

## Security

No security surface change. Pure ffmpeg filter argv edit. No input
parsing, no new dependency, no new env var.

## Deploy

- Lives in `video/server/`. Requires a Cloud Run redeploy (`npm
  --prefix video run deploy:cloud-run`) to take effect.
- The Next-app side is untouched.
- No data migration. The fix takes effect on the very next render
  after Cloud Run picks up the new revision.

## Follow-up — option C (separate PR)

Decoupled `hookVideoEndSec` / `hookAudioEndSec` cuts. Bigger surface
(pipeline + dispatcher + Cloud Run + data model). Handles the case
where `_extend_first_scene_over_hook` moves the visual cut earlier
than the natural word end, AND the natural word end falls before the
next sentence starts — i.e., there IS a gap but the snap moved the
visual cut into the previous word. D doesn't address that. To be
written as `_plans/2026-06-30-hook-splice-two-cut.md` and PR'd after
this lands and gets confirmed in production.
