# 2026-06-24 — Make `hero_thumbnail_from_short` resumable + idempotent

## The bug

`/admin/stories/[id]` "Generate hero + thumbnail from short" is stuck in
a never-ending reclaim loop. The same row keeps getting picked up by the
cron, runs ~3 of 5 i2i calls, gets killed by Vercel's 300s function
ceiling, then re-claimed on the next tick. Each iteration burns 3×
$0.05 in kie credits that get thrown away on the next iteration's
re-run.

Root cause (verified against the code, not guessed):

- `_build_hero_and_thumbnail_from_short`
  ([pipeline/media.py:1423](../pipeline/media.py#L1423)) makes 5
  sequential kie hybrid i2i calls. Each takes ~90–115 s in the logs.
  Total ~450–500 s.
- `drain_image_renders.py` has `maxDuration: 300`
  ([lorewire-app/vercel.json:47](../lorewire-app/vercel.json#L47)).
  Function is hard-killed before call #4 lands.
- Killed function never calls `finish_image_render`. Row stays at
  `generating`.
- `reap_stale_image_render_claims(stale_after_s=180)`
  ([pipeline/store.py:2068](../pipeline/store.py#L2068)) sees the
  row was claimed ~300 s ago, resets it to `queued`. Next tick claims
  it. Repeat.

The story-jobs path (`drain_story_jobs.py`, `maxDuration: 800`) does
NOT have this problem — its budget already fits 5 × 90 s. Fix is
scoped to the image_renders regen path.

## Goal

Make `_build_hero_and_thumbnail_from_short` resumable: when a function
kill causes a reclaim of the same image_renders row, the next iteration
should pick up where the previous one died — re-using the picker's
scene choice and skipping i2i calls whose output is already persisted
on the story row.

## Constraints / requirements

- No schema migration. Reuse `image_render_events.payload` as the
  state store. The picker decision is already logged there as the
  `scenes_picked` event (line 1541-1551), we just don't read it back.
- No behavior change for the story-jobs path (which has no render
  context). Resumability logic must no-op cleanly when no render
  context is bound.
- The image_renders queue worker contract is unchanged: returns
  `(first_url, total_cost_cents)`. `total_cost_cents` should reflect
  only THIS iteration's actual kie spend so the daily-cap reasoning
  is honest.
- Order of `image_input=[character, scene]` MUST be preserved; the
  finisher's existing comment block on this is the authority.

## Chosen approach

Three small surgeries in `pipeline/media.py`, one new helper in
`pipeline/store.py`, one test file extended.

### 1. New `store.first_render_event(render_id, event)` helper

Returns the oldest event of the given type for a render_id (or None).
Targeted query so it stays bounded as events accumulate across many
reclaims. Mirrors `list_render_events`'s SQL shape but adds
`AND event = ?` and `LIMIT 1`.

### 2. Expose the current render id

Add `store.current_render_id() -> str | None` that returns
`_current_render_id.get()`. Public getter so `media.py` doesn't reach
into the private contextvar.

### 3. Resume the picker choice

In `_build_hero_and_thumbnail_from_short`, immediately before the
`stages.pick_hero_and_thumbnail_scenes` call:

```python
prior_pick = None
render_id = store.current_render_id()
if render_id:
    prior = store.first_render_event(render_id, "scenes_picked")
    if prior and prior.get("payload"):
        try:
            payload = json.loads(prior["payload"])
            if "hero_index" in payload and "thumbnail_index" in payload:
                prior_pick = payload
        except (json.JSONDecodeError, TypeError):
            prior_pick = None  # fall through to fresh pick

if prior_pick is not None:
    pick = prior_pick
    store.log_render_event(
        "picker_resumed",
        f"Reusing prior pick hero=#{pick['hero_index']} "
        f"thumb=#{pick['thumbnail_index']} (resume after function kill)",
        payload={"hero_index": pick["hero_index"], "thumbnail_index": pick["thumbnail_index"]},
    )
else:
    pick = stages.pick_hero_and_thumbnail_scenes(title, body, scenes, dry_run=False)
```

### 4. Skip already-done variants

Re-fetch the story row right before the variant loop so we see writes
the prior iteration committed before being killed:

```python
fresh = store.fetch_story(story["id"]) or story
existing = {
    column: (fresh.get(column) or "").strip()
    for _, _, _, _, column in _HERO_THUMB_VARIANTS
}
```

Inside the loop, for each variant whose column is already set:

```python
if existing[column]:
    store.log_render_event(
        "variant_resumed",
        f"{label} already persisted — skipping i2i ({existing[column]})",
        payload={"variant": label, "url": existing[column], "resumed": True},
    )
    result[column] = existing[column]
    continue
```

The kie call, download, publish, and column write only run for
variants whose column is empty.

### 5. Result dict accuracy

The result dict's column entries should reflect what's actually on the
story row at end of run (whether freshly written or carried over),
because `_regen_hero_and_thumbnail_from_short`'s sample-URL pick
(line 1679-1686) walks that dict. Pre-populating from `existing`
covers this; the loop just overwrites entries it generated fresh.

## Alternatives rejected

1. **Just raise the timeouts.** Cheapest diff (bump maxDuration to
   800, raise DEADLINE_S / STALE_AFTER_S to match). Ships today, fixes
   the loop. Rejected because: ties up the queue advisory lock for
   ~8 min per finisher, and does nothing about the credit-burn
   problem in any future regression where one of the 5 calls is
   slower than expected. Should still be done as a defensive companion
   change once the resumability fix lands (see "Follow-on" below).

2. **Parallelize the 5 kie calls.** Wall time drops to ~120 s, fits
   easily in 300 s. Real win. Rejected as the primary fix because: it's
   a behavioral change to the kie call pattern (concurrent submissions,
   shared rate-limit budget across calls in flight, error handling that
   has to fan-in correctly) and we lose the per-call observability
   ordering in the timeline. Worth doing later when we want the speed,
   not while putting out the current fire.

3. **Persist picker choice as a column on `stories`.** Cleaner read
   path than going through `image_render_events`, but requires a
   migration, and the data is render-scoped not story-scoped (re-running
   regen should re-pick). Rejected.

## Security

No new attack surface. The added store helpers are read-only against
`image_render_events` (already populated by the existing worker) and a
read against the contextvar (no I/O). No new inputs from untrusted
sources. Logging additions follow the existing namespace pattern.

## Observability

Two new event slugs in the timeline:

- `picker_resumed` — fires when the prior `scenes_picked` event was
  recovered and the LLM picker call was skipped. Payload echoes the
  recovered hero_index / thumbnail_index.
- `variant_resumed` — fires per variant whose column was already
  populated. Payload includes the variant label and the carried-over
  URL.

These slugs make the resumption visible in the admin timeline so a
user reading the log can tell at a glance "this run reused earlier
work" vs. "this run did everything fresh."

`bracketed-namespace` prints in `_build_hero_and_thumbnail_from_short`
already exist; add a mirror line for each resume path so the Vercel
log tells the same story:

```
[hero+thumb from-short] id=abc123 resumed picker hero=#0 thumb=#4
[hero+thumb from-short] id=abc123 hero portrait already persisted, skipping
```

## Settings audit (rule 15)

No new user-facing settings. The resume behavior should be unconditional
and invisible to the user — it's correctness, not preference. No knob to
expose, no group to add. Explicitly intentional.

## Testing (rule 18)

Extend `pipeline/tests/test_hero_thumbnail_from_short.py`:

1. **`test_resumes_picker_choice_when_prior_scenes_picked_event_exists`**
   - Bind a render context, seed `image_render_events` with a
     `scenes_picked` row carrying `{hero_index: 2, thumbnail_index: 4}`.
   - Assert the LLM picker mock is NOT called.
   - Assert all 5 i2i calls run against scenes[2] / scenes[4].

2. **`test_skips_variants_whose_columns_are_already_populated`**
   - Patch `fetch_story` to return a story with `hero_image` and
     `hero_image_landscape` already set.
   - Assert `_generate_with_retry` is called exactly 3 times (the three
     thumbnail variants), not 5.
   - Assert the result dict still carries the pre-populated hero URLs.

3. **`test_no_render_context_runs_full_picker_and_all_variants`** (the
   regression guard for the story-jobs path)
   - No render context bound, no events seeded.
   - Assert the picker IS called, all 5 i2i calls run.

4. **`test_two_kill_and_reclaim_cycles_only_make_5_total_kie_calls`**
   (the bug repro)
   - First cycle: bind render context, run finisher, kill it after 3
     kie calls (use side_effect on `_generate_with_retry`).
   - Second cycle: same render context, run finisher again.
   - Assert across both cycles, `_generate_with_retry` was called
     exactly 5 times total, and the picker was called exactly once.

Run the full `pipeline\tests\test_hero_thumbnail_from_short.py` plus
`test_image_render_worker.py` (touches the same code paths via the
queue worker) and `test_story_jobs.py` (story-jobs path which must be
unchanged) before calling the fix done.

## Follow-on (not in this PR)

The original timeout sizing is still wrong for hybrid i2i. Once the
resumability fix is in, raise `drain_image_renders.py` to
`maxDuration: 800` and bump `DEADLINE_S` to 720 / `STALE_AFTER_S` to
900 in a small companion PR. With resumability landed, even a too-tight
ceiling no longer leaks money — but the wider budget lets a single
finisher tick complete cleanly in the common case, which is better UX
on the admin button.

## Open questions

1. Should the `picker_resumed` log carry the original picker_reasoning
   from the seeded event? Not strictly required for correctness, but
   it makes the audit trail clean. Default: yes, include it.
2. The fresh `store.fetch_story` call before the variant loop adds one
   DB round trip. Acceptable cost (this path is paid kie heavy), but
   noting it.
