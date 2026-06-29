# 2026-06-26: Homepage redesign v1 — voting-first, not Netflix-clone

## Context

Amit (manager) sent a long WhatsApp brief proposing a Netflix-style
homepage with 42 candidate shelves, recommending 14 for v1. The
proposal folded together two concerns: (a) "Netflix" appearing in the
link-preview tagline, and (b) the overall design resembling Netflix on
the IP / trade-dress axis.

A code survey changed the picture. Most of the manager's shelves
already exist as data:

- 10 curation/fallback rails (hero, top10, continue, new_row + 6
  category rows) live in `homepage-curation-shared.ts` and
  `homepage-data.ts`.
- 3 engagement-poll rails (divisive, agreed, unpopular) live in
  `polls-shared.ts` with a `poll_aggregates` projection refreshed
  every 5 minutes.
- Per-user vote storage exists (`poll_votes` table, append-only,
  keyed by cookie_token + nullable user_id).
- SSR seeding from `loadHomepageSSRData()` is already wired, no
  flash on first paint.
- Asset gate already enforced (`status IN ('ready', 'published')
  AND noindex = 0`).

The real net-new work is small: a per-user vote-history aggregation
for the personalization rails, a hero question-hint overlay, a "watched
but no vote" filter on the continue rail, a rotating category, a
visual-distance pass, and the tagline cleanup. Most of this is
reframing existing infra rather than building new infra.

## Goals

1. **Reframe the homepage from "Netflix shelves" into "voting-first
   feed where the crowd is part of the story."** Six rails ships,
   every one of them doing something no streamer does.
2. **Pull "Netflix" out of every owned marketing surface.** Brand
   shouldn't ride on a competitor's name. Risk profile: low legal,
   moderate brand-positioning cost — clear win to fix.
3. **Push visual distance from Netflix's trade dress** (palette,
   typography, card treatment, motion) so the homepage reads as
   LoreWire on first paint. Industry-standard horizontal rails stay
   (used by Disney+, Hulu, HBO Max, Prime Video, Spotify, YouTube — not
   protectable on its own). Specific Netflix visual identity gets
   replaced.
4. **Build per-user vote-history aggregation now,** so the
   "You Voted With the Minority" and "Your Unfinished Verdicts" rails
   start accruing signal from day one. These are the only rails that
   genuinely cannot be cloned by a streamer.

## Non-goals (explicitly out of scope for v1)

- The manager's other 8 recommended shelves (Trending Now, Plot
  Twists, Most Voted, Pure Drama as a standalone rail, Humor &
  Awkward Moments as a standalone rail, Did They Go Too Far,
  Rising Fast, Dating Disasters as a separate rail from the
  rotating-category slot). They wait until evidence they earn the
  screen real estate, or until volume makes them non-empty.
- "Because You Watched X" cross-content recommendations. Needs real
  recommendation infra; defer.
- "Most Rewatched," "Today's Biggest Landslides," "Recently Decided
  (1,000+ votes)" rails — sparse at cold-start by design.
- Article-side homepage changes. Scope is the shorts homepage only.
- A full design-system overhaul. The visual-distance pass is targeted:
  swap palette/type/cards/motion enough to break the Netflix
  resemblance, not a top-to-bottom rebrand.

## Requirements

### Functional

- **Hero rail (rotation, 1 visible at a time)**
  - Source pool: top 8 by `poll_aggregates.divisiveness DESC` filtered
    to `status IN ('ready', 'published')`. Falls back to current
    `hero` curation when no high-divisiveness candidates exist.
  - Overlay shows the poll question (not the option labels). Hybrid
    answer chosen for the spoiler tradeoff: enough hook to pull a
    click, not enough to spoil the payoff.
  - Auto-advance behavior is unchanged from current carousel.

- **You Didn't Vote Yet (reframed `continue` rail)**
  - UI label changes from "Continue Watching" to "You Didn't Vote Yet"
  - Filter: story is in Local Storage `lw_continue` OR
    `lw_recently_viewed` AND user has no vote in `poll_votes` keyed
    by cookie_token or user_id for that story's poll.
  - Anonymous-first: client-side filter against Local Storage keys,
    server returns the candidate set.

- **The Internet Can't Agree (renamed `divisive` rail UI)**
  - Settings key stays `polls.rail.divisive_enabled` (storage stable).
  - UI label and Hebrew translation updates.
  - Source unchanged: top 6 from `poll_aggregates` by
    `divisiveness DESC`, gated by public floor (`DEFAULT_PUBLIC_FLOOR`
    = 20).

- **New on LoreWire (existing `new_row`)**
  - No data change. UI label confirmed.

- **You Voted With the Minority (NEW)**
  - Surfaces when user has 5+ votes recorded against the losing
    option (the option that has fewer total votes at the time of
    surface).
  - Source query: join `poll_votes` (per cookie_token + user_id) with
    `poll_aggregates`; filter to votes where the user's `side` !=
    the majority side; order by recency.
  - Gating: rail hides until 5 minority-side votes exist. Settings
    key `personalization.minority_vote_threshold` (default 5).
  - Per-user query bounded; runs server-side from the seeded SSR
    payload, then client-side hook for fresh navigations.

- **Rotating category row**
  - Single slot that cycles daily through the 6 existing category
    rails (entitled, humor, wholesome, dating, roommate, drama).
  - Rotation is deterministic per UTC day (modulo 6 against ISO day
    number) so all users see the same category on the same day —
    matches the "site feels alive" goal without per-user complexity.

### Non-functional

- SSR seed continues to work (no flash on first paint).
- Asset gate respected on every new query.
- Per-user vote-history query bounded at 100 ms p50 (single
  `poll_votes` scan keyed on `cookie_token` or `user_id`, both
  indexed).
- Cold-start safety: any rail with fewer than 4 published cards
  hides entirely (matches the `MIN_PUBLIC_RAIL_SIZE` precedent from
  PR #66 / #67).
- All rail labels resolve through the SEO/site-name settings so
  copy edits don't need redeploys (matches `site-seo.ts` pattern).

## Approach

### Files touched

**Data layer (server-only):**

- `lib/homepage-curation-shared.ts` — add `minority_row` surface
  to the enum and capacity map (capacity 6).
- `lib/homepage-data.ts` — add `loadMinorityVotesForViewer(token,
  userId)` query helper. Add `loadRotatingCategoryRail()` helper.
- `lib/polls-shared.ts` — extend `HomepagePollRails` to include
  `minority: RailCardRow[]`. Update label constants.
- `lib/votes-history.ts` (NEW, server-only) — per-user vote history
  aggregation helpers. Keeps the heavy joins out of `homepage-data.ts`
  and gives the new feature its own test seam.

**SSR + client glue:**

- `app/page.tsx` — extend `loadHomepageSSRData()` to seed minority
  and rotating-category rails. Read cookie_token + user_id from
  request headers.
- `components/AppShell.tsx` — add the new rail to the render order,
  rename existing labels.
- `hooks/useHomepagePolls.ts` (or equivalent) — read minority from
  seeded payload, fall back to fresh fetch on navigation.

**Marketing copy:**

- `lib/site-seo.ts` — replace
  `defaultMetaDescription` default with a LoreWire-native tagline
  (proposed: "Every internet story ends with your verdict. Watch a
  60-second short, decide who's right, see what the crowd said." —
  to be finalized in the Settings audit).
- `app/admin/(panel)/seo/page.tsx` — update placeholder to match.

**Visual distance pass:**

- `app/globals.css` — palette token swap (away from red-on-black-
  hero-on-grid Netflix signature). Concrete proposal: warm-paper +
  ink-blue accent + amber poll-divider. Final palette decided in a
  separate review pass before merge.
- `components/AppShell.tsx` — card border-radius, hover treatment,
  rail spacing.
- Motion: replace 0.4s ease-out card scale-on-hover with a 0.18s
  underline-stroke draw. Less Netflix, more newsroom.

### Order of execution

1. Tagline cleanup (smallest, lowest risk, isolates the marketing fix).
2. Per-user vote history query + tests (no UI yet).
3. New surface enum entry + capacity map.
4. SSR seed wiring for minority rail.
5. AppShell rail rendering + label rename.
6. Hero question-hint overlay.
7. "You Didn't Vote Yet" filter on continue rail.
8. Rotating category logic.
9. Visual distance pass.
10. Cold-start floor enforcement.
11. Observability logs throughout.
12. Settings entries.
13. Unit tests + run full suite.

## Alternatives rejected

**Full 14-rail manager proposal.** Too many sparse rails at cold-start
(Trending Now, Rising Fast, Most Voted, Most Rewatched all need real
volume). Higher shelf count makes the Netflix resemblance worse, not
better. We can add rails later when signal earns the slot; we cannot
easily remove them once shipped.

**Defer personalization to v2.** Ships the version that looks most
Netflix-like. Personalization rails ("You Voted With the Minority")
are the only ones a streamer literally cannot copy, because they need
voting infra. Cutting them defeats the differentiation.

**Hero with full question + options reveal.** Spoils the short's
emotional payoff. Same anti-pattern as showing the punchline of a
joke in the headline.

**Hero with just "The result may surprise you" hook.** Too vague to
pull weight. No setup means no curiosity gap.

**One-shot full design-system overhaul instead of the targeted
visual-distance pass.** Tempting but too big for v1. The visual fix
needs to ship now to address the manager's trade-dress concern; a
full rebrand belongs in its own track with its own design review.

**LLM Council pass on the manager's brief.** Considered. The structural
decisions here were already pressure-tested in chat (4 explicit scope
questions, each option laid out). Council would add friction without
new signal. Re-evaluate if the visual-distance pass turns into a full
rebrand.

## Security (Rule 13)

- **Data sensitivity.** Per-user vote history is low-sensitivity but
  identifying — knowing which side a cookie_token voted is enough to
  correlate sessions. Already handled by `ip_ua_hash` nulling after
  24h.
- **New attack surface.** The minority-vote query takes a
  cookie_token from the request. Already happens for poll voting
  itself, no new entry point.
- **Auth.** Anonymous-first, cookie_token primary; signed-in user_id
  merged read-side per the existing reconciliation hook.
- **Inputs.** Settings keys read through `getSettingsByPrefix` (same
  trust boundary as the rest of the settings layer). Numeric setting
  for the minority threshold parsed through `parseNonNegInt`.
- **Logging policy.** Never log raw cookie_token values. Log hashed
  prefixes only (first 8 chars of sha256) so support can grep
  without learning the secret.

## Observability (Rule 14)

Every meaningful step gets a namespaced log on the first wire-up,
not retrofitted later.

- `[homepage ssr]` — entry + which rails seeded, with counts
- `[homepage rail minority]` — query duration, candidate count,
  threshold value
- `[homepage rail hero]` — chosen story id, divisiveness score,
  whether fallback was used
- `[homepage rail continue]` — pre-filter count, post-vote-filter
  count
- `[homepage rail rotating]` — chosen category, ISO day, why
- `[homepage rail hide]` — every time a rail hides under the
  cold-start floor, with the rail name and the count
- `[polls minority query]` — server-only, per-request, query
  duration

All logs include actual values, not just "X happened." Per memory
[Yoav's observability rule], booleans without values give nothing to
diagnose.

## Settings (Rule 15)

New keys (all under existing settings_kv table):

- `homepage.minority_vote_threshold` (int, default 5) — number of
  losing-side votes before the minority rail surfaces.
- `homepage.cold_start_floor` (int, default 4) — minimum cards
  before a rail renders (matches `MIN_PUBLIC_RAIL_SIZE`
  precedent; surfacing it as a setting lets us tune without
  shipping).
- `homepage.rotating_category_enabled` (bool, default true) — kill
  switch for the rotating category rail.

Existing keys that need their UI labels updated:

- `polls.rail.divisive_enabled` — UI label changes to "The Internet
  Can't Agree" but the key stays for storage stability.

Settings page placement: a new "Homepage" group on the Settings
nav, separate from "Polls." Two checkboxes + two numeric inputs.
Labels in plain language a lazy reader gets without docs ("Hide a
row until it has at least N cards" beats "Cold-start floor").

## Testing (Rule 18)

- **Unit tests** for the per-user vote-history aggregation
  (`votes-history.test.ts`): empty history, all-majority votes,
  all-minority votes, mixed, ties (per `divisiveness()` edge case
  at votes_a == votes_b).
- **Unit test** for the rotating-category modulo logic: same
  category for all users on the same UTC day; rotates across day
  boundaries.
- **Unit test** for hero-pick selection: picks top divisiveness from
  the pool, falls back to current `hero` curation when pool is
  empty, respects the public-vote floor.
- **Component test** for `AppShell` rail order and the cold-start
  hide.
- **Integration smoke**: SSR seed returns all 6 rails with the
  expected shape; cookie-only viewer gets the minority rail when
  threshold met.
- Run full test suite for `lorewire-app` before considering the
  task complete. Per Rule 18, manual checks rot — automated tests
  catch the regressions human review misses.

## Deploy (Rule 19)

**Branch flow.** Per AGENTS.md, production currently deploys from a
non-main feature branch (the inverted state).

Pre-implementation checks (before any push):

1. `git fetch origin` — already done in the planning session.
2. Identify the current production-source branch via the Vercel
   dashboard (Environments → Production). Recent commits suggest
   `feat/multi-platform-shorts-publisher`, but confirm.
3. Branch off the production-source branch, not main. Name:
   `feat/homepage-voting-first-v1`.
4. Bring the production-source branch into the new feature branch
   before opening a PR.
5. Run `git log origin/main..origin/<production-source>` to confirm
   main is behind. If main is behind production, do not merge any
   PR to main — block until main catches up.

Pre-push checklist (literally read before every push):

- What I am about to touch: this feature branch only.
- What I am NOT touching and why:
  - Not pushing to main. Main is stale; merging to main would
    deploy stale main per the 2026-06-23 takedown.
  - Not pushing to the production-source branch directly. PRs
    target the production-source branch and Vercel builds a
    preview.
  - Not clicking "Promote to Production" / "Redeploy" / "Rebuild"
    on any Vercel deployment whose branch is NOT the
    production-source branch. Per the 2026-06-23 third takedown,
    manual promotion bypasses Environments tracking.
- Why this is the right move: Vercel auto-deploys the
  production-source branch; merging the PR into that branch via
  the normal flow is the only safe path.

Rollback path: revert the PR via GitHub. No data migration in this
plan, so revert is clean.

## Resolved decisions (2026-06-26 turn-2)

- **Replacement tagline (locked).** "Every internet story ends with
  your verdict. Watch a 60-second short, decide who's right, see
  what the crowd said." Lands in `site-seo.ts` default +
  `admin/(panel)/seo/page.tsx` placeholder.
- **Visual distance scope (locked).** Targeted swap: palette token
  change (warm-paper + ink-blue accent + amber poll-divider), card
  border-radius adjustment, motion change from 0.4s scale-pop to
  0.18s underline-stroke draw.
- **Rotating category (locked).** Auto-modulo against ISO day
  number with admin override. Default behavior is deterministic
  rotation through the 6 categories; if admin sets
  `homepage.rotating_category_today` in Settings to a specific
  category slug, that wins for that day.
- **Production-source branch (locked).**
  `feat/multi-platform-shorts-publisher`. New feature work branches
  off this, not main. Vercel inverted state is still active.

## Still open

- **Hebrew copy for the new rail labels.** Translations needed for
  "You Voted With the Minority" / "You Didn't Vote Yet" /
  "The Internet Can't Agree" matching the brand voice. Use the
  hebrew-content-writer skill on a follow-up turn once the
  structural code is in.
