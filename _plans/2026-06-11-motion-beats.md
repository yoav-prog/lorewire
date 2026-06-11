# Wave 3 Phase 3 (slice 1): non-Atlas motion beats

Date: 2026-06-11
Status: in progress

## Goal

Ship the three composition-only motion beats that don't need an
external image editor. PropSlideIn and MouthSwap are deferred to
follow-up sessions because they need real pipeline work (prop
generation + mouth-removal vendor).

| Beat | Decision |
|---|---|
| `MicroWiggle` | Ship |
| `LabelPopOn` | Ship |
| `ScribbleDraw` | Ship |
| `PropSlideIn` | Defer (needs prop generation pipeline) |
| `MouthSwap` | Defer (needs kie.ai edit model wired) |

Per-beat behavior is algorithmic, not LLM-planned. Each beat is gated
by an admin setting (off by default). When all three are off, renders
are byte-identical to today's output.

## Settings

Three new keys on the existing `settings` table:

- `video.micro_wiggle` (truthy = "1" / "true" / "on" / "yes", default off)
- `video.label_pop` (same parser)
- `video.scribble_draw` (same parser)

Admin gets one new fieldset on `/admin/settings` next to the existing
`video.ken_burns` row.

## Pipeline

- `pipeline/video.py` reads the three flags via the existing
  truthy-string parser, packs them into `props.motion`:
  ```json
  {"motion": {"micro_wiggle": false, "label_pop": false, "scribble_draw": false}}
  ```
- One new test case per flag confirming the parser; reuses the existing
  truthy-string list.

## Composition

Three new components alongside `DoodleFrameImg`:

- **`MicroWiggle`** — wraps the existing `<Img>` with a tiny sinusoidal
  rotation + translate driven by `useCurrentFrame()` and a per-frame
  seed. Subtle: max 0.6 degrees and 2px. Composes on top of any
  Ken-Burns transform (transforms stack as separate CSS functions in
  the order: scale -> translate -> rotate -> wiggle-translate).
- **`LabelPopOn`** — for each caption chunk, when `label_pop` is on,
  render a small bold label that pops in at the chunk's `start_ms`
  with the chunk's first word. Position cycles through 4 corners by
  chunk index. Animates with a 100ms scale-from-0.5 entry, holds
  through the chunk, fades out over the last 80ms.
- **`ScribbleDraw`** — at the start of each scene window, draws a
  hand-doodled SVG curve over 800ms using `stroke-dasharray` /
  `stroke-dashoffset` interpolation. Corner of the curve cycles by
  scene index. Doesn't compete with the main scene image because the
  scribble lives in a thin corner band.

Each component reads its own enabled flag from
`config.motion.<flag>` so a missing flag falls back to off.

`DoodleShort.tsx` mounts:
- `MicroWiggle` inside the existing `Sequence` per frame (wrapping the
  image render).
- `ScribbleDraw` as a sibling of the image inside each `Sequence` —
  on top of the image but below the caption band.
- `LabelPopOn` outside the frame `Sequence`s, in a layer between frames
  and the caption band. Driven by `activeCaption` like the existing
  `DoodleCaption` is.

## Tests

- Three pipeline cases: `_resolve_motion_flags` parses truthy strings
  per flag; missing returns False; case-insensitive.
- No render tests (visual). One real backfill render verifies the
  beats are visible.

## Observability

- `pipeline/video.py` logs `[video id=<id> motion]
  micro_wiggle=<bool> label_pop=<bool> scribble_draw=<bool>` so a
  surprising render can be traced back to which flags were on.

## QA plan

1. Tests stay green.
2. TSC + prod build clean.
3. Set all three flags via the admin and re-render envelope.
4. Visually verify: caption + frame still look right, plus the wiggle
   is barely visible, the label pops on each chunk, the scribble draws
   in a corner at each scene start.

## Deferred follow-ups

- **PropSlideIn**: LLM picks a prop keyword per shot, kie generates a
  cutout PNG, pipeline stores per-shot prop URLs, composition mounts
  the slide-in. Roughly half a day.
- **MouthSwap**: character ref image + kie edit model for mouth removal
  + mouth shape library + phoneme-driven swap. ~2-3 days with the kie
  edit pricing confirmed first.
