# Phase 3 — surface the social poster on OG / Twitter cards

Date: 2026-06-29
Owner: Yoav
Status: **DRAFT — pending outsider verdict on Phase 2 visual register**

This is the post-council, post-crawler-verification revision of the
original Phase 3 draft. The original is git-history (`_plans/2026-06-29-phase-3-og-poster-cards.md`
pre-rewrite). Both the LLM Council pass and a fresh 2026 crawler-doc
audit found load-bearing holes that the original glossed over.

## What changed from the original draft

The original draft proposed two poster variants (portrait + landscape),
two new `short_config` URL fields, a backfill cron at 30 stories/hour,
and assumed Discord / iMessage / WhatsApp would render portrait
full-height. Two pressure-tests killed half of that:

1. **Crawler doc audit (verified against current 2026 platform docs)**
   found that NO crawler actually renders portrait full-height in
   its unfurl. Discord scales-to-fit at native aspect inside a fixed
   embed frame (tall + skinny, not full-bleed). Apple TN3156 makes
   no portrait promise; iOS 16+ community reports show near-square
   cropping. WhatsApp center-crops to its compact square preview.
   Twitter `summary_large_image` is landscape-fixed and center-crops
   portrait. The Open Graph spec is first-tag-wins on every platform
   — there's no "smart pick by aspect" anywhere. So the portrait
   variant has zero crawler-side benefit.
2. **LLM Council pass** (5 advisors + 5 anonymized peer reviews, all
   agreed Contrarian's six failure modes are shipping-blocking)
   surfaced: cron-non-convergence on guard-rejected stories,
   `pickFontSize` hardcoded for 940px (landscape is 540px — silent
   rewrite work), `POSTER_VERSION` bump now costs 2N renders, FB
   ignoring image array nuance (verified — it's actually "first tag
   wins per OG spec, alternatives are manual user picks only"),
   CRON_SECRET reuse as cost-amplification vector, and a
   parallelism race that could skip the portrait stamp on landscape
   failure. Peer review caught three more: no platform-cache
   invalidation strategy (Twitter Card Validator IS DEPRECATED,
   verified — no API purge exists), no edit-triggered re-render /
   takedown propagation, no `[og poster]` observability story.

Combined, Phase 3 collapses to:

- **ONE landscape variant** (1200×630), not two.
- **ONE new `short_config` field** (`og_poster_landscape_url`), not two.
- **URL versioning via query string** (`?v={contentHash}`) is the only
  working cache-busting mechanism for Twitter/X (Card Validator dead).
- **Explicit `og:image:width` / `og:image:height` tags + `twitter:image`**
  required: WhatsApp silently drops the preview without dimensions;
  `twitter:image` removes array-order ambiguity for Twitterbot.
- **No cron.** One-shot backfill script. Add cron in Phase 3b only
  if backlog measurably accumulates after deploy.
- **Per-story `og_poster_disabled` flag** so a bad poster can be
  killed without bumping `POSTER_VERSION` globally.
- **`[og poster]` namespaced logs** at every step.
- **Outsider track must complete first** — Yoav's call. If the
  existing Phase 2 portrait poster comes back from outsiders as "AI
  farm slop," Phase 2 needs a visual redesign and 3a inherits it.

## Why this exists (unchanged)

Phase 2 ships a designed 1080×1920 poster for IG / FB / YouTube
covers. Every link to a Lorewire story today on Twitter, LinkedIn,
Slack, Discord, iMessage, WhatsApp unfurls with `story.hero_image
?? seo.defaultOgImage` — generic per-story or site-default art.
Phase 3 puts a Lorewire-designed poster on those unfurls too,
sized correctly for the dominant landscape crawler surface.

## Architectural decisions locked

1. **Landscape only for the OG surface.** Portrait stays Phase 2's
   social-publisher cover (IG / FB / YT native portrait, doesn't go
   through OG meta tags). Phase 3 does NOT touch the portrait path.
2. **Lazy generation for every published story** via publisher hook
   + one-shot backfill script. Stories that never publish to socials
   still get a landscape poster on first OG bot fetch — generated
   in the background, NOT during `generateMetadata` (OG bots time
   out at 3-5s, an LLM + render takes 6-10s).
3. **Stamp resolved URL on `stories.short_config.og_poster_landscape_url`**
   so `generateMetadata` is O(1) (no extra `short_renders` query,
   no on-the-fly hash compute, no HEAD check on the request path).
4. **URL versioning via `?v={contentHash}` query string.** Twitter
   Card Validator is deprecated; query-string change is the only
   working cache-busting mechanism for Twitter/X. Other platforms
   (FB, LinkedIn, Slack, Discord, iMessage, Telegram, WhatsApp)
   also accept it.

## Goals (Phase 3a)

1. Every story page (`/v/[slug]`) exposes the Lorewire-designed
   landscape poster as its OG / Twitter card image. Twitter, FB,
   LinkedIn, Slack, Discord, iMessage, WhatsApp all render a
   deliberate poster instead of the generic hero.
2. Cache-bust on edit: when `poster_text` changes (typo fix, admin
   override) OR scene-1 changes, the URL changes (different
   content hash → different `?v=` segment), forcing each platform
   to refetch on next share.
3. Per-story kill switch: admin can flip `og_poster_disabled = 1`
   to revert a specific story to the `hero_image` fallback without
   a global `POSTER_VERSION` bump.
4. Best-effort end-to-end. Page render never blocks on poster
   generation. Missing URL silently falls back to `hero_image` →
   `seo.defaultOgImage`.

## Constraints

- **No request-path LLM / render calls.** OG bot fetches (Twitter
  card validator, Slack unfurl, Discord crawler) time out at 3-5s;
  LLM + Cloud Run render takes 6-10s. Generation runs in publisher
  hook + backfill script only.
- **No new external services.** Per global rule 8: one extra render
  per story (~$0.001 incremental over Phase 2's $0.001). Landscape
  PNG ~120 KB; 100 stories × 120 KB = 12 MB additional GCS storage.
- **Cache invalidation IS solvable.** Verified via crawler-doc
  audit: query-string change forces refetch on every documented
  platform. Twitter Card Validator deprecated (no UI / API purge);
  query-string is the only working method.
- **OG spec is first-tag-wins everywhere.** No platform has
  "smart-pick by aspect" logic. We declare landscape as the
  primary `og:image` AND as `twitter:image` (explicit precedence).
- **`og:image:width` / `og:image:height` REQUIRED.** WhatsApp
  silently drops the preview on first share without dimensions.
  Facebook also benefits (synchronous render on first share).

## Chosen approach

### Part 0 — Extend `ShortConfig` with one field + one flag

File: `lorewire-app/src/lib/short-config.ts`.

```ts
export interface ShortConfig {
  // ... existing fields ...
  poster_text?: string;
  /** Resolved URL of the LAST successful landscape (1200×630)
   *  poster render. Stamped by the publisher hook (`ensureOgPoster`)
   *  after a successful Cloud Run round-trip. Empty / missing means
   *  "render on next publish or via one-shot backfill". Used by
   *  Phase 3 OG / Twitter cards (every external crawler surface).
   *
   *  URL is content-hash-keyed AND query-string-versioned, so an
   *  edit to `poster_text` or scene_1 produces a different URL —
   *  forces Twitter / FB / Slack / Discord / iMessage / WhatsApp to
   *  refetch on next share. The Twitter Card Validator is
   *  deprecated (2025); query-string change is the only working
   *  cache-busting mechanism for Twitter/X.
   *
   *  Per `_plans/2026-06-29-phase-3-og-poster-cards.md`. */
  og_poster_landscape_url?: string;
  /** Admin kill switch for THIS story's OG poster. When true, the
   *  metadata path falls back to `hero_image` → `seo.defaultOgImage`
   *  without trying the poster URL. Lets admin fix a specific
   *  embarrassment (typo, mis-cropped scene, wrong tone) without
   *  bumping `POSTER_VERSION` globally (which would invalidate every
   *  cached poster across the entire catalog — a DoS trigger per the
   *  council Contrarian). */
  og_poster_disabled?: boolean;
}
```

Parser adds `readOptString` + `readOptBool` mirroring `poster_text`.

### Part 1 — Add a landscape composition to PosterStill

File: `video/src/PosterStill.tsx` (extend) + `video/src/Root.tsx`
(register a second composition `PosterStillLandscape`,
1200×630, durationInFrames=1).

**Layout — locked after Yoav signs off on PIL preview:**

The default proposal is **side-by-side**: scene-1 left 55% (660 px),
dark band right 45% (540 px text width) carrying hook text + brand
pill. Translates the portrait design directly — the band moves from
bottom to right, the brand pill goes bottom-right of the band.

**Critical: fork the auto-sizer.** Phase 2's `pickFontSize` is
hardcoded for 940 px text width (`Math.floor(940 / (fontSize *
0.42))`) and tuned for 1080-wide canvas. Landscape's 540 px text
region needs its own size tiers + char-per-line math:

```ts
function pickFontSizeLandscape(text: string): number {
  // 540px text region, condensed Bebas Neue caps ~0.42 advance.
  // Empirical tiers — to be validated against 10 real payloads
  // in the local-first protocol BEFORE Cloud Run deploy.
  const len = text.length;
  if (len <= 12) return 96;
  if (len <= 24) return 80;
  if (len <= 40) return 66;
  if (len <= 60) return 54;
  return 44;
}

function charsPerLineForSizeLandscape(fontSize: number): number {
  return Math.max(6, Math.floor(540 / (fontSize * 0.42)));
}
```

The plan calls this out so it doesn't get glossed as "scaled to" —
per the Contrarian + Executor: half-day of PIL iteration, not a
tweak.

### Part 2 — Cloud Run accepts `aspect` param

Files: `video/server/index.ts` + `video/server/render.ts`.

Extend the existing `/render-poster` endpoint:

```
POST /render-poster
Body: {
  storyId: string,
  hash: string,
  aspect?: "portrait" | "landscape",  // default "portrait" for back-compat
  inputProps: { scene_1_url, text, brand_text? }
}
```

Validator extends; server picks the composition (`PosterStill` vs
`PosterStillLandscape`) based on `aspect`. GCS key includes the
aspect so portrait and landscape can't collide:
`{storyId}-short/poster-{aspect}-{hash}.png` (portrait keeps the
existing key shape for back-compat: aspect param defaults to
"portrait" and old keys still resolve).

### Part 3 — Helper extends to landscape

File: `lorewire-app/src/lib/short-poster.ts`.

Add `ensureOgPoster(storyId)` as a SECOND helper alongside the
existing `ensureShortPoster` (which stays portrait-only for the
social publisher path). Two separate helpers, two separate cache
keys — the portrait helper stays Phase 2 byte-identical, no
regression risk for the IG/FB/YT publishers.

```ts
export interface OgPoster {
  url: string;              // includes ?v={hash} for cache-bust
  alt: string;
  hash: string;
  width: 1200;
  height: 630;
  source: "cached" | "rendered";
}

export async function ensureOgPoster(
  storyId: string,
  deps?: EnsureOgPosterDeps,
): Promise<OgPoster | null>
```

Flow:

```
1. Kill switch check: short_config.og_poster_disabled = 1 → null.
2. Global setting check: og.short_poster.enabled = '0' → null.
3. Load scene_1_url + hook from short_renders.props (Phase 2 helper).
4. Load cached short_config.poster_text. If missing → generate via
   the same dedicated LLM call (`generatePosterText`) Phase 2
   added → persist back on short_config.
5. Brand-safety + glyph + RTL guards (same as Phase 2 helper).
6. hash = sha256(scene_1_url + "\n" + text + "\n" + "landscape" +
   "\n" + POSTER_VERSION).slice(0,16).
7. baseUrl = `{MEDIA_PUBLIC_BASE}/{storyId}-short/poster-landscape-{hash}.png`.
   versionedUrl = `${baseUrl}?v={hash}`.
8. HEAD baseUrl with 2s timeout. Cache hit → return versionedUrl.
9. Cache miss → POST to Cloud Run /render-poster with aspect="landscape".
10. Stamp `short_config.og_poster_landscape_url = versionedUrl`.
11. Return { url: versionedUrl, alt, hash, width: 1200, height: 630, source }.
```

Any failure logs and returns null. Never throws. Caller falls back
to the existing `hero_image` chain.

### Part 4 — Publisher hook stamps the URL

The Phase 2 social publishers (`publish-to-instagram.ts`, etc.)
already call `ensureShortPoster` (portrait) on publish. Extend each
to ALSO call `ensureOgPoster` in parallel — best-effort, doesn't
block the publish itself. Result: every story published to a
social platform automatically gets its landscape OG poster stamped
without a separate code path.

For stories never socially published: the one-shot backfill script
(Part 6) handles them.

### Part 5 — Wire `generateMetadata` for story pages

File: `lorewire-app/src/app/v/[slug]/page.tsx`.

```ts
import { parseShortConfig } from "@/lib/short-config";

// Phase 3 — surface the landscape OG poster when stamped.
let ogImage = story.hero_image ?? seo.defaultOgImage ?? undefined;
let ogImageWidth: number | undefined;
let ogImageHeight: number | undefined;
let twitterImage: string | undefined;

if (story.short_config) {
  try {
    const parsed = parseShortConfig(JSON.parse(story.short_config));
    if (
      parsed.ok &&
      parsed.config.og_poster_landscape_url &&
      !parsed.config.og_poster_disabled
    ) {
      ogImage = parsed.config.og_poster_landscape_url;
      ogImageWidth = 1200;
      ogImageHeight = 630;
      twitterImage = parsed.config.og_poster_landscape_url;
    }
  } catch {
    // malformed short_config — fall through to hero
  }
}

return {
  // ... existing fields ...
  openGraph: {
    // ... existing fields ...
    images: ogImage
      ? [{
          url: ogImage,
          width: ogImageWidth,    // 1200 when poster present
          height: ogImageHeight,  // 630 when poster present
          alt: `Lorewire: ${story.title}`,
        }]
      : undefined,
  },
  twitter: {
    card: ogImage && ogImageWidth === 1200 ? "summary_large_image" : seo.twitterCardType,
    title: ...,
    description: ...,
    images: twitterImage ?? ogImage,  // twitter:image explicit
  },
};
```

The `og:image:width` and `og:image:height` tags are NON-NEGOTIABLE
per the crawler-doc audit — WhatsApp silently drops the first-share
preview without them. Setting `twitter:image` explicitly removes
the array-order ambiguity for Twitterbot.

### Part 6 — One-shot backfill script (NOT cron)

File: `lorewire-app/scripts/backfill_og_posters.mjs`.

```bash
node scripts/backfill_og_posters.mjs --limit=500 [--dry-run]
```

- Scans `stories WHERE status = 'published' AND short_config IS NULL
  OR json_extract(short_config, '$.og_poster_landscape_url') IS NULL`.
- Iterates up to `--limit`, calls `ensureOgPoster` for each.
- Tracks `og_poster_attempted_at` on `short_config` so guard-rejected
  stories (profanity, glyph fail, missing scene_1) DO NOT get
  re-attempted forever (per Contrarian Failure Mode #1). Re-attempt
  only if more than 7 days since last attempt.
- Logs `[backfill og-poster] scanned=N processed=N failed=N
  attempted_skip=N elapsed_ms=...` per global rule 14.
- Best-effort; one failure logs and skips to the next.

**No cron in 3a.** Run the script once after deploy. If backlog
keeps accumulating because admin re-publishes invalidate cache (or
`POSTER_VERSION` bumps invalidate everything at once), Phase 3b
adds a recurring cron with the `attempted_at` bookkeeping the
Contrarian named — NOT a re-scan-the-whole-table query.

### Part 7 — Observability

Per global rule 14, namespaced `[og poster]` logs at every step:

- `[og poster ensure] story_id=... source=cached|rendered hash=... elapsed_ms=...`
- `[og poster ensure] skipped reason=disabled_per_story|setting_off|missing_render_props|... story_id=...`
- `[og poster render] start hash=... story_id=...`
- `[og poster render] done hash=... elapsed_ms=... bytes=...`
- `[og poster render] failed reason=glyph|rtl|cloud_run_5xx|timeout story_id=...`
- `[og poster persist] story_id=... url_versioned=... persisted=true|false`
- `[og meta resolved] story_id=... source=poster|hero|default disabled=true|false`
- `[backfill og-poster] scanned=N processed=N failed=N attempted_skip=N elapsed_ms=...`

When a viral tweet unfurls wrong, grep the story_id across these
logs to see whether the poster was generated, stamped, retrieved by
the metadata path, or fell through to hero.

## Alternatives rejected

(Updated post-council + post-doc-audit.)

1. **Render on request inside `generateMetadata`.** Rejected:
   OG bots time out at 3-5s; LLM + render takes 6-10s.
2. **Single dynamic OG route `/v/og/[slug]/route.tsx` using
   `@vercel/og` Satori.** First Principles council voice's
   recommendation. Rejected after Reviewer 2 caught: Satori does
   NOT give pixel-identical output to Remotion's brand-specific
   typography, glyph validation, and brand-safety guards. A Satori
   landscape would silently introduce a brand-divergent poster on
   the highest-trust unfurl surface. Use Remotion with the existing
   guards.
3. **Ship portrait + landscape both as OG variants.** REJECTED by
   the 2026 crawler-doc audit: NO documented crawler renders
   portrait full-height. Discord scales-to-fit inside a fixed
   frame; Apple TN3156 makes no portrait promise; WhatsApp center-
   crops to square. The original draft's "portrait for chat apps,
   landscape for Twitter/FB" rationale is wrong. Portrait stays
   PHASE 2's social publisher cover — never enters OG surface.
4. **Hourly Vercel cron @ 30 stories/run.** REJECTED by Contrarian
   + Executor + multiple reviewers: cron doesn't converge on
   guard-rejected stories without `attempted_at` bookkeeping; the
   scan query `short_config NOT LIKE '%og_poster_landscape_url%'`
   picks the same broken stories every hour forever; per-run rate
   limit is wrong shape for cold-start vs steady-state. Replace
   with one-shot backfill script + publisher hook coverage. Add
   cron in Phase 3b only if measurable need post-deploy.
5. **Compute the URL on-the-fly in `generateMetadata`.** Rejected:
   adds DB query + HEAD check per OG bot fetch. Stamped URLs are
   O(1) read.
6. **Add new dedicated columns `stories.og_image_url`.** Rejected:
   `short_config` already carries related state (`poster_text`);
   one more URL field fits cleanly without a migration.
7. **Skip the LLM call for stories never socially published.**
   Rejected: the climax-revealing line is the whole point. One
   LLM call per story is cheap; defaults back to spoken `hook` if
   the LLM call fails.
8. **Two URL fields (portrait + landscape) on `short_config`.**
   Rejected post-doc-audit: no crawler benefit to portrait on the
   OG surface. ONE field (`og_poster_landscape_url`) only.
9. **Bump `POSTER_VERSION` globally to invalidate a single bad
   poster.** Rejected by Contrarian Failure Mode #3: that would
   cost 2N renders across the whole catalog. Per-story
   `og_poster_disabled` flag is the surgical fix.

## Open questions

1. **Outsider verdict on Phase 2 visual register.** GATING. The
   Outsider council voice claimed the existing portrait poster
   silhouette (illustration + dark band + condensed all-caps +
   corner brand pill) reads as AI-shorts-farm slop on Twitter. If
   3 outsiders confirm that read, Phase 2 needs a visual redesign
   FIRST and Phase 3a inherits the new look. The mock-Twitter test
   material is staged at `scripts/outsider-poster-test.html` +
   `scripts/OUTSIDER_POSTER_TEST.md`. Yoav drives this.
2. **Landscape layout final composition.** Side-by-side (default
   proposal in Part 1) vs full-bleed-with-lower-third (the
   Outsider's "deliberate" alternative). PIL preview pass on 10
   real stories during the local-first protocol decides.
3. **Square (1080×1080) as a third aspect** for IG feed posts /
   LinkedIn company posts / Threads — Expansionist council voice's
   recommendation. PUNTED to Phase 3b. Adding it after the
   landscape pipeline lands is trivial (same composition forking
   pattern, same Cloud Run aspect param).

## Security

- New URL field on `short_config` is public-facing (the URL lands
  in `<meta>` tags and the rendered PNG sits on the public bucket).
  No new attack surface beyond what `hero_image` already exposes.
- DoS mitigation: generation runs ONLY via publisher hook +
  one-shot backfill script invocation, NEVER via the request path.
  Page render reads stamped URLs only.
- CRON_SECRET reuse concern (Contrarian Failure Mode #5): the
  one-shot backfill script uses CRON_SECRET, same as Phase 2
  helpers. We accept the existing blast radius; no new endpoints
  that increase it.
- Per-story kill switch (`og_poster_disabled`) means a malicious
  or embarrassing poster can be removed in one DB update without
  global cache invalidation.
- Brand-safety + glyph + RTL guards already enforced by the
  existing `ensureShortPoster` helper; `ensureOgPoster` reuses the
  same guard layer.

## Settings

Per global rule 15:

- `publisher.short_poster.enabled` (existing, default ON) — controls
  the Phase 2 social publisher path.
- `og.short_poster.enabled` (new, default ON) — separate kill
  switch for the Phase 3 OG path. OFF reverts OG metadata to
  `hero_image` chain.
- `og.short_poster.max_text_chars` (new, default 280) — defense-
  in-depth cap on the text field (already capped in helper, but
  admin-tweakable for emergencies).
- Not exposed: design tokens (band geometry, fonts, colors). Brand
  invariants. Bump `POSTER_VERSION` to invalidate cache (with
  the caveat that doing so triggers up to N re-renders on next
  backfill).

## Testing

Per global rule 18:

### Local-first iteration (BEFORE any server / metadata work)

1. Build `PosterStillLandscape` in `video/src/PosterStill.tsx`
   with forked `pickFontSizeLandscape` + `charsPerLineForSizeLandscape`.
2. `cd video && npx remotion still src/Root.tsx PosterStillLandscape
   out-landscape.png --props='{...}'` for the same 10 real payloads
   the Phase 2 protocol used.
3. Eyeball: scene-1 crop on the left half, band width on the right,
   hook fit, brand pill placement, contrast for both bright and dark
   scenes.
4. ONLY after 10 render visually cleanly: proceed to Part 2.

### Vitest unit tests

- `lib/short-poster.test.ts` (extend):
  - `ensureOgPoster` happy path (cached → returns versioned URL)
  - cache miss → renders → stamps `short_config`
  - LLM call fires when `poster_text` missing
  - `og_poster_disabled` returns null without trying URL
  - `og.short_poster.enabled = '0'` returns null
  - URL contains `?v={hash}` query string
  - hash includes `aspect: "landscape"` so portrait and landscape
    invalidate independently
- `lib/short-config.test.ts` (extend): parses the new field +
  flag; missing parses as undefined / false
- `app/v/[slug]/page.test.ts` (extend or new):
  - generateMetadata picks `og_poster_landscape_url` when present
  - includes `og:image:width=1200` + `og:image:height=630`
  - sets `twitter:image` explicitly
  - forces `twitter:card = summary_large_image` when poster present
  - falls back to `hero_image` when poster URL is missing
  - falls back to `hero_image` when `og_poster_disabled = true`
  - falls back to `defaultOgImage` when hero is null
- `scripts/backfill_og_posters.test.mjs` (new):
  - `--dry-run` doesn't mutate
  - `--limit` respected
  - `og_poster_attempted_at` is set on guard-rejected stories
  - re-attempts skipped within 7-day window
  - logs scanned/processed/failed/attempted_skip counts

### Cloud Run server tests

- `video/server/index.test.mjs` (extend): `/render-poster` accepts
  `aspect: "portrait" | "landscape"`; invalid aspect → 400;
  `aspect = "landscape"` routes to `PosterStillLandscape`
  composition; default (missing aspect) routes to `PosterStill`
  (back-compat).

### Manual smoke (post-deploy)

1. Render landscape locally for 3 stories; eyeball.
2. Run backfill script with `--limit=3 --dry-run`; confirm scan
   query.
3. Run backfill script for real; confirm 3 stamped URLs.
4. Visit each story page in browser; View Source; confirm
   `og:image`, `og:image:width=1200`, `og:image:height=630`,
   `twitter:image`, `twitter:card=summary_large_image`.
5. Paste each page URL into the Facebook Sharing Debugger
   (`developers.facebook.com/tools/debug/`). Confirm landscape
   poster renders. Click "Scrape Again" to flush their cache.
6. Paste into LinkedIn Post Inspector
   (`linkedin.com/post-inspector/`). Confirm landscape renders.
7. Twitter Card Validator is DEPRECATED — no equivalent. Compose a
   tweet draft (don't post) with the URL; Twitter's compose UI
   shows the unfurl preview. Confirm landscape renders.
8. Share each URL in a personal Slack DM. Confirm unfurl. (Slack
   cache TTL is 30 minutes — fast iteration.)
9. Share each URL in a personal Discord DM. Confirm unfurl.
10. iMessage the URL to yourself; confirm Apple's preview renders
    (no debugger available; visual check only).
11. WhatsApp the URL to yourself; confirm WhatsApp's compact card
    renders with the poster (cropped to ~square — that's WhatsApp's
    documented behavior, NOT a bug).
12. Tail backfill log; confirm scanned/processed/failed counts
    match what's in the DB.

## Deploy

Per global rule 19 + `lorewire-app/AGENTS.md`:

**Current state (post-PR #140 merge)**: production-source is
`feat/multi-platform-shorts-publisher`. `main` is still behind
(inverted state).

**Branch**: `feat/phase-3-og-posters` off the post-PR-#140 state of
`feat/multi-platform-shorts-publisher`. One PR (Phase 3a only).

**Two-stage deploy** (same pattern as Phase 2):

1. **Cloud Run image rebuild FIRST.** Run `cd video && npm run
   deploy:cloud-run`. New `PosterStillLandscape` composition +
   `/render-poster` accepting the `aspect` param.
2. **Deploy gate**: `curl -X POST /render-poster` with
   `aspect: "landscape"` against the new revision; confirm 200 +
   landscape PNG appears at the deterministic URL.
3. **Vercel merge auto-deploy SECOND.** Merge the PR to
   `feat/multi-platform-shorts-publisher`. Vercel auto-deploys the
   helper + metadata wiring.
4. **One-shot backfill script** after Vercel deploy completes. Run
   with `--limit=500 --dry-run` first to confirm scan query; then
   for real.

**If sequencing breaks**: helper sends `aspect: "landscape"` to old
Cloud Run, gets 400 → helper logs and returns null → metadata
falls back to `hero_image`. No regression.

**Rollback**:
- Vercel: `git revert` of the merge commit. Auto-redeploys to
  pre-Phase-3 state. OG goes back to `hero_image`.
- Cloud Run: redeploy previous image if landscape rendering is
  broken specifically. The portrait path stays Phase 2-only.

**Do NOT click manual Vercel UI promotion buttons.**

**Confirm with Yoav before pushing.**

## Outsider track (parallel, GATES Phase 3a code)

Per Yoav's explicit decision: the Outsider council voice's
silhouette critique must be answered before any Phase 3 code lands.

Material staged:

- `scripts/outsider-poster-test.html` — self-contained mock-Twitter
  feed with 3 Lorewire posters in both Twitter-card-cropped form and
  Discord/iMessage-style portrait form.
- `scripts/OUTSIDER_POSTER_TEST.md` — 10-minute walkthrough: pick
  3 published stories, render 3 posters locally via `npx remotion
  still`, drop into `scripts/outsider-test-images/`, open the HTML,
  share with 3 outsiders.

Outsider verdict drives next move:

- **All 3 say "AI farm" / low-trust** → Phase 2 visual redesign
  first; Phase 3a inherits the new look. Re-cost the redesign
  before writing 3a code.
- **Mixed** → tweak the design (likely band or brand pill) before
  3a.
- **All 3 say "deliberate / editorial brand"** → ship 3a as planned.

## Phase 3b — separate plans, separate PRs (NOT this scope)

These are NOT in 3a. Each gets its own plan if and only if 3a
ships AND there's a measured need.

1. **Recurring backfill cron** if the one-shot script proves
   insufficient. Requires `attempted_at` bookkeeping (already on
   3a's short_config), failure quarantine, and per-run rate limit.
   The Contrarian's Failure Mode #1 must be designed away in 3b.
2. **Square (1080×1080) variant** for IG feed posts, LinkedIn
   company posts, Threads. Same composition fork pattern as
   landscape.
3. **oEmbed endpoint** so external Substack / Medium / news
   aggregators that link to Lorewire stories get rich cards.
4. **Email hero** — the landscape URL is one line of code away
   from being the newsletter hero image.
5. **Homepage rails / category tiles / search results / related
   cards / Top 10 numerals** consuming the landscape variant
   internally. Site-wide visual coherence; significant migration
   of every `hero_image` consumer.
6. **`/v/[slug]/poster.png` as a first-class public asset** with
   `Cache-Control: immutable` for creator screenshots / referral.
7. **Stamped `poster_text` as structured headline corpus** for
   homepage caption / push notification / RSS title overrides.

## What this plan does NOT do

- Does not change the Phase 2 portrait poster path (IG / FB / YT
  covers). Phase 2 stays byte-identical.
- Does not change the article OG path (articles already have a
  dynamic OG route at `/articles/og/[id]`).
- Does not change homepage / browse / category OG paths.
- Does not retroactively flush social-platform caches for existing
  shares. Stale previews on Twitter / FB for already-shared URLs
  stay stale until the platform's natural cache TTL rolls over.
  After 3a, NEW shares get the designed poster immediately.
- Does not surface the poster on the page body (only `<head>`).
- Does not introduce a square (1080×1080) variant (Phase 3b).
- Does not wire email hero, homepage rails, or oEmbed (Phase 3b).
- Does not generate posters for stories with `status != 'published'`
  (the backfill script filters explicitly).
- Does not add a recurring cron (Phase 3b only if measurable need).
