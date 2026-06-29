# Pills filter + auto-categorise Reddit stories + bulk reclassify

**Date:** 2026-06-21
**Status:** Approved by Yoav (auto-mode exit, four picks).
**Surfaces:** public home (mobile + desktop shells), `/admin/content`, Python pipeline.

## Problem (verified in code)

1. **Pills do nothing.** [`AppShell.tsx:1279`](../lorewire-app/src/components/AppShell.tsx#L1279) holds `pill` state and [lines 275–282](../lorewire-app/src/components/AppShell.tsx#L275-L282) render the chips, but no rail reads `pill`. Same on desktop: [`DesktopShell.tsx:1046`](../lorewire-app/src/components/DesktopShell.tsx#L1046) renders every category rail unconditionally. Clicking a pill toggles the chip style and nothing else.
2. **Everything ends up "Drama".** Three fallbacks compound to "Drama":
   - [`pipeline/stages.py:97`](../pipeline/stages.py#L97) — subreddit not in `SUBREDDIT_CATEGORY` → `"Drama"`.
   - [`pipeline/export_app.py:82`](../pipeline/export_app.py#L82) — DB category NULL → `"Drama"`.
   - [`lorewire-app/src/lib/stories.ts:113-116`](../lorewire-app/src/lib/stories.ts#L113-L116) and [`homepage-rails.ts:186-190`](../lorewire-app/src/lib/homepage-rails.ts#L186-L190) — unknown cat string → `"Drama"`.
   The static map only knows 11 subreddits. Anything imported from the admin's CSV that isn't one of those defaults to Drama with no LLM signal.
3. **No bulk reclassify.** `/admin/content` already has bulk **set-category-to-X** ([`ContentList.tsx:549-557`](../lorewire-app/src/app/admin/(panel)/content/ContentList.tsx#L549-L557)) and per-row category in the hover `⋯` menu ([`ContentList.tsx:728-737`](../lorewire-app/src/app/admin/(panel)/content/ContentList.tsx#L728-L737)). What's missing: an action that **runs the classifier** across stories instead of pinning everything to one chosen value. Also missing: an inline, always-visible category chip on each row (currently it's a quiet "badge" subtitle).

## Goals (user picks)

- **Pill behavior:** "Filter every rail in place" — pill ≠ "All" filters Continue / Top10 / category rails / New to only show stories whose `cat === pill`. Empty rails hide.
- **Auto-classifier:** "After the article body is written" — in `story_jobs_worker._default_process` after `make_title_and_synopsis`, run a tiny LLM classify call on (title + body) and use that as the category. Subreddit map stays as the fallback if the classifier fails or returns an unknown value.
- **Backfill:** "Reclassify all uncategorized + Drama" — admin button on `/admin/content` that walks every story where `category IS NULL OR category = 'Drama'`, classifies it, writes the new category. Skips manually-set non-Drama categories so admin overrides stick.
- **Manual UI:** "Per-row chip + bulk set" — show a tinted, clickable category chip on every story row in `/admin/content`. Click → small menu of the six categories. The existing bulk action bar stays.

## Out of scope (and why)

- Re-running the classifier on stories with a non-Drama category. Those were either correctly auto-tagged from the subreddit map or hand-edited by an admin. Overwriting hand-edits silently is the worst kind of magic.
- A separate Python-side backfill script. The Node-side action covers the admin's workflow; running the same logic in two places multiplies the bug surface.
- Replacing the static `SUBREDDIT_CATEGORY` map. It still serves as the fast-path / fallback if the LLM call fails. Removing it would make the pipeline depend on a network call for a value that has a perfectly fine 11-row heuristic for the most common subreddits.
- A dedicated "reclassify selected rows" button. The selected-row backfill is rare enough that the existing "Set category to X" picker covers the common case; bulk-reclassify-all-Drama covers the cleanup case.
- Touching the Reels deep-link rail or search. Search already runs against `stories.category`; once categories are correct the search just works.

## Implementation

### 1. Pills filter (front end)

Both shells. In `<Home>` (`AppShell.tsx`) and `<HomePage>` (`DesktopShell.tsx`):

- New helper `byPillCat(ids, pill)` that resolves each id → story, filters out anything whose `cat !== pill` when `pill !== "All"`, returns the surviving ids. (Hoist into `lib/homepage-rails.ts` so both shells share one helper + we can unit-test it.)
- Apply it to `continueIds`, `top10Ids`, `newRowIds`, and to the items inside each `CATEGORY_RAILS` rail render. CATEGORY_RAILS rails whose own `rail.cat !== pill` skip render entirely when a category is selected (so picking "Humor" doesn't show the Drama rail header with one item).
- Hero/Billboard stay as-is (they're curation-driven and selecting a pill shouldn't whip the hero out from under the user — Netflix's hero stays put when a tag is picked).
- Poll rails: filtered by `row.category` when present; if a poll has no story-category linkage, it hides while a pill is active. This matches the spirit of "filter every rail in place" — the user picked a tag and everything not under that tag goes away.

### 2. Python classifier in the pipeline

Add `pipeline/stages.py:classify_category(title, body, fallback_category)`:

- Prompts the active LLM with: `Pick one: Drama, Entitled, Humor, Wholesome, Dating, Roommate. Reply with just the word.` plus title + first ~2000 chars of body.
- Reads the response, lowercases, matches against the closed set. Returns the canonical case (`"Drama"`, not `"drama"`).
- Any non-matching response → return `fallback_category` (the subreddit-map value).
- Any LLM call failure → log + return `fallback_category`. The classifier is a quality lift, not a hard dependency.

Hook in `pipeline/story_jobs_worker.py:_default_process`, immediately after `make_title_and_synopsis`:

```python
classified = stages.classify_category(
    branded_title or idea["headline"],
    body,
    fallback_category=idea["category"],
)
if classified != idea["category"]:
    print(f"[story-jobs classify] {post['id']} {idea['category']} -> {classified}")
    store.log_story_job_event(
        job_id, reddit_id, "category_reclassified",
        message=f"Category {idea['category']} -> {classified}",
        payload={"prev": idea["category"], "next": classified},
    )
    idea["category"] = classified
```

The `row["category"]` write a few lines down already reads from `idea["category"]`, so the upsert picks up the new value.

### 3. TS classifier for admin backfill

Add `lorewire-app/src/lib/category-classifier.ts`:

- `classifyCategory({ title, body, fallback }): Promise<{ category: string, llmCalled: boolean, llmOk: boolean, reason?: string }>`.
- Picks the LLM stage model via `selectModel("llm")` (same chain the rest of the admin uses).
- Uses the existing `chatCompletion` helper from `lib/llm.ts`; no new HTTP wiring.
- Same prompt as the Python side, same closed-set validation, same fallback rule.
- Returns rich result so the bulk action can render per-row outcomes.

### 4. Admin server action: bulk reclassify

`lorewire-app/src/app/admin/actions.ts:bulkReclassifyStoriesAction()`:

- `requireAdmin()`.
- Query: `SELECT id, title, body, category FROM stories WHERE category IS NULL OR category = 'Drama'`. Cap at 200 per call (matches the existing `MAX_BULK_ITEMS`).
- For each row: call `classifyCategory({ title, body, fallback: row.category ?? 'Drama' })`. If the new value differs, write via `setStoryCategory`. Track per-row outcomes.
- Returns `{ scanned, reclassified, unchanged, failed, changes: [{id, prev, next, title}] }`.
- `revalidatePath("/admin/content"); revalidatePath("/");` so the public homepage picks up the new categories on next render.

### 5. UI: per-row chip + reclassify button

On `/admin/content`:

- Replace the "badge" subtitle for story rows with a tinted category chip (`bg-cat-<cat>/15 text-cat-<cat> border-cat-<cat>/40`) that opens a tiny picker on click. Click writes via the existing `bulkUpdateContentAction(item, { type: "category", category })`. No new server action needed — it's one item through the existing path.
- New header button: **"Reclassify Drama + uncategorized"**. Opens the existing confirm modal pattern with a count preview ("Will reclassify N stories. The LLM will look at each story's title + body and pick from the six categories. Manually-set non-Drama categories are not touched."), then runs `bulkReclassifyStoriesAction`. Surfaces the result inline: a banner with "Reclassified X of Y; Z unchanged" and the existing failures list pattern.
- Per-row chip stays clickable even mid-reclassify so the admin can override the classifier's call immediately.

## Security (rule 13)

- All new server actions begin with `requireAdmin()`. No new auth surface.
- Classifier prompt is built from `title` + `body` of admin-owned stories. No untrusted user input enters the prompt.
- LLM responses are matched against a closed set BEFORE writing to the DB. A model returning `"DROP TABLE stories"` doesn't end up as a category value.
- LLM API key only enters the request from `process.env.OPENAI_API_KEY` via the existing `lib/llm.ts:openaiChat` path. No new env var, no new outbound host.
- Cap of 200 rows per reclassify call mirrors the existing `MAX_BULK_ITEMS` so a runaway button click can't issue thousands of LLM requests.
- No logging of body text — only ids and prev/next category values, in line with the existing bulk-action logging contract.

## Observability (rule 14)

- Server: `console.info("[reclassify start]", { scanned })`, per-row `console.info("[reclassify item]", { id, prev, next, llmOk })`, `console.info("[reclassify done]", { reclassified, unchanged, failed })`.
- Python worker: `[story-jobs classify]` line per story + a `category_reclassified` event row whenever the classifier changes the subreddit-map default.
- Client: `console.info("[content list reclassify submit]")` on button click, `[content list reclassify result]` with counts.
- Pill filter: `console.info("[home pill]", { pill, visibleRails })` on pill change so a "why is this rail gone?" question is one console glance away.

## Settings (rule 15)

- No new user-facing setting today. The classifier is always-on in the pipeline and behind an admin button for backfill. If we later want admins to disable auto-classify per deployment, the right place is `admin/(panel)/settings/page.tsx` under a new "Reddit pipeline" section with a single toggle `reddit.auto_classify_category` (default on). Flagging this here so a future request to "make it optional" has an obvious home.

## Testing (rule 18)

- `lorewire-app/src/lib/category-classifier.test.ts` — unit tests with a mock `chatCompletion`: returns one of the six → that category; returns garbage → fallback; throws → fallback.
- `lorewire-app/src/lib/homepage-rails.test.tsx` — extend existing tests with a `byPillCat` case covering each category + "All".
- `lorewire-app/src/app/admin/actions.test.ts` (or a new `reclassify.test.ts` next to a small DB harness) — `bulkReclassifyStoriesAction` test that seeds three stories (Drama, NULL, Humor) and verifies only the first two are touched.
- `pipeline/tests/test_stages.py` — `classify_category` test with the LLM stub returning each valid value, a junk value, and raising.

## What flips for the user

Before: pills decorative; new Reddit imports default to Drama; existing stories are 90% Drama.
After: pills filter; new imports get the right tag at write time; one button cleans up the legacy Drama backlog.
