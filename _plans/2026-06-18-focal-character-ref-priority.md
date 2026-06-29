# Focal-character ref priority for sub-characters

**Date:** 2026-06-18
**Branch:** `feat/multi-platform-shorts-publisher`
**Trigger:** User reported THE STEAK STANDOFF's wife looks visibly different in scenes 2, 8, 12. Inspected prod DB: wife reference image exists, scenes correctly pass her ref to kie, but kie's nano-banana-2 honours position-1 refs strongly and position-2+ refs drift. The plan (`_plans/2026-06-14-world-bible-and-reference-images.md`) flagged this exact failure mode as council blind spot #1.

## Goal

When a scene's narrative subject is a sub-character (e.g. the wife "jabs a finger"), promote that sub-character's reference image to the strongest anchor position in the kie `image_input` list, even if the protagonist also appears in the scene. The protagonist stays in the ref set (still locked) but cedes the position-1 anchor.

## Non-goals

- No new image generation. The wife already gets a parity-quality ref via `_build_supporting_char_ref_prompt` (same `COMPOSITION_PREFIX` + `DOODLE_SUFFIX` as protagonist's `base_url`). The cost difference for this fix is **$0**.
- No mouth-removal pass for sub-characters. Mouth-removal exists only for protagonist talking-head compositing between scenes — it doesn't influence scene-gen consistency, so adding it to sub-characters wastes $0.05/sub-char with no quality gain.
- No model swap. `kie/nano-banana-pro` is the user's documented Option 2 ($0.60/video extra). We're doing Option 1 first.

## Approach

1. **Planner emits `focal_character` per scene.** Extend the JSON schema in `build_plan_prompt` (pipeline/shorts.py) so each scene carries an optional `focal_character` field: the name (matching the `supporting_characters[].name` snake_case) of the most visually prominent on-screen character for that beat. Omitted = main character is focal (current behaviour).

2. **`_resolve_scene_refs` honours focal.** Change the ref ordering rule:
   - If `focal_character` is set AND it's a known supporting-char name → push that sub-char's ref FIRST, then `base_url` (protagonist), then remaining supporting chars, then locations, then items.
   - Otherwise → current ordering (base_url first).
   - Cap unchanged (`INPUT_URLS_MAX`).

3. **`_gen_one` threads it through.** Extract `focal_character` from the scene dict and pass to `_resolve_scene_refs`.

4. **Graceful fallback.** Unknown `focal_character` name (planner typo, name drift) → fall back to protagonist-first ordering. No crash.

## Files to edit

- `pipeline/shorts.py` — `build_plan_prompt` (new schema field + instruction), `_resolve_scene_refs` (signature + ordering), `_gen_one` (pass focal through).
- `pipeline/tests/test_shorts_planner.py` — extend the existing `_resolve_scene_refs` test class with focal-aware cases.

## Schema delta

The plan JSON gains one optional per-scene field:

```jsonc
"scenes": [
  {
    "caption_chunk_start_index": 0,
    "scene": "the wife jabs a finger at the steak",
    "characters": ["wife"],
    "locations": ["home_kitchen"],
    "items": ["steak"],
    "focal_character": "wife"   // NEW — name from supporting_characters[], optional
  }
]
```

## Settings audit (rule 15)

No new user-facing knob. The ordering is automatic. Could later add `video.focal_character_priority` if A/B testing shows this hurts protagonist-focal scenes, but the failure mode it solves (sub-char drift) is unambiguous — no settings control needed v1.

## Observability (rule 14)

`_resolve_scene_refs` already logs nothing today. Add a debug log when focal-priority kicks in so a future "wife still drifting" debug session can confirm whether the reorder happened:

```
[shorts ref order] story=<id> scene=<i> focal=<name> refs=[<order>]
```

Logged at INFO level via `print` (matches the rest of `pipeline/shorts.py` logging style).

## Security (rule 13)

No new attack surface. The planner LLM output is already trusted (admin-curated stories). Unknown `focal_character` names are silently ignored, not echoed into prompts.

## Testing (rule 18)

Extend `pipeline/tests/test_shorts_planner.py:_resolve_scene_refs` tests with:

- `test_focal_character_promotes_supporting_to_position_1` — focal_character="wife", scene has wife + base → refs = [wife_ref, base, ...].
- `test_focal_character_unknown_falls_back_to_default` — focal_character="ghost", scene has wife + base → refs = [base, wife_ref, ...] (graceful).
- `test_focal_character_main_character_keeps_default` — focal_character omitted → refs = [base, wife_ref, ...] (current behaviour preserved).
- `test_focal_character_locations_and_items_still_appended` — focal_character="wife", scene has wife + kitchen + steak → refs = [wife_ref, base, kitchen_ref, steak_ref].

All run via `py -m pytest pipeline/tests/test_shorts_planner.py`.

## Cost (rule 8)

$0 marginal per video. Pure reordering. No new kie / LLM calls. Confirmed by reading `pipeline/shorts.py`: the supporting-char ref is already generated for every named sub-char regardless of focal.

## Rollout

Backwards-compatible. Scenes generated by the old planner (no `focal_character` field) → fall back to current ordering. New planner emits the field, new ref-builder honours it. No data migration. No setting to flip. Ships when the next short is regenerated.
