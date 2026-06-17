# Reels — vertical swipeable video feed

Date: 2026-06-17
Branch: `feat/reels-feed` (cut from `fix/mobile-short-gallery-captions-and-play`).
Status: IN PROGRESS. Decisions resolved (drop fake counts; engine = native
scroll-snap + desktop paging). DONE: Phase 1 (data action), Phase 2 (mobile
feed UI), Phase 3 (active-index autoplay + mute), Phase 5 (infinite scroll),
Phase 6 (engagement rail — local Like, Save->My List, Share to /v/[slug]),
Phase 7 (deep-link: "Play Something" opens the feed; initialStoryId scrolls to
a loaded short), plus reduced-motion. My List is now a persisted localStorage
store (lib/engagement-store) shared by the feed, the My List tab, and the Title
sheet; MyList resolves saved ids via the live catalog (not byId, which threw on
real short ids). NEXT: Phase 8 desktop adapter, Phase 9 full a11y/QA, and the
deep-link "fetch-around" so an arbitrary short (not just one on a loaded page)
can be jumped to. The standalone /reels route was intentionally NOT built — the
shell's nav is client-state tabs, so Reels is a 5th in-shell tab (matches
Home/Search/New/My List); shareable per-reel URLs still use /v/[slug].

## Goal

A TikTok / Instagram-Reels style full-screen vertical video feed for LoreWire
stories: one short per screen, swipe up/down on mobile, arrow/wheel/buttons on
desktop, the current video autoplays and the rest are paused. The feed is a
first-class surface, also reachable from the existing Billboard Play / Shuffle.

Each short is a trailer into the full story: the feed's "more info" opens the
existing Title sheet so Read / Read-along still work. That swipe-to-read loop is
the thing that makes this more than a TikTok clone (see Council, below).

## Locked decisions (from the user)

1. **Placement** — user answered "all 3": a new **Reels** bottom-nav tab
   (primary, most discoverable), ALSO reachable from the Billboard Play /
   Shuffle buttons via deep-link, and prominent enough to feel first-class. We
   KEEP the existing Netflix-style Home (we are not replacing it).
2. **Content** — 9:16 vertical **shorts only**. Filter the published catalog to
   rows whose `video_url` matches the short suffix `-short/video.mp4`
   (`SHORT_VIDEO_PATH_RE` in `src/app/actions.ts`).
3. **Platform** — BOTH mobile (touch swipe) and desktop (discrete paging) in
   this build.
4. **Interactions** — engagement chrome (like / save / share). SEE the honesty
   amendment below — this is the one place the plan pushes back on the locked
   choice.

## What the LLM Council changed (2026-06-17)

Ran the design through the council (Contrarian / First-Principles / Expansionist
/ Outsider / Executor + peer review). High-confidence outcomes:

- **Engine:** `scroll-snap-type: y mandatory` + IntersectionObserver is right for
  MOBILE touch IF hardened, but reusing it for desktop is wrong — mouse wheel is
  continuous and snap feels mushy/overshoots. Desktop gets **discrete paging**
  (Arrow/Space/PageUp-Down + on-screen up/down buttons + debounced wheel = one
  step per notch), not scroll-jacking. One component, two input adapters.
- **Mobile Safari traps:** `100dvh` shifts when the URL bar collapses and breaks
  snap mid-scroll; a fast flick crosses 2-3 sections and makes naive "play
  active" logic thrash. Mitigations baked into the plan (viewport units,
  `scroll-snap-stop: always`, debounced active-index driven by scroll settling,
  not by every IO fire).
- **Engagement honesty (the pushback):** fabricated like/share COUNTS are a lie
  the user catches the instant they tap and nothing real moves; the Outsider
  closes the tab when "Save" goes nowhere. So:
  - **Like** — real local toggle, NO fabricated count. Just a filled/unfilled
    heart, persisted in localStorage.
  - **Save** — real: writes to the existing My List (currently client state;
    promote to localStorage so it actually persists and the feed + My List
    share it).
  - **Share** — real `navigator.share` with a clipboard fallback to the
    canonical `/v/[slug]` URL.
  - No comments (there's no comment system; faking threads is worse).
  - Buttons are wired to a small client event layer so that the day real
    accounts ship, we swap localStorage for a server call with zero UI rework
    (pre-instrumenting, per the Expansionist).
- **Aliveness (First-Principles):** with no ranking, a fixed `published_at`
  order means everyone sees the same sequence forever and a returning user
  restarts at the top. Cheap fix: a **seeded shuffle** (rotate the seed daily)
  plus **resume position** (remember the last short id in localStorage and offer
  "resume"). Not a recommender — just enough that visit two isn't dead.
- **Accessibility (caught in peer review, missed by every advisor):** honor
  `prefers-reduced-motion` (no autoplay — show the poster with a tap-to-play),
  full keyboard support, visible focus, don't trap the user (clear way back to
  the tab bar / Home), and note that burned-in captions cannot be toggled or
  translated (acceptable for v1, flagged for later).

## Architecture

### Data layer (Phase 1, do this first)

New server action in `src/app/actions.ts`, mirroring `getLiveCatalog`:

```
listPublishedShorts({ limit = 12, beforePublishedAt? }): {
  ok, shorts: ReelItem[], nextCursor: string | null
}
```

- `WHERE status='published' AND published_at IS NOT NULL AND slug IS NOT NULL
   AND (noindex IS NULL OR noindex = 0) AND video_url LIKE '%-short/video.mp4%'`
  (parameterised LIKE, not the JS regex — keep the filter in SQL so paging is
  correct). Cross-check the suffix with `isShortVideoUrl` after fetch as a belt.
- `ORDER BY published_at DESC, id DESC` (id tiebreak so the cursor is stable);
  cursor = `published_at` of the last row, `beforePublishedAt` pages older.
- Project only what a card needs: `id, slug, title, category, summary,
  hero_image, video_url, duration, published_at`. Captions are BURNED INTO the
  MP4 — the feed does not need alignment/audio. This keeps the query and the
  payload small.
- Export `isShortVideoUrl` (currently module-private) for reuse, or duplicate
  the suffix regex in one shared spot.

### Components

- `src/app/reels/page.tsx` — server component, reads page 1 via
  `listPublishedShorts`, passes to the client feed. Also handles
  `?story=<id>` for deep-link (resolve its index / ensure it's in page 1, else
  fetch-around).
- `src/components/reels/ReelsFeed.tsx` — `"use client"`. Owns: the list, active
  index, autoplay/mute state, windowing, infinite scroll, input adapters
  (touch-scroll-snap vs desktop-paging chosen by the same lg breakpoint the rest
  of the app uses), and the deep-link initial scroll.
- `src/components/reels/ReelCard.tsx` — one short: `<video>` (when windowed in)
  or poster placeholder; overlay (title, category, the Like/Save/Share rail,
  mute toggle, a prominent "Read the story" affordance that opens the sheet).
- Reuse the EXISTING `TitleSheet` (mobile) / `DetailModal` (desktop) for
  "more info" — do not rebuild Read/Read-along. The Billboard Play/Shuffle entry
  routes to the Reels tab at that story.
- Add the **Reels** item to `TabBar` in `AppShell.tsx` (5th tab) and the desktop
  nav equivalent in `DesktopShell.tsx`.

### Autoplay + mute (the robust pattern)

- Active `<video>`: `muted`, `playsInline`, `autoPlay` off — call `.play()`
  imperatively when an element becomes active (muted play is allowed without a
  gesture on iOS). Pause + `currentTime = 0` (or just pause) on the others.
- A persistent **mute toggle** in the overlay; first tap anywhere on the active
  video can unmute (inside the gesture so Safari allows sound). Track mute as
  feed-level state so it persists across swipes.
- Guard the play/pause against the active index changing mid-gesture (debounce;
  ignore `.play()` rejections; only the currently-active id may be playing).
- `prefers-reduced-motion: reduce` → do not autoplay; show poster + a centered
  play button; the user opts in per video.

### Windowing + preload (cost + perf discipline)

- Mount a real `<video src>` only for `active-2 .. active+2`; everything else is
  a same-height poster `<div>` (so scroll-snap geometry stays correct).
- `preload="metadata"` on `active±1`; the active one is `auto` once it's active.
  Do NOT give full `src` (or set `preload="auto"`) to off-window items — that is
  the wasted-egress trap (downloading shorts the user scrolls past).
- Posters (`hero_image`) can be eager for the next couple; they're cheap.

### Desktop input adapter

- Centered 9:16 player (max-height viewport, letterbox sides expected and fine).
- Navigation: ArrowUp/ArrowDown, PageUp/PageDown, Space (next), on-screen
  up/down buttons, and wheel **debounced to one step per gesture** (accumulate
  delta, fire once, cool-down ~400ms). Do NOT use raw scroll-snap on wheel.
- Right-side vertical rail for Like/Save/Share like TikTok web.

## Cost (rule 8 — real current pricing, checked 2026-06-17)

Videos are MP4s on Google Cloud Storage. Autoplay video in an infinite feed is a
bandwidth feature, so this is the real cost driver.

- **GCS direct internet egress:** ~**$0.12/GB** first 1 TB, $0.11/GB next 9 TB
  (tiered). (cloudzero, leanopstech.)
- **Google Cloud CDN cache egress (NA/EU):** ~**$0.08/GiB** first 10 TiB,
  declining with volume; cache fill ~$0.01/GiB; cache lookups
  $0.0075/10k requests. ~33% cheaper than raw egress and much cheaper at scale
  via edge cache hits on popular shorts. (cdnsun.)
- **Cloudflare free is NOT a valid option here** — its ToS prohibits serving
  video / large files on Free/Pro/Business (512 MB per-file cache limit). Do not
  put the MP4s behind Cloudflare's free plan. (blazingcdn.)
- Note: Google is raising CDN-Interconnect / peering egress ~2x effective
  May 2026 — watch if we ever add a third-party CDN via interconnect.

Back-of-envelope (≈12 MB per 50s short at ~2 Mbps):
- One full short view ≈ 0.012 GB ≈ **$0.0014** direct egress (~$1.44 / 1,000
  full views).
- A heavy doomscroll of 100 shorts ≈ 1.2 GB ≈ **$0.14** / session direct.
  10,000 such sessions/month ≈ **$1,440/mo** direct, ≈ **$960/mo** behind Cloud
  CDN (less with cache hits).

**Cost recommendation:** ship v1 served direct from GCS (cost is trivial at
launch scale). The windowing/preload discipline above is the main lever — it
stops us paying for videos nobody watched. Put **Google Cloud CDN** in front of
the bucket BEFORE this gets popular (it's a config change, not a rewrite, and
it both cuts egress and improves swipe latency). Add a simple per-session view
counter later if we want to watch the bill.

## Security & safety (rule 13)

- The new server action is PUBLIC and unauthenticated, like its siblings — it
  must only ever return already-public rows (the `status='published' AND
  published_at IS NOT NULL AND slug IS NOT NULL AND not-noindex` filter is
  load-bearing; mirror `listPublishedStories`/`getLiveCatalog` exactly).
- Parameterise the cursor; never string-concat `beforePublishedAt` into SQL.
  Clamp `limit` (1..50) like `getLiveCatalog` clamps to 500.
- No PII, no secrets, no auth tokens touched. localStorage holds only opaque
  story ids for like/save/resume — no sensitive data, safe if it leaks.
- `navigator.share` / clipboard only ever emit the public canonical `/v/[slug]`
  URL. No internal ids or GCS signed URLs exposed beyond what `/v` already does.
- Deep-link `?story=` must be treated as untrusted input: resolve it through the
  same public query; an unknown/unpublished id just falls back to the top of the
  feed, never errors or leaks existence.
- Don't log full GCS URLs or ids at info level in the hot path (matches the
  existing `console.warn`-on-error-only pattern).

## Build sequence (Executor's order)

1. **Data action** `listPublishedShorts` + a quick unit test on the suffix
   filter + cursor. No UI. (Verify it returns real `-short/video.mp4` rows.)
2. **Static feed:** `/reels` route + `ReelsFeed`/`ReelCard`, scroll-snap, one
   `<video>` per section, muted autoplay of ALL (ugly but proves layout). Mobile
   only.
3. **Active-index + play-only-active + tap-to-unmute + mute toggle.**
4. **Windowing (+/-2) + preload discipline.**
5. **Infinite scroll** on the cursor action.
6. **Engagement rail** (Like/Save→My List/Share) + localStorage + resume.
7. **Deep-link** `?story=` (mount that index first, scroll to it after layout
   settles) + wire Billboard Play/Shuffle + add the Reels tab.
8. **Desktop adapter** (discrete paging) — last, reusing the same component.
9. **Accessibility pass** (reduced-motion, keyboard, focus, way-out) + full QA.

Cut from v1 if time is short: desktop custom wheel-snap finesse (buttons +
keys are enough), seeded-shuffle (can ship `published_at` order first).

## Alternatives considered (engine) — rule 4

- **A. Hardened CSS scroll-snap (mobile) + discrete JS paging (desktop)
  [RECOMMENDED].** Native momentum + snap on touch (what users expect), zero new
  deps, smallest code. Desktop uses explicit paging so it doesn't inherit the
  mushy-wheel problem. Risk: iOS Safari snap/`dvh` quirks — mitigated above.
- **B. Transform-based JS pager (translateY + touch handlers) both surfaces.**
  Full control over the animation, no snap quirks, identical on both platforms.
  But you reimplement momentum/rubber-banding/velocity by hand — more code, more
  bugs, easy to feel "off" vs native. Overkill for v1.
- **C. Third-party library (Embla Carousel / Swiper, vertical mode).** Fast to a
  polished feel, handles a lot of edge cases. But adds a dependency + bundle
  weight, must be vetted via Context7 for Next 16 / React 19 compatibility, and
  we'd still hand-roll the autoplay/windowing logic. Reach for this only if A's
  hardening proves too fiddly in testing.

Recommendation: **A**. Start native, keep the door open to C if testing on real
iOS shows scroll-snap can't be tamed.

## Open questions

- ~~Engagement honesty~~ — RESOLVED 2026-06-17: DROP fabricated counts. Like =
  local heart, no number; Save = real persisted My List; Share = real `/v/[slug]`
  URL. (User confirmed, overriding the earlier "counts" choice.)
- Seeded shuffle vs strict newest-first for v1 order? Defaulting to
  **newest-first** for v1; seeded shuffle is a fast-follow.
- Reels tab is a **5th** tab (confirmed assumption), not replacing an existing
  one.

## QA / verification plan

- Golden path: open Reels, swipe 5+, only one plays, audio follows the active
  one, unmute sticks, "Read the story" opens the right sheet.
- Edge: 0 shorts (empty state), 1 short (no infinite-scroll thrash), fast flick
  (no stuck audio / double-play), deep-link to a mid-feed id, refresh mid-feed,
  back button, rotate, iOS URL-bar collapse, `prefers-reduced-motion` on.
- Cost: confirm off-window videos have no `src`/`auto` preload (Network panel:
  no MP4 bytes for items you didn't reach).
- Both TS projects typecheck (ignore the known pre-existing test-file errors
  listed in the 2026-06-15 handoff). Run `npm test`.
- Build-time gate: per `lorewire-app/AGENTS.md`, read the relevant Next 16 docs
  in `node_modules/next/dist/docs/` before writing route/server-action code, and
  consult Context7 for any library API (rule 9).
