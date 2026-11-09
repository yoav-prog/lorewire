# Skip Intro — story page, Wires, and an "Always skip intro" setting

Date: 2026-07-04
Branch: `feat/skip-intro` (off `origin/main` @ d510563)

## Goal

Every rendered LoreWire video carries the branded intro segment. Viewers who
watch several wires in a row see the same stinger every time. Give them a way
past it:

1. A "Skip intro" button on the story page (`/v/[slug]`) video and on every
   Wires card, shown only while the intro is actually on screen.
2. A "Always skip intro" toggle in `/settings` (and in the Wires "..." playback
   menu) that jumps the intro automatically on every video.
3. It must work on EXISTING videos, both generations:
   - hook-first renders (2026-06-28 onward): `[hook][intro][body][outro]` —
     the intro sits after the cold-open hook;
   - older renders: `[intro][body][outro]` — the intro is first.

## The core problem: where is the intro in the final MP4?

Nothing persisted today says "the intro spans [a, b] in the final timeline".
But the inputs to that math ARE persisted — on the story's latest DONE
`short_renders` row (its props blob is the render record):

- `short_renders.props.hook_end_ms` — where the hook ends (written by the
  Python pipeline; the dispatcher strips it only from the copy sent to
  Remotion).
- `short_renders.props.hook_tail_hold_ms` — per-video audio hold
  (paced-splice era, 2026-06-29 onward). Cloud Run floors it at 0.15s
  (`video/server/render.ts:MIN_HOOK_AUDIO_TAIL_HOLD_SEC`), fallback 0.3s when
  the field is absent.
- Paced-seam constants mirrored in `video/server/ffmpeg.ts` and
  `pipeline/segments.py`: fade 0.45s, hook gap 1.1s, intro gap 0.9s.
- The intro segment actually spliced: `short_config._last_rendered_segments.
  intro_segment_id` (stamped by the dispatcher at render-finish), falling back
  to the live resolver chain (`lib/short-segments.ts`) for rows that predate
  the stamp. Its length is `video_segments.duration_ms`.
- `short_renders.props.assembled_duration_ms` — real MP4 length (2026-06-29
  onward), used as a sanity clamp.

**Correction (2026-07-04, post-v1):** the first cut read these fields off
`stories.props`. That column is the story-world artwork LIST
(`{url,label,side}` dicts — `pipeline/store.py:update_story_props`), not the
render record, so every hook-first short classified as intro-first and the
button skipped the HOOK. The resolver now reads the latest done
`short_renders.props`; a short with no render record fails closed instead of
assuming intro-first.

**Also added post-v1:** the story detail's WATCH tab (DesktopShell modal +
AppShell title sheet) is a third player v1 missed — it now gets the same
button + always-skip via `getLiveStoryMedia.intro_window`. Deliberately NOT
covered: StoriesViewer (the ephemeral auto-advancing stories surface — its
playlist shape has no window plumbing; revisit if viewers ask).

### Final-timeline math (mirrors `video/server/ffmpeg.ts`)

- **Paced hook-first** (`hook_end_ms` present AND `hook_tail_hold_ms`
  present — the two shipped in the same plan, so tail-hold presence marks the
  paced generation). The window opens where hook CONTENT ends (the fade to
  black begins) so the button appears the moment the hook lands, and closes
  where story content resumes:
  - `intro_start = hook_end + max(150, tail_hold)`
  - `intro_end   = intro_start + 450 (fade) + 1100 (hook gap) + intro_duration + 900 (intro gap)`
- **Unpaced hook-first** (`hook_end_ms` present, `hook_tail_hold_ms` absent —
  the one-day 2026-06-28 generation, hard cuts, no pads):
  - `intro_start = hook_end`, `intro_end = hook_end + intro_duration`
- **Legacy intro-first** (no `hook_end_ms`; also long-form videos):
  - `intro_start = 0`, `intro_end = intro_duration`
- Fail closed: no intro segment resolved, non-positive window, or
  `intro_end` at/past `assembled_duration_ms` → no window → no button, no
  auto-skip. A missing button is a shrug; a wrong jump into the story is a bug.

### Future renders: persist the window

The dispatcher (`src/app/api/render_short/route.ts`) already knows every
input at render-finish (it computed `segments.hookEndSec` /
`hookTailHoldSec` and resolved the intro segment row). Compute
`intro_start_ms` / `intro_end_ms` there with the same pure function and pass
it to `finishShortRender`, which merges it onto `short_renders.props` beside
`assembled_duration_ms` (a null window deletes stale intro keys). No Cloud
Run change, no redeploy sequencing. The read-time derivation then only
serves rows rendered before this ships.

## Approach

1. **`src/lib/intro-window.ts`** (server-only resolver + pure math):
   - `deriveIntroWindow(...)` — pure, unit-tested, mirrors the splice math.
   - `introWindowFromPropsJson(...)` — reads explicit `intro_start_ms` /
     `intro_end_ms` (future renders).
   - `resolveIntroWindowForStory(row)` — explicit props → stamped segment id →
     resolver chain; returns `{ start_ms, end_ms } | null`.
2. **Dispatcher** persists the window on every new render (pure helper +
   tests beside the existing `extractHookEndSecFromProps` tests).
3. **Plumbing**:
   - `stories-public.ts`: add `props` to `PUBLIC_COLS` (server component only;
     raw props never reach the client — the page passes just the window).
   - `actions.ts:listPublishedShorts`: select the resolver inputs
     (`props`, `short_config`, segment columns), compute per row with one
     in-memory segment cache per call, ship `intro_window` on `WireStory`,
     never the raw props.
4. **Pref**: `lw.wires.skip_intro.v1` (default OFF) in `useWirePrefs`, same
   consent-gated `useSyncExternalStore` store as its siblings.
5. **Wires UI (`WireCard`)**: a "Skip intro" pill (bottom-right, above the
   scrubber), visible only while `currentTime` is inside the window; not part
   of the auto-hide chrome group (it is time-boxed by the intro itself).
   Auto-skip on natural entry into the window when the pref is on; a manual
   scrub INTO the window suppresses auto-skip (the viewer chose to watch it)
   but keeps the button. Loop restarts re-arm the auto-skip.
6. **Story page**: new `src/components/StoryVideo.tsx` client component
   wrapping the existing native-controls `<video>` (same markup + classes),
   plus the pill and the same auto-skip hook. `/v/[slug]/page.tsx` passes the
   server-resolved window.
7. **Settings**: "Always skip intro" ToggleRow in the Playback section, plus a
   matching row in the Wires "..." menu.

## Alternatives rejected

- **Have Cloud Run return the window** (it ffprobes the real file): most
  precise, but requires a Cloud Run deploy + revision sequencing, and does
  nothing for existing videos — which are the point of this feature. The
  dispatcher-side computation uses the same numbers Cloud Run splices with.
- **Backfill script writing windows into every published row**: same
  derivation code, but adds a migration surface and a stale-on-re-render
  hazard. Deriving at read time from the same inputs is idempotent and free.
- **Client-side heuristics (detect black frames / silence)**: unreliable,
  expensive, and unavailable before playback reaches the intro.

## Known imprecision (accepted)

- A row re-rendered post-2026-06-29 from pre-tail-hold props would be paced
  with the 0.3s fallback while my classifier reads it as unpaced. In practice
  Lane A/B re-renders recompute both hook fields together
  (`pipeline/shorts_lane_b.py`), so the population is ~empty; the
  `assembled_duration_ms` clamp catches gross mismatches.
- `video_segments.duration_ms` is the normalized probe; concat re-encode can
  drift it by a frame or two. The skip target lands inside the intro-gap
  black beat, so ±100ms is invisible.

## Settings audit (rule 15)

- New control: "Always skip intro" — Playback section, right after
  "Slow mode"; default OFF (the intro is brand surface; skipping is opt-in).
  Mirrored in the Wires "..." menu like autoplay/advance/slow.
- Deliberately NOT exposed: per-surface variants (one knob, both players) and
  the manual button (always available when a window exists — zero-config).

## Security

- No new user input reaches SQL or the render path. Props/short_config are
  parsed defensively (try/catch, type-checked) server-side; the client
  receives only two numbers. The pref is a consent-gated localStorage boolean,
  same trust level as the existing playback prefs. No PII, no new logging of
  sensitive data.

## Observability (rule 14)

- Server: `[intro-window]` info log in the dispatcher when persisting
  (story id, window, source values); resolver logs a per-story line on the
  story page and a per-page summary on the wires fetch (how many rows got a
  window, by generation).
- Client: `[wires skip-intro]` / `[story skip-intro]` logs on button show,
  button click, auto-skip fire, and suppression-by-manual-seek — each with
  id, window, currentTime.

## Testing (rule 18)

- `tests/lib/intro-window.test.ts` (or `src/lib/intro-window.test.ts`,
  matching the existing colocated pattern): paced / unpaced / legacy math,
  tail-hold floor, explicit-props path, malformed props JSON, missing intro,
  assembled-duration clamp, zero/negative guards.
- Dispatcher: pure `mergeIntroWindowIntoProps`-style helper tested beside
  `route.test.ts`'s existing prop-extractor tests.
- UI components have no DOM test rig in this repo (vitest node env); the skip
  decision logic is extracted into a pure helper so it IS unit-tested; the
  JSX layer is covered by the manual QA pass below.

## Deploy

- Standard flow: PR from `feat/skip-intro` into `main`; Vercel builds a
  preview; merge deploys production from post-merge main. No Cloud Run
  deploy, no env vars, no schema change (props keys only). Preview must NOT
  be manually promoted. Rollback = revert the merge commit.

## QA walk (rule 6/10)

- New wire (hook-first, paced): button appears exactly when the intro fades
  in, disappears when the story resumes; click lands on the story fade-in.
- Old wire (intro-first): with the setting ON the video starts at the story.
- Wire with no intro (body-only render): no button, no seek.
- Manual scrub back into the intro: button shows, no auto-jump.
- Loop mode: intro skips again on every loop when the setting is ON.
- Story page: native controls still work; pill doesn't cover them.
- Settings toggle round-trips (flip, refresh, verify), consent-declined
  session still toggles in-memory.
