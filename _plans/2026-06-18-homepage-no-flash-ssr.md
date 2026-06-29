# Homepage: kill the wrong-content flash by server-rendering curation + catalog

**Status:** approved 2026-06-18, ready to execute
**Author:** Claude (Opus 4.7) with Yoav
**Scope:** `src/app/page.tsx`, `src/components/AppShell.tsx`, `src/components/DesktopShell.tsx`, `src/lib/homepage-rails.ts`, one new `src/lib/homepage-data.ts`

## Goal

The first paint of `lorewire.com` shows the correct hero, Continue Watching, and rails. No 1-2 second window where the static sample catalog (`THE $800 ENVELOPE` + the four-card CW strip) appears and then reshuffles to the real data.

Success criteria, measured manually + in tests:

- View source on `/` returns HTML that already contains the live hero title and the curated rail titles (or live-derived fallback titles when no curation exists).
- Refreshing the homepage shows no visible content change after the initial paint.
- The static `STORIES` catalog only ever surfaces when the server-side fetch failed; that failure is logged with `[lorewire homepage ssr error]`.
- New unit tests in `src/lib/homepage-rails.test.ts` cover the hook's seeded path (no client fetch, `loaded=true` synchronously).

## Non-goals

- No design / layout changes. Visuals of hero, rails, and cards stay byte-identical.
- No caching layer added. The page is dynamic per request (matches the existing `/articles` index pattern and the decisions we made up-front).
- No change to `getLiveStoryMedia`, the Reels feed, the modal, the admin panels, or any non-home view.
- No rewrite of the static `STORIES` catalog. It stays as a server-side fallback.

## Constraints (from CLAUDE.md, AGENTS.md, current code)

- Next.js 16.2.9 + React 19.2.4. Cache Components is **not** enabled (see `next.config.ts`), so the legacy route segment config still works; we still won't use it — the default fetch-uncached behavior already gives us dynamic-per-request rendering, mirroring the `/articles` page.
- `AppShell`, `DesktopShell`, and the `useHomepage*` hooks are client components and stay that way (they own state, scroll listeners, browser-only effects).
- Server actions in `src/app/actions.ts` are marked `"use server"`. We won't call those directly from the new server component; instead we extract the underlying data fetches into a plain `src/lib/homepage-data.ts` server module that both the actions and the page can call. This keeps the action surface tight (rule 2 — clean / ordered) and avoids muddying the "use server" RPC boundary.
- Props passed from Server to Client Components must be serializable (per the Next.js Server/Client guide we read in-tree). All three payloads are plain JSON.

## Approach

1. **Extract data-fetch helpers into `src/lib/homepage-data.ts`** (new file, plain server module — no `"use server"`):
   - `loadHomepageCuration(): Promise<HomepageCurationResult>` — body moves verbatim from `actions.ts`.
   - `loadLiveCatalog(limit?: number): Promise<LiveCatalogResult>` — body moves verbatim.
   - `loadHomepagePolls(): Promise<HomepagePollRailsResult>` — body moves verbatim.
   - Existing `getHomepageCuration`, `getLiveCatalog`, `getHomepagePolls` in `actions.ts` become one-line `return load*(...)` wrappers. Their public types and signatures are unchanged so every existing client caller keeps working.

2. **Add `loadHomepageSSRData()` to the new module** — a single fan-out that runs all three loads in parallel with `Promise.all`, catches any failure per-source, logs `[lorewire homepage ssr error]` with the field that failed, and returns a steady-state object: `{ curation, behavior, liveRows, pollRails }`. On total failure all fields fall back to safe empties (null curation, default behavior, empty live rows, empty poll rails), which the existing hook already handles — that's the agreed "render with static catalog" failure mode.

3. **`src/app/page.tsx` becomes an async server component**:
   - Imports `loadHomepageSSRData` (server-only) and `AppShell` (client component).
   - Awaits the SSR data, passes it as a single `initial` prop: `<AppShell initial={initial} />`.
   - Adds a `[lorewire homepage ssr]` log with row counts (rule 14).

4. **`AppShell.tsx` accepts the prop and threads it through**:
   - New `AppShellProps = { initial: HomepageInitial }`.
   - `MobileShell` and `DesktopShell` receive `initial` and pass it to the hook calls.
   - Type `HomepageInitial` lives in `src/lib/homepage-rails.ts` so both shells and `page.tsx` import from the same place (single source of truth, rule 2).

5. **`useHomepageCuration(initial?)` and `useHomepagePolls(initial?)` accept an optional initial seed**:
   - When `initial` is provided, the hook initializes state from it and **skips the useEffect fetch entirely**. `loaded` starts `true`.
   - When `initial` is `undefined` (e.g. a future caller that doesn't pre-fetch), behavior is unchanged from today — `useEffect` runs the round trip exactly as it does now.
   - This preserves backwards compatibility for any in-flight code paths I might have missed and keeps tests for the unseeded path valid.

6. **Drop the `resolveStory("envelope")` ultimate fallback** in both shells (line 238 of `AppShell.tsx`, line 936 of `DesktopShell.tsx`). With SSR providing real data on first paint and the hook skipping its loading window, the only path that ever hit this fallback was the loading flash itself. The expression simplifies to `heroIds[0] && resolveStory(heroIds[0])`; when neither curation nor fallback resolves a hero (genuinely empty catalog), `heroStory` is `null` and the existing `{heroStory && <Hero …/>}` guards handle it. This deletes the line that hardcoded "the wrong title" into the failure path.

## Alternatives considered and rejected

- **A — Loading skeleton (gate on `loaded`)**: Smaller change but still shows a non-content first paint. Doesn't fix SEO; doesn't fix "the page rearranges under the user." Rejected at decision time in favor of B.
- **C — Hide only hero + CW while loading**: Lowest engineering cost. Trades wrong-hero flash for empty-hero flash, leaves other rails to shuffle later. Rejected — same class of bad UX.
- **Cache the SSR result with `revalidate`**: Cheaper at scale but introduces a staleness window after publish, contradicting "homepage is the front door and must be current." Rejected in the up-front Q&A.
- **Call the existing `"use server"` actions directly from page.tsx**: Works (they're async functions) but blurs the "use server" RPC boundary. The extract-then-wrap split is ~10 lines of churn and keeps the action surface honest.

## Security (rule 13)

- **Public data only.** Every loader queries the same `status IN ('ready','published') AND slug IS NOT NULL AND (noindex IS NULL OR noindex = 0)` gate the existing actions enforce. The extraction is a copy — no gates loosened. Verified by re-reading the queries during implementation.
- **No new attack surface.** We're not adding a new public API; we're calling existing public-by-design data on the server. Same gate as `/articles`.
- **No secrets crossing the client boundary.** The new server module is plain Node code, never imported from a client component; we use file-level discipline (matches the existing pattern — `lib/db`, `lib/stories-public` are server-only by convention). I'll consider adding `import "server-only"` to the new file as a belt-and-braces guard.
- **Failure handling is fail-open-to-degraded, not fail-closed.** A DB hiccup yields a homepage rendered from the static `STORIES` catalog; the request still succeeds. This is the agreed behavior. The catch logs the error so we see it without dumping internals to the user.
- **No PII or credentials logged.** Logs carry only row counts, surface names, and error strings — same shape as the existing `[lorewire curation load]` line.

## Observability (rule 14)

- `[lorewire homepage ssr]` (server, info): `{ curation_count, surface_counts, live_count, polls_counts, ms }` — emitted once per request after the parallel load resolves.
- `[lorewire homepage ssr error]` (server, warn): `{ source, err }` — emitted per failing source (curation / catalog / polls), with `source` being one of those three strings.
- Existing `[lorewire curation load]` (client) and `[lorewire polls rails load]` (client) survive but only fire when the hook is called without an `initial` seed (i.e. legacy callers). In the seeded path they're skipped intentionally because the data is already known.
- No log content changes for any existing line; everything that grepped clean today still greps clean.

## Settings (rule 15)

No new user-facing settings. This is a render-cadence fix with no behavioral knob worth exposing — the user wants "no flash," not a toggle between "flash or not."

## Testing (rule 18)

- **New tests in `src/lib/homepage-rails.test.ts`:**
  1. `useHomepageCuration({...seeded})` initializes state synchronously from the seed: `curation`, `behavior`, and `catalog` match the seed; `loaded === true` on the first render; no async work scheduled (no `act` warnings, no calls to `getHomepageCuration`/`getLiveCatalog`).
  2. `useHomepageCuration()` (no seed) preserves the existing behavior: starts with null curation, fires the fetch, transitions to loaded — proves backwards compatibility.
  3. `useHomepagePolls({...seeded})` mirrors the same two cases.
- **New tests in a new `src/lib/homepage-data.test.ts`:**
  1. `loadHomepageSSRData()` returns the union of all three loads on the happy path (mock the three loaders).
  2. A failure in any one loader doesn't fail the whole fan-out: the failing field falls back to its empty sentinel, the others are returned intact, and the warn log fires with the failing source name.
- **Existing tests:** `homepage-rails.test.ts` already covers `resolveRailIds` and the fallback math; those tests should pass unchanged. The actions in `actions.ts` get thinner — their existing tests (if any) still pass because the exported signatures don't change.
- **Run command:** `npx vitest run src/lib/homepage-rails.test.ts src/lib/homepage-data.test.ts` for the targeted run, plus `npx vitest run` to confirm no regressions. Both must be green before the task is called done.

## UI/UX verification (rule 16) — manual checklist

After implementation, in a dev server (`npm run dev`), with the browser DevTools Network tab on **Slow 3G** so I can see the slow path:

- **Desktop, hard refresh of `/`:** the hero, Continue Watching, and the first rail appear at first paint and do not change. View source contains the live hero title.
- **Mobile width (`<lg`), same:** Billboard at top shows the correct title at first paint, no shuffle.
- **DB intentionally broken** (e.g. shadow-env a bad DB URL): the page still renders with the static catalog. `[lorewire homepage ssr error]` fires in the server log. No client-side error overlay.
- **Navigate to Reels and back to Home:** still no flash; navigation re-runs the server component.
- **Open the detail modal:** unchanged, still uses `getLiveStoryMedia` per-story.

## Open questions

None blocking. The three Q&A decisions cover dynamic vs cached, polls SSR, and failure mode. Implementation proceeds.
