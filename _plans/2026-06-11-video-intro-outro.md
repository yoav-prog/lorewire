# Video intro & outro library

Status: proposed (awaiting approval)
Author: Claude / Yoav
Date: 2026-06-11

## Goal

Every generated short ships with an intro at the start and an outro at the end.
The admin manages a library of intro/outro clips, marks exactly one of each as
the global active pick, and can override that on a per-story basis (pick a
specific one, or skip intro / outro for a single story).

## Why

The pipeline currently produces a bare-body short
([pipeline/video.py:160](pipeline/video.py#L160) → Remotion render → MP4 at
`public/generated/<id>/video.mp4`). There is no consistent brand framing on
either end. A library + per-story override gives editorial control without
churning code each time we want to swap an opener.

## Constraints (verified)

- Body video output: 1080x1920 @ 30fps, H.264 + AAC.
- Source files at `videos/intro.mp4` and `videos/outro.mp4`: 3840x2160 @ 24fps,
  4 seconds each. Orientation and fps mismatch the body video.
- ffmpeg 8.1 (full build) is on PATH locally. Pipeline runs locally on Windows;
  the admin runs as a Next.js app (Vercel + Postgres in prod, SQLite locally).
- Storage: GCS bucket already used by the pipeline (`pipeline/gcs.py`).
- User decisions captured in this session:
  - Apply scope: per-story override AND specific pick.
  - Selection: exactly one intro and one outro is "active" at any time
    (library can hold many; one is flagged active).
  - Storage: GCS for all uploads and normalized outputs.
  - Concat: ffmpeg post-concat (not inside Remotion).
  - Orientation: center-crop the 16:9 source to 9:16.

## Out of scope (v1)

- Crossfades between segments. Hard cuts only.
- Audio ducking or volume normalization. Whatever volume the source has, plays.
- Per-category overrides. The override layer is global → per-story.
- Multiple active intros/outros (round-robin, random). Exactly one active each.
- Captions extending over the intro/outro. The intro/outro plays raw.

## Architecture

Three real architectural decisions. Each is presented with the alternative and
the chosen path so it is clear what was traded.

### 1. How segments are stored

**Chosen: new `video_segments` table.**

Alternative considered: JSON list in `settings` (`video.intros` /
`video.outros`). Rejected because the data has structured per-row fields
(label, source URL, normalized URL, duration, enabled, created_at) and we
already query by id from the stories override columns. A relational shape is
the right tool; JSON in settings would force string-parsing in every code
path that touches it.

### 2. When normalization (transcode to 1080x1920 @ 30fps) happens

**Chosen: at upload time, once. The normalized file is cached in GCS and
re-used on every render.**

Alternative considered: normalize at every render. Rejected because it adds
~3-6 seconds of CPU per render for a result that does not change between
renders. Upload-time normalization is paid once per segment and a single
admin sees the wait.

### 3. How concat is done

**Chosen: ffmpeg concat filter (filter_complex), re-encoding the final
output once.**

Alternative considered: ffmpeg concat demuxer with stream-copy. Stream-copy
requires identical SPS/PPS headers between segments; even when both inputs
are 1080x1920 @ 30fps H.264, the encoder settings differ (intra refresh,
GOP length, etc.) and stream-copy concat is brittle. The concat filter
re-encodes once and is bulletproof. Adds ~5-10 s per render. Acceptable.

## Schema changes

`pipeline/store.py` SCHEMA_STATEMENTS additions:

```sql
CREATE TABLE IF NOT EXISTS video_segments (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,        -- 'intro' | 'outro'
    label           TEXT,
    source_url      TEXT,                  -- raw upload, GCS public URL
    normalized_url  TEXT,                  -- 1080x1920 @ 30fps, GCS
    duration_ms     INTEGER,
    enabled         INTEGER DEFAULT 1,     -- soft-disable without delete
    created_at      TEXT,
    updated_at      TEXT
);

ALTER TABLE stories ADD COLUMN IF NOT EXISTS intro_segment_id TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS outro_segment_id TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS skip_intro INTEGER DEFAULT 0;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS skip_outro INTEGER DEFAULT 0;
```

New settings keys (`settings` k/v table):

- `video.intro_outro_enabled` — global master kill switch. `0` skips both ends
  for every render (default `1`).
- `video.active_intro_id` — id of the active intro segment, or empty.
- `video.active_outro_id` — id of the active outro segment, or empty.

The `lorewire-app/src/lib/schema.ts` Drizzle schema mirrors these additions.

## Pipeline changes

New module: **`pipeline/segments.py`**

- `normalize(source_local_path: Path) -> dict` — ffmpeg invocation that
  produces a 1080x1920 @ 30fps H.264 + AAC MP4 with center-crop (no padding,
  no smart-fit). Returns `{normalized_path, duration_ms}`. Uses the
  `scale=...,crop=1080:1920` filter chain. Logs full command + duration.
- `pick_segment(kind, story_row, get_setting, fetch_segment) -> dict | None`
  — pure resolver. Walks:
    1. If `skip_<kind>` on the story is truthy, return None.
    2. If `<kind>_segment_id` on the story is set and that segment exists +
       is enabled, return it.
    3. If `video.intro_outro_enabled` is `0`, return None.
    4. Else read `video.active_<kind>_id` from settings; return the row if it
       exists and is enabled.
- `splice(body_mp4: Path, intro_local: Path | None, outro_local: Path | None,
  output_path: Path)` — ffmpeg concat filter call. If both ends are None, the
  body is just copied through unchanged (cheap stream-copy). Logs durations
  and final size.

**`pipeline/video.py` changes**

After Remotion render produces `out_mp4`, call `segments.splice(...)` with
intro/outro picked via `segments.pick_segment(...)`. The spliced file replaces
`out_mp4` in place (write to a temp file, then atomic rename). `gcs.publish`
runs on the spliced file. Re-renders inherit through `rerender_from_db`
without further changes.

## Admin (Next.js)

### New route: `/admin/segments`

Two sections on one page: **Intros** and **Outros** (identical layout, just
different `kind`). Per section:

- Upload area at the top: drag-drop or file input, accepts `.mp4` / `.mov`
  (the only formats we currently produce), 200 MB cap. Server action handles
  multipart, uploads source to GCS, invokes normalize, persists the row.
- List of segments below:
  - Thumbnail (first-frame still, generated at normalize time).
  - Label (inline-editable).
  - Duration.
  - "Active" badge on the active one. Button "Set as active" on the others.
  - Enabled toggle (soft-disable, keeps the row).
  - Delete button (hard-delete, with confirm — clears `active_<kind>_id`
    and any story that points at it).
- Above the two sections: a master toggle for
  `video.intro_outro_enabled`, with a one-line hint reading: "When off, no
  intro or outro is added to any render."

### Per-story edit

The existing story edit page gains an "Intro" and an "Outro" control. Each
is a dropdown:

- "Use global active" (default; clears the story-level override).
- "Skip — no intro" / "Skip — no outro" (sets `skip_intro` / `skip_outro`).
- One option per enabled segment of that kind.

### Settings audit (rule 15)

The Settings page links to `/admin/segments` with a one-line hint.
`video.intro_outro_enabled` is the only new settings field that lives on the
Settings page (because it is a single boolean). All other intro/outro
controls live on `/admin/segments` because they need richer UI than a flat
key/value form.

## Security (rule 13)

- Upload validated as admin-only via existing `requireAdmin` (see
  `lorewire-app/src/lib/dal.ts`).
- MIME whitelist: `video/mp4`, `video/quicktime`.
- Magic-byte sniff for `ftyp` box; reject anything that fails the sniff,
  even if the extension looks right.
- Size cap enforced server-side at 200 MB before reading the whole stream.
- Filename never echoed into GCS paths or shell args. Object naming:
  `segments/<uuid>.<ext>` and `segments/<uuid>.norm.mp4`.
- ffmpeg invocation uses an explicit, hand-built arg list — no user-provided
  flags ever flow into the command.
- Per-story override columns hold the segment id only; cannot reference an
  arbitrary URL.
- No PII stored on the segment row. Label is admin-supplied free text and
  is HTML-escaped at render.

## Observability (rule 14)

Namespaced logs added on every meaningful step:

Pipeline (`pipeline/segments.py`):
- `[segment upload id=X kind=intro] start size=12.3 MB`
- `[segment normalize id=X] start cmd=ffmpeg...`
- `[segment normalize id=X] done in 3.4s output=4.1 MB duration=4000ms`
- `[segment normalize id=X] FAILED rc=N tail=<last 8 lines of stderr>`
- `[segment pick kind=intro id=storyA] override=null active=segB result=segB`
- `[segment pick kind=intro id=storyA] override=skip result=null`
- `[video splice id=storyA] intro=segB outro=segC body=92.3s -> spliced 100.3s in 6.1s`
- `[video splice id=storyA] no segments active; skipping splice`

Admin (Next.js, `console.info`):
- `[admin segments] upload kind=intro size=...`
- `[admin segments] set-active kind=intro id=...`
- `[admin segments] delete id=... reassigns_active=true|false`
- `[admin story-edit] override kind=intro story=... pick=segC|skip|inherit`

## Testing (rule 18)

Unit (pipeline/tests/test_segments.py):

- `pick_segment` chain — story override beats global active beats null.
- `pick_segment` respects `skip_<kind>` even when an override is set.
- `pick_segment` respects `video.intro_outro_enabled=0` when no per-story
  override is set.
- `pick_segment` returns None when the referenced segment is disabled or
  missing.
- `_ffmpeg_normalize_cmd(path)` and `_ffmpeg_splice_cmd(a, b, c, out)`
  produce the expected static arg lists (no shell execution).

Integration (pipeline/tests/test_segments_ffmpeg.py, marked `slow`):

- Synthesize two tiny fixture MP4s with ffmpeg's lavfi color source
  (a 1-second red 1920x1080 and a 1-second blue 1080x1920 at 30fps).
- normalize() the red one → assert output is 1080x1920 @ 30fps via ffprobe.
- splice() three clips → assert total duration ≈ sum (within 0.05s).

Admin (lorewire-app — integration of upload action only):

- POST a small fixture mp4 to the upload server action; assert row created,
  normalized_url populated, source GCS object exists.
- POST a bogus file (wrong magic bytes) → assert 4xx and no row created.

## Cost (rule 8)

Verified online via GCS pricing page (us-central1, Standard, 2026-06-11
rates): storage $0.020/GB-month, network egress $0.12/GB.

- A 20-segment library averaging 10 MB each (source) + 5 MB each (normalized)
  = ~300 MB stored → ~$0.006/month. Negligible.
- Egress: pipeline downloads ~10 MB per render to splice. At 100 renders/day
  that is ~30 GB/month → ~$3.60/month at full retail. In practice the
  pipeline can cache locally between runs of the same machine, so real
  egress is lower.
- ffmpeg: zero. Local CPU only.
- No new paid services.

## UX & lazy-user check (rule 10, 16)

Critical flows walked through from the seat of a tired admin:

- "I want to add a new intro" → land on `/admin/segments` → drop file on the
  "Intros" upload area → 5-15 s spinner with progress → row appears with
  thumbnail + duration → "Set as active" if I want it live now. No second
  page, no separate "publish" step.
- "I want to swap which intro is active" → one click on "Set as active" in
  the list. Previous active loses its badge.
- "I want this one story to have no intro" → story edit page → Intro
  dropdown → "Skip — no intro" → save. Reflected in next render.
- "I want intros off everywhere temporarily" → Settings → master toggle off
  → save. One field. Story overrides still respected (a story with a pinned
  specific intro still gets it; a story set to "use global" gets nothing).
- "I uploaded the wrong file" → delete button on the row → confirm → gone.
  If it was active, the active flag clears and the master toggle behavior
  takes over until a new active is set (no intro on subsequent renders).
- "How do I know which one is current?" → "Active" badge on exactly one row
  per kind. No hunting.

UI shape stays in line with existing admin: same border-line/surface
classes, same form patterns, same font-display heading. No bespoke design
language for this feature.

## Plan of work

1. Schema: extend `pipeline/store.py` SCHEMA_STATEMENTS and `lorewire-app
   /src/lib/schema.ts`. Add `video_segments` repo helpers
   (`fetch_segment`, `list_segments`, `upsert_segment`,
   `delete_segment`).
2. Pipeline: write `pipeline/segments.py` with normalize, pick_segment,
   splice. Wire into `pipeline/video.py:generate_video` after the Remotion
   render completes.
3. Admin server actions in `lorewire-app/src/app/admin/actions.ts`:
   `uploadSegmentAction`, `setActiveSegmentAction`,
   `toggleSegmentEnabledAction`, `deleteSegmentAction`,
   `setStorySegmentOverrideAction`.
4. Admin UI: new route group at
   `lorewire-app/src/app/admin/(panel)/segments/page.tsx`. Per-story
   controls added to the existing story edit page.
5. Tests: pipeline unit + integration; admin upload action smoke test.
6. Manual QA pass: end-to-end render of a fresh story with the master
   toggle on, with a story-level skip, with a story-level pinned override.
7. Backfill: no migration needed; new columns default to empty. Old stories
   re-rendered after the change get the active intro/outro automatically.

## Open questions

- Should normalize crop be configurable (vertical/letterbox/blur) on a
  per-segment basis later? Not v1.
- Should the admin be able to preview a spliced result without re-running
  the full pipeline? Not v1; a story re-render is the canonical way.
- Should the captions ever extend over intro/outro? Not v1.
