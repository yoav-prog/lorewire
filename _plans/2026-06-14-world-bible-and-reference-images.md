# Option C — World bible + reference-image scene gen

**Date:** 2026-06-14
**Status:** Approved by user. Council ran and recommended Option B; user
overruled and locked Option C. Council blind spots noted in Risks.

## Goal

Visual consistency across scene images. Characters, sub-characters,
locations, and items get stable IDs and a structured "bible" persisted
on the story. Characters (and optionally locations) get one canonical
reference image up front. Every scene call passes the relevant refs to
`kie/nano-banana-2`, which conditions on the image input so faces stay
recognizably the same scene to scene. The hero image draws from the
same bible, so the lead character on the cover matches the lead in the
video.

## Files I expect to touch (rough)

- `pipeline/world_bible.py` (new) — schema, build, persist, read/write.
- `pipeline/stages.py` — new `build_world_bible` LLM call + parser;
  `make_scene_prompts_from_bible` replaces grounded path for bible-aware
  scene gen.
- `pipeline/images.py` — extend `generate()` to accept `image_input`
  list so nano-banana-2 ref calls flow through the same retry/cost
  metering wrapper.
- `pipeline/media.py` — bible build + ref-image gen on first scenes
  regen; scene prompts pass refs through to kie; hero gen reuses the
  same character refs.
- `pipeline/aspect.py` — no change.
- `lorewire-app/src/lib/world-bible.ts` (new) — TS mirror types for the
  admin client.
- `lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx` — read the
  bible and render the inspection panel.
- `lorewire-app/src/app/admin/(panel)/_components/WorldBiblePanel.tsx`
  (new) — bible inspection UI (read-only v1 + "rebuild bible" button).
- `lorewire-app/src/app/admin/(panel)/settings/page.tsx` — settings
  for `video.scene_image_model` + bible toggles.
- Tests for every new pure helper and integration path.

## Schema

```jsonc
// On stories.video_config.world_bible
{
  "built_with": "world_bible_v1",
  "characters": [
    {
      "id": "char_001",
      "name": "Maya",
      "role": "lead" | "supporting" | "background",
      "visual_cues": "early 30s woman, dark curly hair in messy bun, oversized glasses, navy cardigan",
      "reference_image_url": "https://storage.googleapis.com/.../char_001.png"
    }
  ],
  "sub_characters": [ /* same shape as characters, role usually background */ ],
  "locations": [
    {
      "id": "loc_001",
      "name": "open_plan_office",
      "visual_cues": "fluorescent-lit cubicles, beige carpet, late afternoon",
      "reference_image_url": null  // optional in v1
    }
  ],
  "items": [
    {
      "id": "item_001",
      "name": "envelope",
      "visual_cues": "thick manila envelope, slightly worn, marker-addressed"
    }
  ]
}
```

Per-scene entity tagging: each `doodle_frames[i]` gets an optional
`bible_entity_ids: string[]` so the regen path knows which refs to pass
to kie when re-rendering that scene.

## Flow

1. **Bible build** (one LLM call on first scene gen or admin "rebuild"):
   - Prompt the LLM with article body + headline.
   - Return JSON with characters/sub_characters/locations/items as above.
   - Validate, assign IDs (`char_001`...), cap counts (chars ≤4, subchars
     ≤4, locations ≤3, items ≤5).
2. **Reference image gen** (one kie call per character + per location
   marked with `needs_ref: true`):
   - For each character, prompt `kie/nano-banana-2` with a neutral
     full-body or head-and-shoulders shot grounded in `visual_cues` and
     the project style suffix.
   - Persist URLs back to the bible.
   - Failure mode: a single ref failure logs + persists `null` for that
     entity. Scene gen still works (just no ref for that character).
3. **Scene prompt build** (per-scene):
   - LLM resolves which character/location/item IDs are on-screen for
     scene N based on its narration line.
   - Build the kie prompt embedding the relevant `visual_cues` verbatim.
   - Stamp `bible_entity_ids` onto `doodle_frames[i]`.
4. **Scene image gen**:
   - `kie/nano-banana-2` with prompt + `image_input: [character_refs..., location_ref?]`.
   - Up to 14 refs supported; we'll cap at 4 to keep prompts coherent.
5. **Hero gen**:
   - Hero prompt pulls lead character's visual_cues + (when available)
     the character's reference_image_url as a kie ref input. Same
     character identity carries from hero to scenes.

## kie API contract (verified live 2026-06-14)

`nano-banana-2` createTask input shape:
```json
{
  "model": "nano-banana-2",
  "input": {
    "prompt": "...",
    "image_input": ["https://...", "https://..."],
    "aspect_ratio": "16:9",
    "resolution": "1K",
    "output_format": "png"
  }
}
```
Up to 14 reference images. Polling shape same as gpt-image-2. Pricing:
$0.04/image (1K/2K) — cheaper than current gpt-image-2 ($0.05).

## Settings audit (rule 15)

- `video.scene_image_model` (new, default `kie/nano-banana-2`) — admin
  can flip to `kie/nano-banana-pro` (~$0.09) for higher fidelity or
  back to `kie/gpt-image-2` to disable reference-image conditioning
  entirely. Validates against the MODEL_SLUG registry; unsupported
  values fall through to nano-banana-2.
- `video.world_bible_enabled` (new, default ON) — escape hatch. OFF
  reverts the scenes path to the existing `make_grounded_scene_prompts`
  flow (no bible, no refs). Defensive in case the bible builds break
  for a specific story.
- `video.character_reference_images_enabled` (new, default ON) — if
  OFF, bible is built but ref-image gen is skipped (saves ~$0.04 per
  character per story when you only want the schema for prompt-shaping).
- `video.location_reference_images` (new, default OFF) — opt-in to
  generating ref images for locations too. Adds ~$0.04 per location.

## Security (rule 13)

- Bible LLM input is the article body, already trusted (admin-curated).
  No new external surface.
- Reference image URLs are stored as opaque strings; we never serve
  them as raw HTML. The admin UI uses `<img src>` with a CSP-friendly
  origin (GCS public-read URLs).
- Bible JSON is bounded: characters ≤4, sub_chars ≤4, locations ≤3,
  items ≤5, each `visual_cues` capped at 600 chars (same as the
  existing narration cap pattern).
- Failed kie calls return their last-line stderr (already truncated
  via the existing `_truncate_error`) and surface in the queue row's
  error column, not in the prompt fed to subsequent calls — no risk
  of error-as-prompt-injection.

## Observability (rule 14)

- `[world bible build] story={id} chars={n} subchars={n} locs={n} items={n}`
- `[world bible refs] story={id} entity={id} kind=character ok|failed`
- `[scene prompts bible] story={id} scene={n} entity_ids=[char_001,loc_001]`
- `[regen scene grounded ref] story={id} scene={n} model=nano-banana-2 refs={n}`
- Admin UI logs `[world bible panel render]` once per mount so missing
  bibles produce a visible breadcrumb.

## Testing (rule 18)

- `pipeline/tests/test_world_bible.py` (new)
  - Parser: clean JSON, fenced, partial, garbage → fallback.
  - ID assignment: deterministic across reruns (sha8 of name + role).
  - Caps: more than 4 characters → trimmed; visual_cues > 600 → truncated.
- `pipeline/tests/test_media_regen.py` (extend)
  - First scene regen on a story without a bible builds one + persists.
  - Subsequent regens read cached bible, no extra LLM call.
  - Marker eviction: `built_with: narration_v1` (the previous shape)
    triggers rebuild to `world_bible_v1`.
  - Scene prompt path picks the right refs for the on-screen entities.
- `pipeline/tests/test_stages.py` (extend)
  - `build_world_bible` dry-run returns deterministic stubs.
  - Per-scene entity resolver returns subset matching narration.
- `lorewire-app/src/lib/world-bible.test.ts` (new) — parse / validate
  bible JSON; type guards.
- Manual QA: build a fresh story, inspect the bible panel, verify ref
  thumbnails render, regen a few scenes, confirm faces hold.

## Open questions / risks (council blind spots flagged)

1. **Multi-ref quality is unverified.** Council flagged that
   nano-banana-2's "strong subject consistency" claim is marketing.
   Mitigation: ship the model swap behind `video.scene_image_model`
   so we can A/B against pro/gpt-image-2 without code changes.
2. **Hero-as-canonical-reference overfits to hero pose/lighting.**
   Mitigation: generate a DEDICATED neutral character ref instead of
   reusing the hero. The hero THEN uses the character ref, not the
   other way around. (Reverse of what I originally proposed.)
3. **Reference image generation failure mid-batch.** If 1 of 4 char
   refs fails, do we proceed? Decision: yes, with `null` ref persisted.
   Scene gen falls back to text-only for that character. Logged loudly.
4. **Locations + items might not perceptually matter.** Council
   consensus. We're shipping them anyway per user direction, but the
   `video.location_reference_images` defaults to OFF so the location
   refs don't burn cost until proven needed.
5. **Premature schema commitment.** The bible JSON shape will be hard
   to evolve. Mitigation: `built_with` marker pattern (same as
   scene_prompts) so a future shape change can self-evict.

## Cost summary

Per story, fresh build:
- Bible LLM call: ~$0.005
- Character refs: 2-4 × $0.04 = $0.08-$0.16
- Optional location refs: 1-3 × $0.04 = $0.04-$0.12 (default off)
- Scene regen: existing per-scene cost, now $0.04 instead of $0.05

Net: bulk regen on a 27-scene story drops from 27 × $0.05 = $1.35 to
27 × $0.04 + 3 × $0.04 (refs) = $1.20. Cheaper, with refs included.
