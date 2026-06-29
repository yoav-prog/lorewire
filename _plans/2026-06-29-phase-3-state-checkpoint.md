# Phase 3a — resume state checkpoint (2026-06-29)

**Read this first when resuming Phase 3 on a new machine / new
session.** It captures everything that was true at the moment work
paused so you can pick up without reconstructing context.

Plan: [`_plans/2026-06-29-phase-3-og-poster-cards.md`](2026-06-29-phase-3-og-poster-cards.md).

## TL;DR (skip the rest if you only have 30 seconds)

Phase 3a code is **written, tested, committed, and pushed** to
`origin/feat/phase-3-og-posters` at commit `37fb171`. Vercel built a
Preview on push (production untouched — production tracks
`feat/multi-platform-shorts-publisher`). 18 files (13 modified +
5 new), 83/83 new Phase 3 vitest tests passing, full test sweep
at 2282/2288 (the 6 failures are 2 pre-existing baseline failures
× 3 runs; not caused by Phase 3).

**Next action on the new machine**: clone repo, `git fetch origin
&& git checkout feat/phase-3-og-posters`, re-run the test baseline
(should match 2282/2288, same 2 pre-existing failures), then open
PR targeting `feat/multi-platform-shorts-publisher` after explicit
Yoav go-ahead. Then two-stage deploy: Cloud Run first, PR merge
second, backfill third. **Do NOT click manual Vercel UI promotion
buttons.**

## State of the world (2026-06-29)

### Branches

- **Production-source branch (Vercel deploys this)**:
  `feat/multi-platform-shorts-publisher` at commit `75d1adb` after
  PR #140 (Phase 2 social posters) + PR #141 (actual MP4 duration)
  + PR #142 (backfill preprobed durations) merged. Per
  `lorewire-app/AGENTS.md` the project is in INVERTED state —
  `main` is behind production.
- **Phase 3a branch (THIS work)**:
  `origin/feat/phase-3-og-posters` at commit `37fb171`. Branched
  off `origin/feat/multi-platform-shorts-publisher` at `75d1adb`.
  Vercel builds a Preview on this branch (NOT production). No PR
  yet — that's the next-step action on the resume machine after
  Yoav signs off.
- **Stale local branch (ignore)**: `feat/social-poster-render` was
  the working branch during development. Its remote was deleted
  after PR #140 merged. Do NOT push or check this out on the
  resume machine.

### What ships in Phase 3a

Landscape (1200×630) OG-poster surface for `/v/[slug]` story page
metadata. Same Phase 2 LLM call (`generatePosterText`, cached on
`short_config.poster_text`), same guards, same Cloud Run pipeline.
Per-story kill switch, URL versioning via `?v={hash}` query string,
namespaced `[og poster ...]` logs. No cron — one-shot backfill route
+ publisher hook coverage.

Outsider track gate was **explicitly dropped** by Yoav 2026-06-29
("start coding 3a now"). Outsider test material is staged at
`scripts/outsider-poster-test.html` + `scripts/OUTSIDER_POSTER_TEST.md`
but does NOT block 3a code; if Yoav runs it later and the verdict
is "AI farm," redesign Phase 2 visuals + 3a inherits.

## Files touched (17 total)

### Modified (12)

| File | Change |
| --- | --- |
| [_plans/2026-06-29-phase-3-og-poster-cards.md](2026-06-29-phase-3-og-poster-cards.md) | Plan rewrite (post-council, post-crawler-audit). Killed portrait OG variant. Replaced cron with one-shot script. Added URL versioning, per-story kill, observability spec. |
| [lorewire-app/src/lib/short-config.ts](../lorewire-app/src/lib/short-config.ts) | + `og_poster_landscape_url?: string`, `og_poster_disabled?: boolean`, `og_poster_attempted_at?: string` on `ShortConfig`. + `readOptBool()` helper. + parser entries for the 3 new fields. |
| [lorewire-app/src/lib/short-poster.ts](../lorewire-app/src/lib/short-poster.ts) | + `OG_POSTER_WIDTH` / `OG_POSTER_HEIGHT` constants (1200 / 630). + `OgPoster` interface. + `EnsureOgPosterDeps` interface with `persistConfig` + `now` test seams. + `SETTING_OG_ENABLED` (`og.short_poster.enabled`). + `OG_REATTEMPT_WINDOW_MS` (7 days). + `computeOgPosterHash()` (hash includes literal `"landscape"` so portrait + landscape invalidate independently). + `ogPosterUrlForKey()` builds `…/poster-landscape-{hash}.png`. + `versionedUrl()` appends `?v={hash}`. + `loadCachedOgPosterState()` reads the 3 short_config fields. + `persistOgPosterState()` merges them back. + `ensureOgPoster()` — full flow: kill switches → load inputs → cache check (LLM if missing, hook fallback if LLM fails) → guards → hash → HEAD → POST Cloud Run with `aspect: "landscape"` → stamp short_config → return versioned URL. + `shouldReattemptOgPoster()` exported helper for the backfill route's 7-day window. |
| [lorewire-app/src/app/v/\[slug\]/page.tsx](../lorewire-app/src/app/v/[slug]/page.tsx) | `generateMetadata` reads `short_config.og_poster_landscape_url` (respects `og_poster_disabled`). Sets `og:image:width=1200` + `og:image:height=630` + alt + `twitter:image` explicit + forces `twitter:card=summary_large_image` when poster present. Falls back to `hero_image` → `defaultOgImage` when poster missing or disabled. |
| [lorewire-app/src/lib/publish-to-instagram.ts](../lorewire-app/src/lib/publish-to-instagram.ts) | `import { ensureOgPoster, ensureShortPoster }`. Wraps existing `ensureShortPoster` call in `Promise.all([ensureShortPoster(...), ensureOgPoster(...)])`. Same shared LLM call → marginal cost is one extra Cloud Run render per publish. |
| [lorewire-app/src/lib/publish-to-facebook.ts](../lorewire-app/src/lib/publish-to-facebook.ts) | Same pattern. Both call sites (fresh-publish + retry). |
| [lorewire-app/src/lib/publish-to-youtube.ts](../lorewire-app/src/lib/publish-to-youtube.ts) | Same pattern. Both call sites. |
| [video/src/PosterStill.tsx](../video/src/PosterStill.tsx) | + `LANDSCAPE_WIDTH` / `LANDSCAPE_HEIGHT` (1200 / 630). + `LS_*` geometry constants (side-by-side: scene 55%, band 45%). + `pickFontSizeLandscape()` — empirical tiers for 540px text width. + `charsPerLineForSizeLandscape()` matching math. + `PosterStillLandscape` React component. **Council fix: auto-sizer is forked, not reused** — Phase 2's `pickFontSize` hardcoded to 940px would silently overflow the narrower band. |
| [video/src/Root.tsx](../video/src/Root.tsx) | Registers `PosterStillLandscape` composition at 1200×630. |
| [video/server/render.ts](../video/server/render.ts) | + `PosterAspect = "portrait" \| "landscape"` type. + `POSTER_LANDSCAPE_COMPOSITION_ID`. `renderPosterAndUploadStory()` now accepts optional `aspect` arg (defaults `"portrait"` for Phase 2 back-compat). Routes to `PosterStillLandscape` composition when landscape. GCS key shape: landscape uses `poster-landscape-{hash}.png` prefix; portrait keeps Phase 2's `poster-{hash}.png` for back-compat. |
| [video/server/index.ts](../video/server/index.ts) | Validator accepts optional `aspect: "portrait" \| "landscape"` body field. Missing → defaults `"portrait"`. Invalid → 400. Passes to renderer. |
| [video/server/index.test.mjs](../video/server/index.test.mjs) | + 4 new tests for `aspect` routing (default portrait, explicit portrait, landscape routes to landscape composition + has `-landscape-` GCS key segment, invalid aspect returns 400). |
| [lorewire-app/src/lib/short-config.test.ts](../lorewire-app/src/lib/short-config.test.ts) | + 4 new tests: round-trip of all 3 OG fields, missing-fields-parse-as-undefined, type-mismatch defense, `og_poster_disabled = false` preservation. |

### New (5)

| File | Purpose |
| --- | --- |
| [lorewire-app/src/app/api/admin/backfill_og_posters/route.ts](../lorewire-app/src/app/api/admin/backfill_og_posters/route.ts) | One-shot backfill route. `GET ?dry=1` lists what would process without spending. `POST` invokes `ensureOgPoster` per eligible story. Filters: published + missing `og_poster_landscape_url` + not disabled + outside 7-day re-attempt window. Auth: `requireCapability("content.manage")`. Default limit 30, cap 100. |
| [lorewire-app/src/app/api/admin/backfill_og_posters/route.test.ts](../lorewire-app/src/app/api/admin/backfill_og_posters/route.test.ts) | 7 vitest cases (dry-run no spend, filter stamped stories, skip disabled, skip in-window, re-attempt past-window, limit respected, failed counts). Mocks `ensureOgPoster` via `vi.spyOn(posterModule, "ensureOgPoster")`. |
| [lorewire-app/src/lib/short-poster-og.test.ts](../lorewire-app/src/lib/short-poster-og.test.ts) | 20 vitest cases for `ensureOgPoster`, `computeOgPosterHash`, `shouldReattemptOgPoster`. Covers: kill switches, cache hit, cache miss + POST, LLM generation persistence, guard rejections stamp `attempted_at`, Cloud Run failures stamp `attempted_at`, payload shape (single `text` field + `aspect: "landscape"`), URL `?v={hash}` versioning. |
| [scripts/outsider-poster-test.html](../scripts/outsider-poster-test.html) | Self-contained mock-Twitter feed mockup. 3 Lorewire poster slots × 2 contexts (landscape-cropped Twitter card + Discord/iMessage portrait). For the outsider track if Yoav decides to run it post-merge. |
| [scripts/OUTSIDER_POSTER_TEST.md](../scripts/OUTSIDER_POSTER_TEST.md) | 10-minute walkthrough for the outsider test. |

## How to resume — exact next commands

Open a new Claude session in the repo root (`c:/Projects/lorewire-app`). Paste this whole block as your first turn:

```
Resume Phase 3a per _plans/2026-06-29-phase-3-state-checkpoint.md.

Status: all code written + tested + committed + pushed to
origin/feat/phase-3-og-posters at commit 37fb171. Plan + Outsider
gate + crawler-doc audit + council pass + chairman verdict
already done.

Next steps: re-run the test baseline locally to confirm
2282/2288 (2 pre-existing failures: aspect.test.ts +
bulk-content-actions.test.ts), then open PR targeting
feat/multi-platform-shorts-publisher with my explicit go-ahead.
Then two-stage deploy (Cloud Run first, PR merge second,
backfill third).

If the baseline shows any failures other than those 2, stop and
investigate before opening the PR.
```

Claude will read this checkpoint, read the plan, verify tests, then walk you through the deploy sequence below.

## Deploy sequence (CRITICAL — read before any deploy command)

Per `lorewire-app/AGENTS.md` + CLAUDE.md rule 19.

### Stage 0 — clone + check out (DONE on this machine; redo on the new one)

```bash
# On a fresh machine:
git clone https://github.com/yoav-prog/lorewire.git c:/Projects/lorewire-app
cd c:/Projects/lorewire-app
git fetch origin
git checkout feat/phase-3-og-posters
# Should land at commit 37fb171 with no uncommitted changes.
git log --oneline -1   # confirms 37fb171
git status --short     # confirms clean tree
```

### Stage 1 — verify tests still pass

```bash
cd lorewire-app
npm install
npx vitest run \
  src/lib/short-poster-og.test.ts \
  src/lib/short-config.test.ts \
  src/lib/short-poster.test.ts \
  src/app/api/admin/backfill_og_posters/route.test.ts
# Expected: 83 passed.

cd ../video
npm install
npm run test:server
# Expected: 76 passed.

cd ../lorewire-app
npx vitest run
# Expected: 2282 passed, 2 failed (pre-existing baseline:
# aspect.test.ts + bulk-content-actions.test.ts). Anything else
# is a regression — investigate before continuing.
```

### Stage 2 — open the PR (after explicit Yoav approval)

```bash
gh pr create \
  --base feat/multi-platform-shorts-publisher \
  --head feat/phase-3-og-posters \
  --title "Phase 3a: landscape OG poster for /v/[slug] link unfurls" \
  --body-file - <<'EOF'
…use the commit message draft at the bottom of this checkpoint…
EOF
```

### Stage 3 — Cloud Run deploys FIRST (before the PR merge)

The merge auto-deploys Vercel. If Vercel goes first while Cloud
Run is still on the Phase 2 binary, the helper's POST with
`aspect: "landscape"` to old Cloud Run gets a 400 → helper logs
and returns null → page metadata falls back to `hero_image`. Not a
takedown, just no Phase 3 posters until Cloud Run catches up.
Still: deploy Cloud Run first so you don't ship a known-degraded
window.

```bash
cd video
npm run deploy:cloud-run
```

The wrapper script (`video/scripts/deploy-cloud-run.mjs`) reads
`.env.local` from the repo root + spawns `gcloud run deploy` with
resolved values. Same pattern Phase 2 used.

Validate with a curl:

```bash
curl -X POST https://<cloud-run-url>/render-poster \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "storyId":"test-landscape-smoke",
    "hash":"a1b2c3d4e5f60718",
    "aspect":"landscape",
    "inputProps":{
      "scene_1_url":"https://media.lorewire.com/<a real scene URL>",
      "text":"Eight hundred dollars. Gone."
    }
  }'
```

Should return 200 + `{ url, elapsed_ms, hash }`. Confirm the PNG
appears at the URL.

### Stage 4 — merge the PR

```bash
gh pr checks <PR#>      # confirm Vercel preview built green
gh pr merge <PR#> --squash --delete-branch
```

Vercel will auto-deploy the merge commit. **Do NOT click any
"Promote to Production" / "Redeploy" / "Rebuild" buttons in the
Vercel UI** — per AGENTS.md, manual promotion bypasses the
Production Branch tracking and has caused takedowns before.

### Stage 5 — one-shot backfill

After Vercel deploy completes:

```bash
# Dry-run first — confirms the candidate list size + no spend.
curl -X GET 'https://lorewire.com/api/admin/backfill_og_posters?dry=1&limit=500' \
  --cookie "<session cookie>"

# Real run — pulls a small batch first to confirm the pipeline.
curl -X POST 'https://lorewire.com/api/admin/backfill_og_posters?limit=5' \
  --cookie "<session cookie>"

# If first 5 look good, run full backlog.
curl -X POST 'https://lorewire.com/api/admin/backfill_og_posters?limit=100' \
  --cookie "<session cookie>"
```

Each request bounded at 100 stories, default 30. The route returns
counts + per-row outcomes. Tail Vercel logs and grep for
`[backfill og-poster run]` and `[og poster ensure]` namespaces.

### Stage 6 — manual smoke

1. Visit a backfilled story page. View source. Confirm:
   - `<meta property="og:image" content="…poster-landscape-{hash}.png?v={hash}">`
   - `<meta property="og:image:width" content="1200">`
   - `<meta property="og:image:height" content="630">`
   - `<meta name="twitter:image" content="…poster-landscape-{hash}.png?v={hash}">`
   - `<meta name="twitter:card" content="summary_large_image">`
2. Paste URL into Facebook Sharing Debugger
   (`developers.facebook.com/tools/debug/`). Confirm landscape
   renders. Click "Scrape Again" to flush.
3. LinkedIn Post Inspector (`linkedin.com/post-inspector/`).
4. Twitter Card Validator is **deprecated** — compose a draft
   tweet, paste URL, confirm unfurl preview. Don't post.
5. Share URL to yourself on Discord / Slack / iMessage / WhatsApp.

## Test baseline (verify before claiming "no new failures")

After resuming:

```bash
# Phase 3 vitest sweep
cd c:/Projects/lorewire-app/lorewire-app
npx vitest run \
  src/lib/short-poster-og.test.ts \
  src/lib/short-config.test.ts \
  src/lib/short-poster.test.ts \
  src/app/api/admin/backfill_og_posters/route.test.ts
# Expected: 83 passed

# Cloud Run server tests
cd ../video
npm run test:server
# Expected: 76 passed

# Full vitest sweep
cd ../lorewire-app
npx vitest run
# Expected: 2282 passed, 2 failed
# The 2 failures are PRE-EXISTING baseline:
#   1) src/lib/aspect.test.ts > parity with video/src/aspect.ts
#   2) tests/admin/bulk-content-actions.test.ts > publishes one story
#      and one article together (asset gate blocks the seed story)
# Verified via `git stash` round-trip: same 2 fail without my Phase 3
# changes. If you see any DIFFERENT failures, stop and investigate.
```

## Council pass + crawler audit references

Both informed the plan — don't repeat the work, but the artifacts are
worth knowing exist.

- **LLM Council**: 5 advisors (Contrarian, First Principles,
  Expansionist, Outsider, Executor) + 5 anonymized peer reviews +
  Chairman synthesis. Verdict killed the portrait OG variant,
  killed the cron, added URL versioning + per-story kill + forked
  auto-sizer. All applied in the current plan. The Contrarian's six
  failure modes are addressed in code; the comments inside
  `ensureOgPoster` and the backfill route call out which Contrarian
  finding each piece of code fixes ("Per Contrarian Failure Mode #1"
  comments).
- **2026 crawler-doc audit**: verified Twitter / FB / LinkedIn /
  Slack / Discord / iMessage / Telegram / WhatsApp behavior against
  current docs (NOT training data — per CLAUDE.md rule 1). Key
  findings: NO crawler renders portrait full-height (killed the
  original portrait OG variant); OG spec is first-tag-wins
  everywhere (no smart-pick-by-aspect logic); Twitter Card
  Validator was deprecated in 2025 (no API purge → query-string
  versioning is the only working cache-busting method); WhatsApp
  drops the preview without `og:image:width` / `height` tags.

## Phase 3b (NOT this scope — separate plans if needed)

Held over from the original draft per chairman + Yoav:

1. **Recurring cron** if the one-shot script + publisher hook coverage
   proves insufficient. Must include `attempted_at` bookkeeping
   (already on `short_config`), failure quarantine, NOT a
   re-scan-the-whole-table query.
2. **Square (1080×1080)** variant for IG feed / LinkedIn company /
   Threads. Same composition fork pattern.
3. **oEmbed endpoint** for external Substack / Medium / aggregator
   cards.
4. **Email hero** consuming the landscape URL.
5. **Homepage rails / category tiles / search / related / Top 10**
   consuming the landscape variant internally.
6. **`/v/[slug]/poster.png`** as a first-class public asset with
   `Cache-Control: immutable`.
7. **Outsider visual-redesign track** (if the post-merge mock-Twitter
   test comes back "AI farm"). Material at
   [scripts/outsider-poster-test.html](../scripts/outsider-poster-test.html) +
   [scripts/OUTSIDER_POSTER_TEST.md](../scripts/OUTSIDER_POSTER_TEST.md).

## Commit message draft (paste verbatim when committing)

```
Phase 3a: landscape OG poster for story page link unfurls

Surfaces a designed 1200×630 Lorewire poster as the og:image +
twitter:image on /v/[slug] so every external link share (Twitter,
LinkedIn, Slack, Discord, iMessage, WhatsApp) carries the same
designed art as the IG/FB/YT covers from Phase 2.

- PosterStillLandscape composition with forked pickFontSizeLandscape
  + charsPerLineForSizeLandscape (540px text region, not 940px) —
  per Phase 3 council Contrarian Failure Mode #2.
- Cloud Run /render-poster accepts aspect: "portrait" | "landscape"
  (default portrait, Phase 2 back-compat).
- ensureOgPoster() helper: same LLM call as Phase 2 (cached on first),
  same guards, but landscape composition + URL versioning (?v={hash})
  for platform cache invalidation. Twitter Card Validator was
  deprecated in 2025; query-string change is the only working
  cache-busting mechanism (verified via crawler-doc audit).
- ShortConfig gains og_poster_landscape_url, og_poster_disabled,
  og_poster_attempted_at fields. Per-story kill switch lets admin
  remove a bad poster without bumping POSTER_VERSION globally
  (Contrarian Failure Mode #3).
- generateMetadata wires og:image + og:image:width=1200 +
  og:image:height=630 + twitter:image explicit + twitter:card=
  summary_large_image when poster present. og:image:width/height
  are non-negotiable: WhatsApp silently drops the preview without
  them (verified via crawler-doc audit).
- Publishers (IG/FB/YT) call ensureOgPoster in parallel with the
  existing ensureShortPoster. Same LLM call (cached after first);
  marginal cost is one extra Cloud Run render per publish.
- One-shot backfill route at /api/admin/backfill_og_posters with
  attempted_at bookkeeping. Skips guard-rejected stories for 7 days
  so Cloud Run cycles don't burn on the same broken inputs forever
  (Contrarian Failure Mode #1).
- [og poster ...] namespaced observability logs at every step per
  CLAUDE.md rule 14.

Plan: _plans/2026-06-29-phase-3-og-poster-cards.md
State checkpoint: _plans/2026-06-29-phase-3-state-checkpoint.md
Council pass: 5 advisors + 5 peer reviews + chairman synthesis;
6 Contrarian failure modes addressed.
2026 crawler-doc audit: portrait OG variant DROPPED (no crawler
renders portrait full-height — Discord scales-to-fit at native
aspect inside a fixed embed frame; Apple TN3156 doesn't promise
portrait handling; WhatsApp center-crops to compact square).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
