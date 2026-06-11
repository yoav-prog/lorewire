# Wave 3 Phase 3 (slice 3): MouthSwap motion beat

Date: 2026-06-11
Status: in progress

## Goal

Fifth and final motion beat: a small talking-head overlay where the
character's mouth swaps between a few shapes to match the narration. Lands
in a corner of the frame so it sits on top of the existing scenes without
replacing them — closer to a podcast-streamer overlay than a full lip-sync
animation rig.

## Honest scope

The full "phoneme-driven lip sync" (what yt-studio's paint_explainer_v1
does with mouth-removed PNGs + viseme alignment + Atlas character cache)
is multi-week. This slice ships a meaningfully smaller v1:

- ONE talking-head character image per story (the existing cinematic poster
  is fine — we can generate a tight bust shot for the protagonist).
- Mouth removed via kie's image-edit model — the alternative-to-Atlas
  decision the user made for Phase 3.
- Five SVG mouth shapes (closed / narrow open / wide open / round-O /
  pursed-MM) hand-drawn in code, not generated. Keeps cost at zero per
  shape and the shapes deterministically tile across the frame.
- Phoneme proxy: NO real phoneme analysis. Use the existing alignment word
  timings to cycle through "open" shapes during words and snap to closed
  between words. Reads as "talking" without needing CMUdict / ASR phones.
- Mouth anchor: fixed at a known position in the character image
  (the pipeline generates the character framed so the mouth is at a known
  spot — roughly center-X, ~62% down). No per-image vision pass yet.
- Corner overlay only — small bust shot (~280px wide) bottom-left or
  bottom-right. Doesn't replace the scene, doesn't fill the frame.

This trades fidelity for a shippable beat: viewers see lip-flap on a
talking head, not perfect lip sync. If we want phoneme-accurate sync later,
the slot is the same; we just swap the cycle logic for CMUdict-driven
viseme selection.

## Decisions (locked)

- **Storage**: two new columns — `character_image` (URL to the original
  talking-head bust) and `character_image_mouth_removed` (URL to the
  edited version). Both null when the beat hasn't been generated. The
  pipeline only generates them when `video.mouth_swap` is enabled.
- **kie edit model**: verify via Context7 / kie docs whether the
  `nano-banana-edit` (or `gpt-image-1-edit`) endpoint exists and what its
  cost is. Block the whole slice on a real test call before wiring the
  pipeline. If kie doesn't expose a usable edit endpoint, fall back to
  OpenAI's `images.edit` (we already have OPENAI_API_KEY) — same shape,
  different vendor.
- **Mouth shapes**: hand-drawn SVG paths, not generated PNGs. ~5 shapes
  in a single file `video/src/motion/mouths.ts` returning a record
  `{ closed, ah, ee, oh, mm }` of JSX path elements. Color matches the
  detected skin tone from the character image — for v1 we hardcode a
  neutral skin red-pink and let it look like an illustration, not photoreal.
- **Anchor**: hardcoded `{ cx: 0.50, cy: 0.62 }` (relative to the character
  image). The pipeline's character-generation prompt instructs gpt-image-2
  to compose the bust with the mouth at that position so the anchor is
  predictable. Per-image anchor detection (a kie/gemini vision pass) is a
  follow-up.
- **Timing**: open during word, closed during pauses > 200ms.
  Cycle through 3 open shapes (`ah → ee → oh`) every 90ms while open so
  the lip-flap has variety. No real phoneme matching.
- **Corner position**: bottom-left, ~280px wide. Reuses the same safe-zone
  inset (96px) the other motion beats use.

## Pipeline

- `pipeline/stages.py` adds `make_character_prompt(idea, body)` returning a
  single image prompt for a tight character bust — instructs gpt-image-2 on
  composition (mouth at ~62%, neutral background, single character, doodle
  ink style consistent with scenes).
- `pipeline/media.py` adds a `_mouth_swap_block()` step (gated on the
  `video.mouth_swap` setting):
  1. Generate the character bust at 1:1 via the existing `_generate_with_retry`.
  2. Call the kie edit model with a prompt like "remove the mouth, replace
     with neutral skin in the same style". Persist as
     `character_image_mouth_removed`.
  3. Both URLs land in the row.
  Cost: ~$0.05 (character) + ~$0.05 (edit) per story = ~$0.10 / story when
  the beat is on.
- `pipeline/store.py` adds two TEXT columns (additive).
- `pipeline/video.py` reads both URLs + the alignment, packs `character`
  block into `props.character`.

## Composition

- `video/src/motion/mouths.ts` exports five SVG path strings + a width/height.
- `video/src/motion/MouthSwap.tsx` renders the character image and overlays
  one mouth shape positioned at the configured anchor for the current
  elapsed time. Reads:
    - `enabled`: from `motion.mouth_swap`.
    - `characterUrl`: the mouth-removed image, falls back to original.
    - `words`: alignment words (start/end ms).
    - Computes active shape per frame from word boundaries + a 90ms cycle
      through open shapes during words.
- `DoodleShort.tsx` mounts `MouthSwap` AFTER the caption layer so the
  talking head sits in front of scenes but behind the caption band.
  Positioned bottom-left, 280px wide.

## Admin

- New `/admin/settings` row: `video.mouth_swap` (truthy parser, default off).
- Same `--media` run that generates props also generates the character +
  mouth-removed pair when this is on. No separate trigger.

## Tests

- `pipeline/tests/test_video.py`: scope-chain tests already cover the
  motion flag plumbing. Add 1 case verifying `_mouth_swap_enabled` parses
  truthy strings (parity with the other motion flags).
- No render tests. Visual QA covers the composition.

## QA plan

1. Verify the kie edit endpoint exists before wiring anything — single
   curl call to the kie task endpoint with a known model id, real cost.
2. Type-check + production build pass.
3. Generate envelope's character + mouth-removed pair manually.
4. Render envelope with `video.mouth_swap=1`. Frame extracts at three
   talking moments should show three different open shapes; at a pause
   should show the closed shape.

## Risks

- **kie edit model availability**: if the model doesn't exist or the cost
  doesn't make sense, fall back to OpenAI `images.edit` (same shape).
  Decision point captured in the "Decisions" block above.
- **Anchor accuracy**: hardcoded anchor will be wrong for character poses
  that don't follow the brief. Mitigation: include explicit composition
  instructions in the character-generation prompt; if it still wobbles,
  add a per-image Gemini vision pass to detect the mouth (~$0.0005 per
  call).
- **Visual quality of "lip-flap"**: without real phoneme matching, the
  mouth motion will look approximate. Acceptable for a v1 doodle short;
  not acceptable for a realistic talking head. If it looks bad, the
  fallback is to leave the beat off and ship without it.

## Deferred

- Per-character mouth-removed asset cache (yt-studio-style character
  cache). Currently each story generates fresh.
- Real phoneme alignment (use a viseme dictionary or forced alignment
  with explicit phones). Would need to either upgrade STT model or
  preprocess the audio through a phone-level aligner like MFA.
- Multiple characters in one story.
