# Asset re-render: videos and images on demand

Date: 2026-06-12
Status: **Approved and in progress** (2026-06-12 late session). User
locked the four load-bearing decisions:

  1. Scope: full coverage — story hero/scenes/props/mouth-swap AND
     article hero/OG/body/gallery.
  2. Backend: queue + worker, mirror the existing video_renders pattern.
  3. Cost surfacing: inline `≈ $0.0X` badge next to each Regenerate
     button + a "today: $X.XX of $Y daily cap" line in the panel.
  4. Cap: reuse the existing `budget.daily_usd` setting. Image regens
     count against the same daily budget the pipeline already enforces.

Phasing (one branch, several commits):

  C1. Schema (image_renders table) + TS queue + cost/budget helpers
      + tests. Foundational, no UI yet.
  C2. Story-side regen UI on /admin/stories/[id] and /admin/videos/[id].
      Hero, scenes, props, mouth-swap.
  C3. Article-side regen UI on /admin/articles/[id].
      Hero, OG image, body images, gallery items.
  C4. Python image_render_worker + media.regen_one() refactor +
      pipeline tests.

Article image gen is a NEW pipeline capability — today the article
images are uploaded by hand. C3's UI scaffolds the affordances; the
Python work to actually generate them lands in C4.

## What the user asked for

> I want also to be able to edit videos that were already published, and
> also an option to re-render videos and images of articles/stories, All
> types of images (hero desktop, hero mobile, gallery, article images
> etc...)

Edit-published is **not a blocker** — verified at the data layer that
nothing prevents editing a published story or article ([actions.ts:449](lorewire-app/src/app/admin/actions.ts#L449)
is only a publish-time alt-text guard, [repo.ts:238](lorewire-app/src/lib/repo.ts#L238)
only stamps `published_at`). What's missing is the *visible affordance*
that you can edit a published piece. That UX nudge can land in this plan
alongside the re-render work or as a tiny separate commit.

Re-render is the meat of this plan.

## What exists today

- **Video render queue.** [`video-render-queue.ts`](lorewire-app/src/lib/video-render-queue.ts)
  exists. It's idempotent on `(story_id, config_hash)`, has a daily cap
  (default 20, settable via `video.daily_renders_per_story`), and is
  drained by a Python worker (`pipeline/render_worker.py`). The
  `/admin/videos/[id]` visual editor has a Render button via
  `queueRender` in [actions.ts](lorewire-app/src/app/admin/videos/[id]/actions.ts).
- **Image generation is not exposed in the admin.** Article hero/OG
  images, gallery images, and article-body images are either uploaded
  manually or generated once during the initial Python pipeline run via
  third-party APIs (kie / Replicate). There is no admin action to
  trigger a re-generation. There is no image render queue.
- **Story doodle frames + scene images** are produced by the pipeline
  during the media stage (also kie/Replicate). Same gap — no admin
  re-trigger surface.

## What "re-render" actually means (per asset type)

| Asset                          | Cost surface (verify before commit) | Generator path           |
| ------------------------------ | ----------------------------------- | ------------------------ |
| Story video (MP4)              | Compute time (Remotion worker)      | TS render queue → Python |
| Story doodle frames / scenes   | kie image gen (~$0.05 / image)      | Python pipeline media    |
| Story protagonist + mouth      | kie image gen (~$0.05–0.10)         | Python pipeline media    |
| Story prop cutouts             | kie image gen (~$0.05 each, 3–10)   | Python pipeline media    |
| Article hero image (desktop)   | kie/Replicate (~$0.05)              | Manual upload today      |
| Article hero image (mobile)    | kie/Replicate (~$0.05)              | Manual upload today      |
| Article OG image (social card) | kie/Replicate (~$0.05)              | Manual upload today      |
| Article body images            | kie/Replicate (~$0.05 each)         | Manual upload today      |
| Article gallery items          | kie/Replicate (~$0.05 each)         | Manual upload today      |

**Rule 8 — flag costs before committing.** The pricing numbers above are
estimates from the existing settings hints (e.g. "kie ~$0.05 each" in
`video.prop_slide`). Before this lands, real current pricing must be
re-checked from kie/Replicate dashboards — training-data prices age fast.

## Open questions to lock before writing code

1. **Pipeline API contract.** Does the Python worker today have an entry
   point that takes "regenerate this single asset" and runs only that
   generator, or does it always run the full media stage? If the latter,
   we need a new endpoint (`POST /pipeline/regen` style) or new CLI
   subcommand (`pipeline.py regen --story <id> --asset hero`).
2. **Idempotency / debouncing.** The video queue uses `config_hash` as
   the idempotency key — same config = same render. For images, what's
   the key? Story id + asset slug + prompt hash? Article id + field name
   + revision id?
3. **Cost budget surfacing.** Should the admin see the estimated cost
   *before* hitting Re-render? Inline confirmation modal ("This will
   cost ~$0.05. Proceed?") is friendly; just-do-it is faster. Lazy user
   probably wants the cost shown without a modal — a small "≈ $0.05"
   badge next to the button.
4. **Cap behavior.** Daily cap exists for video renders. Do we cap image
   regens similarly? Per asset, per story, per day?
5. **Progress / status feedback.** Video has `queued → rendering → done`
   states polled by the editor. Images today have no such state machine.
   Do we add one (new `image_renders` queue) or fire-and-forget with a
   "kicked off, refresh in a minute" toast?
6. **Failure handling.** If kie returns a NSFW filter rejection or a
   prompt error, the admin needs to see the error. What's the surface?

## Sketch of the build (subject to questions above)

**Backend**
- Add `image_renders` table mirroring `video_renders` (id, owner kind,
  owner id, asset slug, status, prompt_hash, output_url, requested_*,
  finished_*).
- Extend the Python pipeline with a `regen` subcommand that takes
  `(owner_kind, owner_id, asset_slug)` and writes to `image_renders`.
- TS side: `enqueueImageRegen(...)` mirroring `enqueueRender(...)`.

**UI**
- **Story / video metadata editor:** a "Media" panel listing every
  generated asset with a thumbnail, asset label, cost badge, and a
  "Regenerate" button. Each row shows the latest queue status.
- **Article editor:** same shape under a "Images" tab. Hero desktop,
  hero mobile, OG, body images list (parsed from the Tiptap doc),
  gallery items (parsed from the gallery node).
- **Edit-published nudge:** if the piece is published, a quiet banner
  reads "Published — edits will reflect on the live site after Save."
  Plain English; no modal.

**Observability (rule 14)**
- `[image regen enqueue]` `{ owner_id, asset_slug, prompt_hash, render_id }`
- `[image regen status]` polling.
- `[edit published banner]` when surfaced.

**Security (rule 13)**
- `requireAdmin()` on every regen action.
- Validate `owner_kind` + `owner_id` so an admin can't queue a regen
  against a row they shouldn't see.
- Rate-limit cost: per-story cap, per-day budget cap (matching the
  existing `budget.daily_usd` setting).

**Testing (rule 18)**
- `image-render-queue.test.ts` mirroring the video queue tests:
  idempotency, cap, status transitions.
- UI tests for the regen button states (idle, queued, rendering, done,
  error).

## Sequencing

1. Approve this plan (resolve the 6 open questions).
2. Branch off `main` as `feature/asset-rerender`.
3. Build backend (image_renders table + Python regen subcommand) first
   — UI without backend is dead chrome.
4. Build the Media / Images panels.
5. Edit-published banner (small, can ship first as a 5-minute commit).
6. QA pass.

Not part of this branch: anything that re-shapes the editors structurally.
The reorg work in `_plans/2026-06-12-admin-reorg-phase2.md` should be in
`main` before this branch lands so the regen panels slot into the new IA
without rebase pain.
