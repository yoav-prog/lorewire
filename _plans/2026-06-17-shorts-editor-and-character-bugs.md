# Shorts: three bugs (base-as-scene, stale editor captions, same character)

**Date:** 2026-06-17
**Status:** Approved + implementing

Three issues reported against the shorts editor / render. All three root-caused.

## Bug 1 — base reference image rendered as the first scene (actual video)

`shorts.generate_short_assets` makes a `base_url`: a neutral full-body standing
pose on a plain background. It exists ONLY as the i2i reference that keeps the
character identical across scene frames. But
[shorts_render.build_short_props](pipeline/shorts_render.py) prepends it to
`sources` as the opening frame (planned index 0), so the bare reference shot
leads every short.

Compounding it: `build_short_props` never writes `character_base_url` into props,
so the base frame at `doodle_frames[0]` is currently the only record of the
reference. Removing it naively would break Lane C per-scene regen (which reads
`short_config.character_base_url`).

**Fix:** stop staging the base as a visible frame; instead store it as
`props.character_base_url`. `defaultShortConfig` already reads
`props.character_base_url`, so the editor + Lane C keep the identity anchor.
Clamp the first real scene to caption index 0 so the short still opens at t=0
(DoodleShort windows frame 0 from its caption's start_ms).

Existing shorts keep the baked-in base frame until a full (Lane A / Restart)
re-render runs the fixed `build_short_props`. Lane B/C reuse baseline frames, so
they cannot drop a legacy base frame — call out the one-time full re-render.

## Bug 2 — captions wrong in the editor after a voice re-render (editor only)

The render is correct; only the editor preview + Captions tab show stale
captions. `short_config.captions` is the editor's source of truth, seeded once
from the baseline render and only updated by manual caption edits. A Lane B
voice re-render regenerates captions from the new alignment into the new
`short_renders.props` but never writes them back to `short_config`, so the editor
keeps showing the old captions while the MP4 is right.

**Fix:** after a Lane B build, sync the three voice-driven fields
(`captions`, `voiceover_url`, `duration_ms`) from the new props into
`short_config`. This only fires on the voice path, so it cannot clobber pending
manual caption edits (those flow through Lane A, which already writes config
first). Done in the generation drain right after `store_short_props`, via a
best-effort helper in `shorts_lane_b` (a sync failure must not fail the render).

## Bug 3 — same character on every short (regression)

`DOODLE_SUFFIX` (appended to the base prompt and every scene prompt in
[shorts_image_style.py](pipeline/shorts_image_style.py)) hard-codes the
character's identity: "lab coats... ties in blue or red, beards / hair in gray,
round glasses with thin frames, defined eyebrows..." plus a CHARACTER ANATOMY
block that keeps mentioning glasses. The style suffix is dictating WHO the
character is, so every story converges on the same glasses-wearing figure
regardless of the planner's per-story character description.

**Fix:** strip the character-IDENTITY specifics from the suffix, keep the
ART-STYLE direction (line quality, color palette, no-text/no-bubble rule,
hands). Identity comes from the planner's per-story `character` description,
which already flows into both the base and scene prompts. This is a visible
style change and should be eyeballed on a fresh render.

## Tests

- `build_short_props` props carry `character_base_url` and `doodle_frames` no
  longer include the base (cover via a focused unit test that stubs the network
  generation + voice).
- `_map_frames` first frame is clamped to caption index 0.
- Lane B caption sync writes captions/voiceover_url/duration_ms into short_config
  and leaves other fields intact; it no-ops when short_config is absent.
- `DOODLE_SUFFIX` no longer contains the identity tokens (round glasses / lab
  coats / ties / beards) — a guard test so the regression can't silently return.

## Out of scope

- Migrating existing shorts to drop their baked-in base frame (needs one full
  re-render each; not auto-migrated).
- A full short_config reseed after a from-scratch Restart render (separate gap).
