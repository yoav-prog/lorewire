# Per-aspect intro/outro active selection

Date: 2026-06-15
Status: implemented 2026-06-15 (settings-key approach; loud-empty-state on delete;
wide/tall labels). Open questions 1 and 2 resolved with their defaults.
Related: _plans/2026-06-12-video-aspect-ratio.md (Phase 3 added the aspect filter),
_plans/2026-06-11-video-intro-outro.md (the original segment library),
_plans/2026-06-15-article-shorts-yt-studio-style.md (the 9:16 Shorts line that needs this)

## Goal

Let the admin keep a 9:16 intro/outro and a 16:9 intro/outro live at the same time,
each used automatically for renders of its matching shape. Today only one intro and
one outro can be active across the whole site, so the moment a 9:16 intro is active
every 16:9 render loses its intro, and vice versa.

## The actual gap (most of this feature already exists)

Verified in the codebase:

- `video_segments` already has an `aspect` column ("16:9" / "9:16", NULL = legacy 9:16).
- The upload form already has the 16:9/9:16 toggle and auto-detects aspect from the file.
- The worker already normalizes each segment to the matching dimensions and re-probes
  to correct a wrong aspect claim.
- The render resolver already aspect-filters: a segment whose aspect does not match the
  story is dropped (body-only render), in both `src/lib/segment-resolver.ts` and
  `pipeline/segments.py:pick_segment`.

The ONLY missing piece: "active" is a single global pointer per kind
(`video.active_intro_id`, `video.active_outro_id`). So there is one active intro and one
active outro, full stop. This plan makes "active" per-aspect.

## Requirements

- Independent active intro and outro per aspect (4 logical slots: intro/outro x wide/tall).
- A render of a given aspect uses the active segment of that aspect, or renders body-only
  if that aspect has no active segment (current acceptable behavior, unchanged).
- The admin can see at a glance which aspect has an intro/outro and which does not, and is
  warned loudly about gaps so they never ship a video with a missing intro by accident.
- TS and Python resolvers stay in exact parity.
- No regression for existing renders during and after rollout.

## Chosen approach: per-aspect settings keys

New settings keys, four total:
`video.active_intro_id_16x9`, `video.active_intro_id_9x16`,
`video.active_outro_id_16x9`, `video.active_outro_id_9x16`.

Key derivation is centralized so TS and Python cannot drift:
- Add `activeSegmentKey(kind, aspect)` to `src/lib/aspect.ts` and the mirror
  `active_segment_key(kind, aspect)` to `pipeline/aspect.py`, with the aspect-to-suffix
  map ("16:9" -> "16x9", "9:16" -> "9x16"). The existing `aspect.test.ts` parity test is
  extended to assert both languages produce identical key strings for all kind x aspect.

Code paths, all switched to read/write the slot for the relevant aspect:
1. Resolver (TS + Python): use the STORY's resolved aspect to read
   `video.active_<kind>_id_<aspect>`. Keep the aspect-match safety filter (still needed
   because a per-story pin can point at a wrong-aspect segment).
2. `setActiveSegmentAction` (actions.ts): write the slot matching the SEGMENT's OWN
   aspect (coalescing NULL -> 9:16). Never trust a requested aspect.
3. `deleteSegmentAction`: clear the per-aspect slot the deleted segment occupied (only if
   it pointed here).
4. Auto-activate (worker + upload-local): activate the first ready segment of a given
   kind AND aspect into that aspect's slot, only if the slot is empty. Use a conditional
   write (only set when currently empty) to avoid the concurrent-upload race.
5. Admin segments page: render four groups (Intros wide / Intros tall / Outros wide /
   Outros tall), each with its own ACTIVE badge, Set-as-active, and empty state.
6. Story editor page: read the slot for the story's resolved aspect for the pin default.

### Migration (one-shot, idempotent, fail-safe)

Seed each per-aspect slot from the existing legacy key once: for each kind, if
`video.active_<kind>_id` is set, look up that segment's aspect (coalesce NULL -> 9:16) and,
if the matching new slot is empty, set it. Idempotent (fill-if-empty), so it is safe to
run on every boot and converges regardless of which runtime (Next or pipeline) boots first
against the shared Postgres. After seeding, the resolver reads only the new keys; the
legacy keys become vestigial and are left in place (harmless) rather than deleted.

Worst case if the new resolver is live a few minutes before the seed runs: that aspect
renders body-only (no intro), which is non-destructive and self-heals. No broken video.

### UI (lazy-user lens, from the council Outsider)

- Group headers in plain language: "Intros — wide videos (16:9, YouTube)" and
  "Intros — tall videos (9:16, Shorts & Reels)". Same for outros.
- Each group shows its own ACTIVE badge worded for the slot ("Active for wide videos").
- Loud empty state per group when no active segment for that aspect, in amber not gray:
  "No active intro for wide videos. Wide videos will render with no intro."
- A summary line at the top listing any gaps so the admin sees them without scanning four
  lists.
- Upload stays one form per kind; aspect is auto-detected and the card lands in the right
  group. Keep the existing server-side probe as the final authority on aspect.

## Alternatives considered and rejected

### A. `is_active` boolean column on video_segments + partial unique index
Summary: store "active" as a row flag scoped by (kind, aspect), with a partial unique
index `(kind, aspect) WHERE is_active` making "one active per slot" a DB invariant. The
LLM council peer-review favored this.
Why rejected: this codebase has no transaction helper (confirmed in
_plans/2026-06-13-editor-intro-outro-regen-all.md). With the unique index, "set active"
must clear-then-set across two statements; set-first violates the index, and clear-first
opens a window with zero active rows for that slot. A settings key is a single atomic
upsert with no window, and it matches the pattern "active" already uses. The boolean's
main selling point (the aspect filter becomes unnecessary) does not fully hold, because
the per-story pin path can still pin a wrong-aspect segment, so that filter stays anyway.
It also costs a schema migration on `video_segments` mirrored across SQLite/Postgres and
TS/Python, versus zero schema change here. Verdict: cleaner in the abstract, heavier and
less atomic in this codebase, for marginal benefit. The partial-unique-index pattern is
proven here (story-jobs work), so this stays a viable fallback if we ever add transactions.

### B. Composable string keys (active:kind:aspect:platform:...)
Summary: a future-proof key namespace to add platform/season/AB dimensions later.
Why rejected: all three council reviewers flagged it as speculative generality. No current
requirement; it trades away type safety and queryability for features nobody asked for.
The per-aspect keys do not wall this out if it is ever needed.

### C. A fully separate 9:16 intro/outro library
Why rejected (and confirmed with the user): redundant with the aspect column that already
exists; doubles the UI and storage concepts for the same outcome. User chose per-aspect
active on the single library.

## Security and safety (rule 13)

- No new attack surface. No new external service, no new secrets, no new network calls.
- Inputs: the only new write is a settings key chosen by an authenticated admin
  (`requireAdmin` already guards all segment actions). The slot is derived server-side from
  the segment's own probed aspect, never from a client-supplied aspect, so a forged request
  cannot route a segment into the wrong slot.
- Fail-safe: every resolver path already fails closed to body-only when a slot is empty,
  the segment is missing/disabled, or the aspect mismatches. This plan preserves that.
- No PII or credentials touched or logged. Existing console.info lines for set-active and
  delete continue, now including the aspect.

## Cost (rule 8)

None. Reuses existing GCS storage and the existing Cloud Run render path. No new paid
service, no change to per-render cost.

## QA plan

- Unit (TS): `segment-resolver.test.ts` updated for per-aspect slots; new cases for
  wide-story-reads-wide-slot, tall-story-reads-tall-slot, empty-slot -> body-only,
  pinned-wrong-aspect still dropped. Key parity assertion in `aspect.test.ts`.
- Unit (Python): `test_segments.py` updated for per-aspect `active_<kind>_id_<aspect>`;
  `test_segments_worker.py` updated for per-aspect auto-activate + the conditional-write
  race; migration idempotency test.
- Manual golden path: upload a wide intro and a tall intro, set each active, render one
  story of each aspect, confirm each gets its matching intro.
- Edge: delete the active wide intro -> wide group shows the loud empty state and wide
  renders go body-only while tall is unaffected; disable the active tall outro -> warned in
  UI and tall renders go body-only.
- Regression: a site with only the legacy key set renders identically after the seed runs;
  in-flight renders are unaffected by a mid-render active change (URL captured at dispatch).

## Open questions

1. On delete/disable of an active segment, leave the slot empty with a loud UI warning
   (chosen), or auto-promote the next enabled segment of that kind+aspect? Auto-promote is
   "magic" and can surprise; the loud empty state makes the gap obvious. Defaulting to no
   auto-promote unless you want it.
2. Delete the vestigial legacy keys after the seed, or leave them? Leaving them is
   harmless; deleting is tidier. Defaulting to leave.

## Touch points (verified)

- `lorewire-app/src/lib/aspect.ts` (+ `aspect.test.ts`) — key helper + parity test
- `pipeline/aspect.py` (+ test) — mirror helper
- `lorewire-app/src/lib/segment-resolver.ts` (+ `segment-resolver.test.ts`)
- `pipeline/segments.py:pick_segment` (+ `pipeline/tests/test_segments.py`)
- `lorewire-app/src/app/admin/actions.ts` (`activeKey`, setActive, delete)
- `lorewire-app/src/app/api/admin/segments/upload-local/route.ts` (auto-activate)
- `pipeline/segments_worker.py` (`_active_setting_key`, auto-activate) (+ test)
- `lorewire-app/src/app/admin/(panel)/segments/page.tsx` (four groups + warnings)
- `lorewire-app/src/app/admin/(panel)/stories/[id]/page.tsx` (per-aspect pin default)
- migration home: idempotent seed in the schema-init path (store.py + db.ts), or a
  standalone backfill script run once (to be decided at implementation)
