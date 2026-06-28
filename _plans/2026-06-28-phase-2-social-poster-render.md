# Phase 2 — deliberate social poster, rendered at publish time

Date: 2026-06-28 (revised + implemented 2026-06-29; refactored 2026-06-29)
Owner: Yoav
Status: **IMPLEMENTED 2026-06-29 (refactored for social-only isolation
2026-06-29)** — code on `feat/social-poster-render`, all tests green.
PR #140 open against `feat/multi-platform-shorts-publisher`.

## Social-only refactor (2026-06-29)

Mid-implementation, Yoav flagged the architectural leak: the original
2026-06-29 cut wired `poster_text` into the SCRIPT LLM call inside
`pipeline/shorts_narration.py`. That meant a Phase 2 prompt block was
sitting in the same system message that produced the spoken script,
which could subtly nudge other outputs (script word choice, beat
structure, hook tone). Phase 2 was supposed to be social-only — never
touch the video/site path.

Refactored 2026-06-29 to enforce the invariant:

- **Reverted** `_poster_text_block`, the `poster_text` JSON-schema
  field, and its inclusion in `system_parts` from
  `pipeline/shorts_narration.py`. Video script generation is now
  byte-identical to a pre-Phase-2 run.
- **Reverted** the `poster_text` preservation in
  `pipeline/shorts_render.py::build_short_props`. The `hook` field
  preservation stays (cheap, useful as a fallback for the poster
  helper).
- **Reverted** `stripPosterTextFromProps` from
  `lorewire-app/src/app/api/render_short/route.ts` and its tests.
  `stripHookFromProps` stays.
- **Reverted** `PosterTextBlockTests` from
  `pipeline/tests/test_shorts_narration_structure.py`.
- **Added** `poster_text?: string` as an optional field on
  `ShortConfig` (`lorewire-app/src/lib/short-config.ts`). The site
  render path doesn't read it — it's deliberately social-only.
- **Added** `generatePosterText(storyId)` inside
  `lorewire-app/src/lib/short-poster.ts`. A DEDICATED LLM call that
  runs at publish time, separate from the script pipeline, with its
  own focused prompt (8-14 words, climax-revealing, social-cover
  voice).
- **Rewrote** `ensureShortPoster` to: kill switch → load render inputs
  → load cached `short_config.poster_text` → on miss, LLM-generate +
  persist back → on LLM failure, fall back to spoken `hook` → guard
  → hash → cache HEAD → POST Cloud Run.
- **Simplified** `PosterStill.tsx` and the Cloud Run validator/render
  shape: dropped the dual `hook` + `poster_text` precedence; both
  collapse into a single `text` prop. The helper picks upstream; the
  composition just renders.

The social-only invariant is now load-bearing — anyone changing the
poster prompt only touches `short-poster.ts::generatePosterText`, never
the script pipeline.

## Implementation summary (2026-06-29, post-refactor)

Final file map. Branch: `feat/social-poster-render` off
production-source `32b5457` (which already includes PRs #135, #137,
plus the user's #136 + #138 parallel work merged on top). PR #140
targets `feat/multi-platform-shorts-publisher` per AGENTS.md inverted
state.

**Python pipeline (1 file touched):**
- `pipeline/shorts_render.py` — `build_short_props` preserves
  `hook` on the rendered props row (used by the poster helper as a
  fallback text source when the LLM call fails).
- No changes to `pipeline/shorts_narration.py` — video script
  generation is byte-identical to a pre-Phase-2 run. The social-only
  invariant lives here.

**TypeScript dispatcher (1 file + tests):**
- `lorewire-app/src/app/api/render_short/route.ts` —
  `stripHookFromProps` strips `hook` from inputProps before they
  reach DoodleShort (which doesn't accept that prop). Log line
  carries the strip flag.
- `lorewire-app/src/app/api/render_short/route.test.ts` — vitest
  cases lock the strip behavior.

**Short config (1 file):**
- `lorewire-app/src/lib/short-config.ts` — `ShortConfig` gains an
  optional `poster_text?: string` field. Cached output of the helper's
  dedicated LLM call; the site render path does NOT read it.

**Remotion (2 files):**
- `video/src/PosterStill.tsx` (new) — 1080×1920 still composition.
  Scene-1 top 70%, dark band bottom 30% (`#0F172A` + 8px red
  `#DC2626` accent stripe), `text` in Bebas Neue uppercase auto-sized
  58–110pt, brand pill bottom-right. Single `text` prop; the helper
  resolves which line to use upstream.
- `video/src/Root.tsx` — registered `PosterStill` alongside
  `DoodleShort` with `durationInFrames=1`.

**Cloud Run endpoint (2 files + tests):**
- `video/server/render.ts` — `renderPosterAndUploadStory` +
  `RenderPosterFn` type + `PosterInputProps` (single `text` field) +
  `PosterRenderResult` shapes. Reuses bundle, selectComposition,
  R2/GCS gate. Renders PNG via `renderStill`.
- `video/server/index.ts` — `POST /render-poster` route with body
  validator (`scene_1_url` + `text` + optional `brand_text`; URL/text/
  hash caps + hex format), auth, error mapping. `createApp` accepts
  an optional `renderPoster` seam for tests.
- `video/server/index.test.mjs` — node:test cases for auth, body
  validation (including text-missing / text-too-long), success path,
  and error mapping.

**Helper (1 file + tests):**
- `lorewire-app/src/lib/short-poster.ts` (new) — `ensureShortPoster`
  flow: kill switch → load `scene_1_url` + `hook` fallback from
  `short_renders.props` → load cached `short_config.poster_text` →
  on miss, `generatePosterText` (DEDICATED LLM call) + persist back
  → on LLM failure, fall back to spoken `hook` → brand-safety +
  glyph + RTL guards → `sha256(scene_1 + text + POSTER_VERSION).slice(0,16)`
  → HEAD cache (2s timeout) → POST Cloud Run (8s timeout). Returns
  `{ url, alt, hash, source }` or `null`. Never throws. Setting kill-
  switch `publisher.short_poster.enabled` (default ON).
- `lorewire-app/src/lib/short-poster.test.ts` — vitest cases covering
  cache hit, LLM generate + persist + render, hook fallback on LLM
  failure, every guard rejection, missing-data paths, Cloud Run
  errors, HEAD timeout, and payload shape (single `text` field, no
  `hook`/`poster_text` leak).

**Publishers (3 files):**
- `lorewire-app/src/lib/publish-to-instagram.ts` — `runFullPipeline`
  calls `ensureShortPoster` before `createContainer`; `createContainer`
  gains an optional `posterUrl` param that adds `cover_url=...` to
  the v22 Reels media POST. `thumb_offset=0` (PR #137) stays as the
  safety net.
- `lorewire-app/src/lib/publish-to-youtube.ts` — both
  `publishShortToYouTube` and `attemptYouTubePublishForRow` now
  resolve `poster?.url ?? scene-1` before passing to
  `runUploadPipeline`. The `videos.thumbnails.set` call from PR #137
  uses whichever URL won. (YouTube channel verification probe
  2026-06-29 returned HTTP 403 — Phase 2 ships with the YT wiring
  on; the cover step auto-recovers the moment Yoav verifies the
  channel via YouTube Studio.)
- `lorewire-app/src/lib/publish-to-facebook.ts` — same pattern. The
  multipart `thumb` fetch from PR #137 uses the poster URL when
  available.

**TikTok**: unchanged (no API for cover URL, splice fix already
gives it the right frame 0).

**Site**: unchanged.

**Test totals**: 64 TS server + 34 Python narration + 91 vitest
publisher suite (full vitest = 2216/2222, 2 pre-existing failures
on baseline unrelated to this work).

**Deploy posture**: same two-stage as the revised plan. Cloud Run
FIRST (`npm run deploy:cloud-run` from `video/`), curl-validation
gate, then Vercel merge. PR targets
`feat/multi-platform-shorts-publisher` per AGENTS.md inverted state.

## Why this exists

PR #137 wired each social publisher (IG / YouTube / FB / TikTok) to
send `short_config.doodle_frames[0].url` (scene-1) as the cover image.
Scene-1 is a story illustration; better than letting the platform
auto-pick, but still story content, not a designed thumbnail tile.
Yoav reviewed PIL renders of the proposed Phase 2 design (scene-1
top 70%, dark band bottom 30% carrying hook text + brand pill) and
locked it in.

Phase 2 generates a deliberate poster image at publish time and uses
it as the cover instead of raw scene-1 — but with two real constraints
that came out of the council pressure-test and a YouTube API probe:

1. **YouTube custom-thumbnail is BLOCKED until channel verification.**
   2026-06-28 probe against the live YouTube Data API returned HTTP
   403 (`youtube.thumbnail / forbidden`) on `thumbnails.set`. PR
   #137's YouTube wiring has been silently 403-ing on every publish
   since today's merge — best-effort design means the publish itself
   succeeds and YouTube falls back to its smart-picker. Phase 2
   keeps the YouTube wiring on (Yoav's call) so the moment channel
   verification clears in YouTube Studio, every subsequent publish
   picks up the custom thumbnail with zero code change.
2. **TikTok is untouched.** Its Content Posting API only accepts a
   `video_cover_timestamp_ms`, not an arbitrary cover URL. With the
   hook-first splice (PR #135) frame 0 is already the right scene
   for TikTok.

So Phase 2's actual cover wins land on **IG + FB today, plus YouTube
the moment Yoav verifies the channel**. Same code ships for all three.

## Architectural decisions locked by Yoav

- **Social-only.** The site continues to use scene-1 / hero where it
  already does. No site-side rendering changes. Phase 3 may reverse
  this (per the Expansionist council voice — surface `posterUrl` on
  OG cards / homepage rails / email) but v1 stays out of the site
  paths to keep blast radius bounded.
- **Publish-time generation, lazy + cached.** A story that never
  publishes never generates a poster. Same story across multiple
  platforms re-uses one cached render.
- **Cache by content hash.** Deterministic GCS URL
  `{storyId}-short/poster-{sha256(scene_1_url + hook + POSTER_VERSION).slice(0,16)}.png`.
  Hook edit → different hash → fresh poster auto-renders on next
  publish. Design change → bump `POSTER_VERSION` → all posters
  re-render lazily on next publish. **`POSTER_VERSION` in the hash is
  a council fix** (the original plan excluded design tokens, which
  meant a band-height tweak would have orphaned every existing
  poster forever).

## Council fixes absorbed into this revision

The original draft was councilled and the verdict was "reject as
written; fix these specific bugs before shipping." The revisions:

1. **Hook source = `script.hook` from props**, NOT caption-concat.
   Caption-concat would have shipped posters reading mid-clause
   text like "The night the archive burned a librarian still." A
   trivial Python pipeline change (one field added to the props
   dict in `pipeline/shorts_render.py::build_short_props`)
   eliminates the entire failure mode.
2. **`POSTER_VERSION = "v1"` baked into the cache hash** so a design
   token tweak (band height, font, colors) invalidates the cache
   without a backfill script.
3. **8-second timeout on `ensureShortPoster`** so a slow Cloud Run
   round-trip can't drag publish latency.
4. **Local-first development.** Build `PosterStill.tsx` first; render
   10+ real production story payloads via `npx remotion still`
   locally before touching the Cloud Run server. Catches typography
   failures (long hooks, em dashes, smart quotes producing tofu) in
   20 minutes instead of after a deploy.
5. **Glyph coverage validation in the composition.** Refuse to cache
   a render where any character maps to the fallback glyph. Prevents
   the First Principles council voice's predicted failure mode of
   "tofu boxes cached forever for that story."
6. **Font: Bebas Neue (or Anton / Oswald), NOT Impact.** The Outsider
   council voice flagged that Impact + dark band = the most overused
   AI-Shorts-farm pattern on the internet. Bebas Neue is the next-
   nearest condensed-display face that doesn't carry the same
   pattern-match. Open question §5 — could swap to a hand-drawn face
   later if the brand wants to lean harder into doodle craft.
7. **Brand-safety check on the rendered hook string** before render.
   Reuses the existing `pipeline/shorts_safety.py` profanity / all-
   caps-shock regex (already enforced at script generation time, so
   in practice this is a defense-in-depth check that almost always
   passes).
8. **RTL guard.** v1 fails the render with a clear log line if the
   hook contains non-Latin characters (Hebrew etc.). LoreWire's
   shorts pipeline is English-only today; this guard prevents silent
   broken renders if a future Hebrew hook lands before we add
   right-to-left composition support.
9. **YouTube 403 documented as expected**, not a defect. The publish
   succeeds; the thumbnail step logs `custom_thumbnail_failed` with
   `http_status=403`. Auto-recovers the moment Yoav verifies the
   channel in YouTube Studio.
10. **`ensureShortPoster` returns a shape future-proofed for Phase 3.**
    Not a bare URL string but `{ url, alt, hash, source }` so the
    OG / email / homepage rail consumers (when Phase 3 lands) can
    reuse the same helper without re-deriving paths.
11. **Concrete deploy gate between Cloud Run and Vercel:** a manual
    `curl POST /render-poster` against the new revision with a real
    story ID, confirm 200 + valid PNG in GCS. Without this gate,
    "Cloud Run first" is ceremony.

## Goals

1. Every IG / FB publish (+ YouTube once verified) ships with a
   designed cover — scene-1 above, solid dark band below with hook
   text + LoreWire-red brand pill in the corner — instead of raw
   scene-1.
2. Posters cached by content hash so a second-platform publish of
   the same story re-uses one render. No duplicate work.
3. Hook edits, scene-1 edits, and design-token changes all
   auto-invalidate the cache (hook & scene part of the hash; design
   via `POSTER_VERSION` constant). No "regenerate poster" admin
   button needed.
4. Site rendering paths are not touched. No new fields in the
   article reader.
5. Best-effort end-to-end: poster fetch failure, Cloud Run error,
   missing fields, or glyph fallback all return null from
   `ensureShortPoster`. The publisher falls back to PR #137's
   scene-1-as-cover behavior. The publish itself never blocks.

## Constraints

- Tech: **Remotion `renderStill`** running on the existing Cloud Run
  service (`video/server/`). Already has the Remotion bundle +
  `@remotion/bundler` + `@remotion/renderer`. Adding the still
  composition is a 1-file change + a new HTTP endpoint.
- Hook source: `script.hook` from props (post Part 0 below). Length
  capped at 80 chars at the composition level; longer hooks
  truncate with an ellipsis. The hook source field gets persisted
  by Part 0 so the publisher's `ensureShortPoster` can read it from
  `short_renders.props` directly.
- Per global rule 8: zero new external cost. `renderStill` runs on
  Cloud Run already paid for. Poster PNG is ~150 KB; 30 stories ×
  150 KB = 5 MB of GCS storage. Per-publish cost: one ~500 ms
  HTTP round-trip to Cloud Run on first publish per story, zero
  cost on subsequent publishes (cache hit on the same posterUrl).

## Chosen approach

### Part 0 — preserve `script.hook` AND `script.poster_text` in props (Python pipeline)

File: `pipeline/shorts_render.py::build_short_props`.

The existing props dict carries `title`, `voiceover_url`,
`doodle_frames`, `captions`, `hook_end_ms`, etc. — but not the
spoken hook string itself (it's read at script-generation time and
dropped). Two fields added:

```python
"hook": (assets.script.get("hook") or "").strip(),
"poster_text": (assets.script.get("poster_text") or "").strip(),
```

Plus a new LLM block `_poster_text_block()` in
`pipeline/shorts_narration.py` teaches the script generator to
produce an 8–14 word climax-revealing line specifically for the
static grid tile (separate from the spoken cold-open hook which is
intentionally oblique). Output schema gains a `poster_text` field.

The dispatcher
`lorewire-app/src/app/api/render_short/route.ts` strips BOTH
fields (`hook` + `poster_text`) from inputProps before forwarding
to Cloud Run's `/render` endpoint, since DoodleShort doesn't accept
them (would be phantom props). Two new helpers
(`stripHookFromProps`, `stripPosterTextFromProps`) mirror the
existing `extractHookEndSecFromProps` pattern. The poster renderer
reads both fields directly from `short_renders.props` via
`ensureShortPoster`.

For stories rendered BEFORE this Part ships, both fields are missing
→ `ensureShortPoster` returns null → publisher falls back to PR #137's
scene-1-as-cover. No regression for legacy rows.

### Part 1 — Remotion still composition

File: `video/src/PosterStill.tsx` (new).

A React component for `renderStill`:

- Canvas: 1080×1920 RGB.
- Top 1344 px: `Img` with the scene-1 URL, `objectFit: cover`,
  anchored TOP-center via CSS `objectPosition: top` so character
  heads stay visible (mirrors the PIL preview's `fit_top_image`
  logic).
- Bottom 576 px: solid `#0F172A` (navy-near-black, matches the
  on-video caption stroke) with an 8 px red (`#DC2626`) accent
  stripe at the band's top edge.
- Hook text: **Bebas Neue** display font (Google Font, ships in
  Remotion's font registry), white, uppercase, centered in the
  band, auto-sized 58–110 pt so 2–12 word hooks all fit. Cap at 3
  lines. Truncate with `…` past 3 lines.
- Brand pill: bottom-right inside the band, red (`#DC2626`),
  white Arial-bold "LORE WIRE" wordmark at 34 pt.

Registered in `video/src/Root.tsx` alongside `DoodleShort` so the
same Remotion bundle serves both.

**Glyph coverage validation**: render returns failure if any
character of the rendered hook string maps to the font's `.notdef`
glyph. Implementation: pre-render width-measure each character; if
the measurement equals the `.notdef` advance width, refuse the
render. Cloud Run returns a 422 with the failing characters; the
helper does NOT cache the failed result so a font fix on next
deploy can recover.

**RTL guard**: composition refuses to render if the hook contains
characters in `\p{Script=Hebrew}` / `\p{Script=Arabic}` / etc.
Returns 422 with `reason: "rtl_unsupported"`. v1 is English-only;
RTL is a Phase 2.5 if we ship Hebrew content later.

### Part 2 — Cloud Run `POST /render-poster` endpoint

Files: `video/server/render.ts` + `video/server/index.ts`.

Endpoint:

```
POST /render-poster
Authorization: Bearer ${CRON_SECRET}
Body: {
  storyId: string,
  hash: string,            // caller computes; server does NOT re-derive
  inputProps: {
    scene_1_url: string,   // ≤ 2000 chars
    hook: string,          // ≤ 200 chars
    brand_text: string,    // "LORE WIRE" today, future per-channel
  },
}
```

Caller computes the hash so cache-key logic lives in ONE place
(the helper). Server is dumb.

Handler:

1. Validate body shape (length caps + non-empty).
2. `selectComposition` for `PosterStill`.
3. `renderStill` to `/tmp/{sanitized}-poster-{hash}.png`.
4. Glyph + RTL validators run inside `PosterStill` itself; failed
   render → 422 with reason.
5. Upload to GCS / R2 (existing writer gate) at
   `{storyId}-short/poster-{hash}.png` with `Content-Type: image/png`
   and `Cache-Control: public, max-age=31536000, immutable`.
6. Return `{ url, elapsed_ms, hash }`.

Reuses every helper already in `render.ts`: bundle handle, R2 vs
GCS gate, sanitization, error normalization.

### Part 3 — Shared `ensureShortPoster` helper

File: `lorewire-app/src/lib/short-poster.ts` (new).

```ts
export interface ShortPoster {
  url: string;
  alt: string;     // brand-safe description for OG / a11y, e.g. "Lorewire short: {hook}"
  hash: string;
  source: "cached" | "rendered" | "failed";
}

export async function ensureShortPoster(
  storyId: string,
  opts?: { fetch?: PosterFetchLike; timeoutMs?: number },
): Promise<ShortPoster | null>
```

Flow:

```
1. Resolve scene_1_url + hook from short_renders.props
   (the freshest row for the story). If hook is missing
   (legacy row) → return null. If scene_1_url is missing →
   return null.

2. Brand-safety regex check on the hook (reuse the existing
   shorts_safety wordlist). If hits → log + return null.

3. hash = sha256(scene_1_url + "\n" + hook + "\n" + POSTER_VERSION)
      .slice(0,16).

4. posterUrl = `${MEDIA_PUBLIC_BASE or GCS_BUCKET_URL}/
       {storyId}-short/poster-{hash}.png`.

5. HEAD posterUrl with AbortSignal.timeout(2000). If 200 → return
   { url, alt, hash, source: "cached" }.

6. POST to ${CLOUD_RUN_RENDER_URL}/render-poster with the inputs
   + hash + storyId. AbortSignal.timeout(8000). On 200 → return
   the URL it gives back, source: "rendered".

7. On any failure (HEAD network error, Cloud Run error, timeout,
   glyph fallback 422, RTL guard 422) → log + return null.
   Caller falls back to PR #137's scene-1 URL.
```

The function is best-effort. Never throws. The structured return
shape lets the OG / email / homepage consumers (when Phase 3 ships)
reuse the helper without re-deriving GCS paths.

### Part 4 — Wire publishers

Files:
- `lorewire-app/src/lib/publish-to-instagram.ts`
- `lorewire-app/src/lib/publish-to-youtube.ts`
- `lorewire-app/src/lib/publish-to-facebook.ts`

Pattern per publisher:

```ts
const poster = await ensureShortPoster(args.storyId);
const coverUrl = poster?.url ?? (await resolveShortThumbnailUrl(args.storyId));
```

Wiring per platform:

- **IG Reels**: keep `thumb_offset="0"` (PR #137 contract), ADD
  `cover_url=coverUrl` on the container POST when present. v22
  Reels media containers accept `cover_url` as a static override;
  if it gets rejected the platform falls back to thumb_offset
  which still works thanks to PR #135.
- **YouTube** (silent 403 until verification): `uploadCustomThumbnail`
  uses `coverUrl` (poster if available, else scene-1). Same best-
  effort error handling from PR #137. When verification clears,
  this just starts succeeding with no code change.
- **Facebook**: `postVideo`'s multipart `thumb` fetches `coverUrl`
  bytes. Same fallback chain as PR #137 — fetch failure or null
  poster URL → url-encoded `file_url` path.

Each call site logs:
`[publish {platform} cover] source=poster|scene_1|none hash=... url_host=...`

### Part 5 — TikTok left alone

`publish-to-tiktok.ts` keeps `video_cover_timestamp_ms=0`. Per
Yoav's explicit decision: TikTok's API doesn't accept an arbitrary
cover URL, and the splice fix (PR #135) already gives it the right
scene at frame 0.

## Alternatives rejected (with council-surfaced reasoning)

1. **Eager poster generation at short-render time.** Rejected:
   adds latency to every short, even ones that never publish.

2. **Caption-concat hook source** (original plan). Rejected by the
   council: ships mid-clause garbage. The "avoids a Python pipeline
   change" justification was the kind of shortcut that produces
   visually-broken posters on a grid meant to look deliberate.

3. **"Burn the hook + brand pill into the first 30 frames of the
   existing MP4 render"** (First Principles council voice).
   Rejected because:
   - It produces a single artifact (the MP4) tied to the video
     instance; the poster as a separate PNG is reusable across
     OG cards, share embeds, email hero (Expansionist's Phase 3
     surfaces). Burning into the MP4 forfeits that optionality.
   - It can't be regenerated cheaply when the hook is edited —
     would require re-rendering the whole short, not a 200KB PNG.
   - The "cover is barely seen on platforms that auto-play"
     premise is partially true on IG / TikTok but FALSE on the
     IG grid view (where the cover IS the whole tile) and on
     YouTube Shorts (where the thumbnail decides shelf inclusion).
   Worth re-evaluating if Phase 2 ships and we measure cover-CTR
   showing no lift over the splice-fix baseline.

4. **"Kill the band entirely, doodle full-bleed, hand-drawn hook
   matching the illustration"** (Outsider council voice).
   Rejected: hand-drawn-per-story is unshippable at LoreWire's
   publish cadence. The dark band is correctly the most-legible-
   at-90px-grid option. Adopted the SOFTER fix: swap Impact for
   Bebas Neue to dodge the AI-farm pattern-match.

5. **"Build the canonical artwork pipeline now — OG cards, email,
   homepage rails, merch"** (Expansionist council voice). Adopted
   in spirit (`ensureShortPoster` returns a structured shape
   future-proofed for these surfaces) but the actual additional
   wiring is Phase 3 scope, not v1. v1 ships posters only on the
   three social publishers.

6. **`cover_url` on IG instead of `thumb_offset`.** Original plan
   had this. v22 docs are inconsistent for Reels media_type. Keep
   thumb_offset (proven via PR #137) AND ADD cover_url; the
   splice fix means thumb_offset=0 is always correct as a fallback
   if cover_url is silently ignored.

## Open questions

1. **YouTube channel verification.** Yoav verifies via YouTube
   Studio → Settings → Channel → Feature eligibility →
   Intermediate features. ~5 min, requires phone verification.
   Until then, YouTube publishes log
   `custom_thumbnail_failed http_status=403` (steady state, not
   a defect).
2. **Legal / likeness risk on the doodle illustrations**, surfaced
   by the council. The scene-1 doodles are AI-generated of
   non-recognizable people in domestic settings (LoreWire's content
   format). v1 ships without a likeness-check gate; takedown path
   is the existing delete-and-republish flow (purges GCS + the
   posted post). Re-evaluate if a doodle ever depicts a recognized
   figure (Phase 2.5 would add a likeness-check via a vision
   model).
3. **Permanent embarrassments after publish.** Once IG / FB have
   the cover, it can't be replaced on existing posts. A typo, a
   misframed crop, or a misaligned pill ships forever on THAT
   post. v1 accepts this — the helper's brand-safety check + glyph
   validation + RTL guard cover the common failure modes. If we
   ever see a permanent embarrassment, the operator can delete-
   and-republish (the same path used for the Phase 1 bug fixes).
4. **Phase 3 reuse**: when do we ship `posterUrl` to OG cards,
   email hero, and homepage rails (the Expansionist voice's
   recommendation)? Separate plan, separate decision. v1 keeps
   the helper API future-proofed for it.
5. **Font choice**: Bebas Neue is the v1 pick. If brand wants to
   lean harder into doodle craft, swap to a hand-drawn face like
   "Patrick Hand" or "Caveat" — same swap, single token change in
   `PosterStill.tsx`.

## Security

- `/render-poster` requires `Authorization: Bearer ${CRON_SECRET}`,
  same as `/render`. No new auth surface.
- Body validation: caller-supplied hash is OPAQUE (server doesn't
  parse it); URL + hook caps prevent oversized payloads. Hash
  format validated as `[a-f0-9]{16}` so it can be safely
  interpolated into a GCS path without escape-aware logic.
- No PII in logs. New fields: `source`, `hash` (16 hex chars),
  `http_status`, `elapsed_ms`, `story_id`.
- Cached PNGs sit on the same public bucket as rendered MP4s.
- Brand-safety regex defends against ALL-CAPS profanity and
  monetization-killer terms leaking from a corrupt script row.
- RTL guard prevents silent visual breakage if non-Latin hooks
  ever land.

## Observability

Per global rule 14:

- `[poster ensure] source=cached|rendered|none hash=... elapsed_ms=... story_id=...`
- `[poster ensure] skipped reason=missing_hook|missing_scene|brand_safety|... story_id=...`
- `[poster render] start hash=... story_id=...`
- `[poster render] done hash=... elapsed_ms=... bytes=...`
- `[poster render] failed reason=glyph_fallback|rtl|cloud_run_5xx|timeout story_id=...`
- `[cloud-run poster received] story_id=... hash=...`
- `[cloud-run poster done] story_id=... url_bytes=... elapsed_ms=...`
- `[cloud-run poster failed] story_id=... reason=... http_status=...`
- `[publish {platform} cover] source=poster|scene_1|none hash=... url_host=...`

Existing publisher logs from PR #137 keep their shape; `source`
adds context.

## Settings

Per global rule 15:

- `publisher.short_poster.enabled` (default ON) — kill-switch for
  the entire Phase 2 path. OFF reverts every publisher to PR #137
  behavior (scene-1 as cover).
- Not exposed: design tokens (band height, fonts, colors). Brand
  invariants. Bump `POSTER_VERSION` to invalidate the cache after
  a token change.
- Not exposed: per-platform toggle. Either Phase 2 is on
  (renders for all) or off.

## Testing

Per global rule 18:

### Local-first iteration (BEFORE any server / publisher work)

1. Build `PosterStill.tsx` + register in `Root.tsx`.
2. Pull 10 real production story payloads via the existing tmp
   scripts in `C:/tmp/posterpreview/` (or the equivalent helper).
3. Run `cd video && npx remotion still src/Root.tsx PosterStill
   out.png --props='{"scene_1_url":"...","hook":"...","brand_text":"LORE WIRE"}'`
   for each payload. Eyeball.
4. Specifically test edge cases:
   - 1-word hook ("Gone.")
   - 12-word hook
   - Hook with em dash, smart quotes, ellipsis
   - Hook in all caps in the source
   - Scene-1 that's mostly dark (band contrast)
   - Scene-1 that's mostly bright (band contrast)
   - Character heads anchored low in scene-1 (crop)
5. Glyph validation: feed a Cyrillic hook intentionally — render
   must refuse with `reason: "glyph_fallback"`.

ONLY after all 10 render visually cleanly: proceed to Part 2.

### Vitest unit tests

- `lib/short-poster.test.ts` (new):
  - happy: scene_1 + hook → HEAD 200 → returns `{ source: "cached" }`
  - cache miss: HEAD 404 → POST Cloud Run → returns
    `{ source: "rendered" }`
  - hook missing → null
  - scene_1 missing → null
  - brand-safety regex hit → null, logged `brand_safety`
  - HEAD timeout → falls through to POST (treat as "assume not cached")
  - POST timeout (>8s) → null
  - Cloud Run 500 → null
  - Cloud Run 422 (glyph fallback) → null, NO retry, NO cache
  - hash stability: same inputs → same hash; hash sensitivity:
    edit hook → different hash
  - POSTER_VERSION change: same inputs but version bumped →
    different hash → fresh render path
- `lib/publish-to-instagram.test.ts` (extend): container body
  includes `cover_url={posterUrl}` when poster resolves; still
  includes `thumb_offset=0`
- `lib/publish-to-youtube.test.ts` (extend): `uploadCustomThumbnail`
  called with `posterUrl` not raw scene-1
- `lib/publish-to-facebook.test.ts` (extend): multipart `thumb`
  part carries the poster bytes when poster resolves

### Cloud Run server tests

- `video/server/index.test.mjs` (extend):
  - `/render-poster` 401 without auth
  - 400 on missing body fields
  - 200 with stubbed render
  - hash format validation (rejects `../escape`)
- `video/server/poster.test.mjs` (new): pure-function test of the
  Remotion render shape; stubbed `renderStill` returning a fake
  buffer.

### Manual smoke (post-Vercel-deploy)

1. Trigger one IG publish via the admin manual re-publish flow.
2. Tail the publish log: confirm `source=rendered` (first publish)
   then re-trigger and confirm `source=cached`.
3. Visit IG; confirm the grid tile is the designed poster.
4. Repeat for FB.
5. Repeat for YouTube AFTER you verify the channel — should see
   `source=poster` in `[publish youtube cover]` AND
   `custom_thumbnail_ok` in the existing logs (no more 403).

## Deploy

Per global rule 19 + `lorewire-app/AGENTS.md`:

**Current state**: production-source is
`feat/multi-platform-shorts-publisher` at `818bdbf` (PR #137).
`main` is still behind (inverted state).

**Branch**: `feat/social-poster-render` off `818bdbf`. One PR.

**Two-stage deploy** because Cloud Run + Vercel deploy separately:

1. **Cloud Run image rebuild FIRST.** The new `/render-poster`
   endpoint + `PosterStill` composition only exist after the
   Cloud Run redeploy. Run `npm run deploy:cloud-run` from
   `video/` against the existing service account.
2. **Explicit deploy gate**: `curl -X POST https://<cloud-run-url>/render-poster`
   with a real Bearer token + a real story payload; confirm 200 +
   PNG appears in GCS at the deterministic URL. Without this gate,
   "Cloud Run first" is ceremony.
3. **Vercel merge auto-deploy SECOND.** Merge the PR to
   `feat/multi-platform-shorts-publisher`. Vercel auto-deploys
   the helper + publisher wiring. The publishers' first call into
   `/render-poster` succeeds because Cloud Run has the endpoint
   from steps 1-2.

**If sequencing breaks**: publishers POST to a `/render-poster`
that 404s, `ensureShortPoster` catches the error and returns null,
publishers fall back to scene-1 (PR #137 behavior). No regression,
just no posters until Cloud Run catches up.

**Rollback**:
- Vercel: `git revert` of the merge commit. Auto-redeploys to
  PR #137 state.
- Cloud Run: redeploy previous image. Optional; the old endpoint
  just becomes unused if Vercel rolls back.

**Do NOT click manual Vercel UI promotion buttons.**

**Confirm with Yoav before pushing.**

## What this plan does NOT do

- Does not change the site rendering paths.
- Does not change the shorts render pipeline (except Part 0's
  one-field addition to `props`).
- Does not change the splice (PR #135) or the PR #137 publisher
  cover fallback. Both stay as the safety net.
- Does not generate posters for the ~6 already-published IG / YT /
  FB posts on the platforms. Those need manual re-publish (delete
  + repost via each platform's admin editor), which triggers a
  fresh `ensureShortPoster`. Same operator action already on Yoav's
  list.
- Does not introduce a per-story hook override knob. Hook lives in
  `script.hook` (preserved by Part 0).
- Does not touch TikTok.
- Does not unlock YouTube custom thumbnails (that's a YouTube
  Studio action by Yoav, not a code change).
- Does not surface `posterUrl` on the site (Phase 3).
- Does not add a likeness-check on the doodle (Phase 2.5 if a
  recognized-figure incident ever happens).
- Does not support RTL hooks (Phase 2.5 if Hebrew content lands).
