# 2026-06-19 — Global admin top-bar search

## Goal

A single search bar at the top of every `/admin` page that finds Reddit sources and stories across the whole admin. Power-user keyboard navigation, debounced live results without page reloads, recent-picks memory, and clear empty/error states.

## Scope

- **In**: a new `<GlobalSearch />` component slotted into the admin header, a `GET /api/admin/search?q=...` route, fuzzy + multi-field + ranked matching with no AI, recent picks via `localStorage`, full keyboard nav.
- **Out**: AI-powered semantic search, embeddings, vector columns, separate short-render results (shorts surface via their parent story), public-site search.

## UX surface

### The bar

- Lives inside the existing `<header>` at [lorewire-app/src/app/admin/(panel)/layout.tsx:43](lorewire-app/src/app/admin/(panel)/layout.tsx#L43), placed before `<UserMenu>`. Width capped (~`max-w-md`) so it doesn't dominate.
- Mono-style placeholder that matches the sidebar look: `"Search anything…   /"` with the `/` hint rendered as a kbd-style chip on the right edge.
- Input is controlled, value lives in component state.

### The dropdown

- Renders directly under the bar, anchored, ~`max-h-[60vh] overflow-auto`.
- Open when (input focused) AND (input non-empty OR recent picks exist).
- Two sections, each with a header label matching the sidebar's `font-mono text-[10px] uppercase tracking-[0.2em] text-muted` style:
  - **Reddit sources** — up to 6 hits, each row: subreddit chip + matched title (highlighted query terms) + short snippet from `summary` (or `full_text` slice when summary is empty).
  - **Stories** — up to 6 hits, each row: category chip + title (highlighted) + snippet from `summary` or `body`.
- When the input is empty: a **Recent** section shows the last N picks (default 6) from `localStorage["lorewire.admin.search.recent"]`. Clicking a recent pick navigates to it directly; a small ✕ on hover removes it from the list.
- Result rows are `<a>` tags so middle-click / cmd-click open in a new tab.

### Keyboard

- `/` anywhere on an admin page → focus the bar (unless an input/textarea/contenteditable already has focus — never steal from real typing).
- `Esc` while bar is focused → clear input. Esc again → blur the bar.
- `↑` / `↓` → move highlight through visible result rows.
- `Enter` → navigate to highlighted row.
- `Tab` from the input → close dropdown and move focus normally.

### States

- **Loading** — subtle pulse on a single skeleton row while the debounced fetch is in flight; only shown if the fetch takes >150ms (no flash for fast LANs).
- **Empty results** — `No matches for "<q>"` with a small "clear" link.
- **Error** — `Search unavailable. Retry?` with a button that re-fires the last query. Never crash the bar; never crash the surrounding admin page.

## Backend API

`GET /api/admin/search?q=<query>`

- File: `lorewire-app/src/app/api/admin/search/route.ts` (new).
- First line: `await requireAdmin();` per the existing convention at [lorewire-app/src/lib/dal.ts:24](lorewire-app/src/lib/dal.ts#L24).
- Reads `q` from `URL(req.url).searchParams`. Trims; if empty, returns `{ reddit: [], stories: [] }` immediately.
- Hard caps: `q.length <= 100` (longer is rejected with 400). Tokens > 8 are truncated to the first 8 to bound SQL OR fan-out.
- Returns:

```ts
{
  q: string,
  took_ms: number,
  reddit: Array<{
    reddit_id: string;
    subreddit: string;
    title: string;
    snippet: string;       // ~140 chars around the first matched token, q-terms wrapped in **
    href: string;          // /admin/reddit-sources/<reddit_id>
    score: number;
  }>,
  stories: Array<{
    id: string;
    category: string;
    title: string;
    snippet: string;
    href: string;          // /admin/stories/<id>
    score: number;
  }>,
}
```

## Ranking algorithm (fuzzy + multi-field + ranked, no AI)

Two layers — SQL narrows the candidate set, JS ranks the survivors:

### SQL candidate fetch

1. Tokenise `q` on whitespace, lowercase, drop tokens shorter than 2 chars.
2. For each table, fetch up to **200 candidate rows** where ANY token matches ANY indexed field via parameter-bound `LIKE`. Field set:
   - `reddit_source`: `title`, `summary`, `subreddit`
   - `stories`: `title`, `summary`, `category`
3. Mirrors the existing pattern at [lorewire-app/src/lib/reddit-source.ts:328](lorewire-app/src/lib/reddit-source.ts#L328) — case-insensitive `LIKE`, params bound to prevent SQL injection.

### JS scoring

Per candidate, compute:

```
score =
  (exact phrase in title    ? 10 : 0) +
  (all tokens in title      ?  6 : 0) +
  (exact phrase in summary  ?  4 : 0) +
  (any token in title       ?  3 * matched_token_count : 0) +
  (any token in summary     ?  2 * matched_token_count : 0) +
  (any token in body/full   ?  1 * matched_token_count : 0) +
  (title starts with q      ?  3 : 0) +
  (subreddit / category exact match : 5)
```

- Tokens are deduped before scoring.
- `score >= 1` is required to ship a row.
- Sort `score DESC`, then `updated_at DESC` (recency tiebreaker), then `id ASC` (deterministic). Take top 6 per entity.

This stays in-process so it works identically on SQLite (dev) and Postgres (prod) without depending on FTS5 / `tsvector`. It IS "smart" (multi-field weighted, prefix bonus, exact-phrase bonus) without being expensive.

### Snippet generation

- Find the first occurrence of any query token in `summary` (fallback `body` / `full_text`).
- Take a window of 140 chars centred on the match.
- Wrap matched tokens with `**` markdown so the frontend can render highlighted spans. The frontend uses a tiny markdown-bold parser (regex split on `**…**`) — no full markdown engine.

## Security (rule 13)

- All parameters bound via `?` placeholders (existing repo convention) — no string concatenation into SQL.
- `q.length` capped at 100; token count capped at 8; per-entity candidate cap at 200; per-entity result cap at 6 — every multiplier is bounded so a malicious admin can't craft a query that fans out into a denial-of-service.
- `requireAdmin()` gates the route. No anonymous search endpoint.
- The endpoint logs only `q` length and result counts to admin-side logs (not the verbatim query) so a future audit log doesn't accidentally capture sensitive titles.
- Recent picks live in `localStorage` only — never sent to the server. Each entry stores `{ kind, id, label, ts }`; no body / summary persisted.

## Observability (rule 14)

- Server: `console.info('[admin search] q.len=%d took_ms=%d reddit=%d stories=%d', q.length, took, reddit.length, stories.length)` on success.
- Server: `console.warn('[admin search] error', { err })` on failure.
- Client: `console.info('[admin search ui]', { event, q_len, hit_kind })` on each user action (focus, navigate, pick). The `[admin search ui]` namespace is greppable.

## Settings (rule 15)

Two new admin settings under a new "Search" group:

- `admin.search.recent_max` — default `6`. Bound to 0–20.
- `admin.search.enabled` — default `on`. When `off`, the bar renders disabled with a tooltip. Useful for outages.

The component reads these via the existing settings hook on render; no extra UI needed beyond exposing them on the Settings page.

## File-by-file changes

| File | Change |
|---|---|
| [lorewire-app/src/app/admin/(panel)/layout.tsx](lorewire-app/src/app/admin/(panel)/layout.tsx#L43) | Insert `<GlobalSearch />` before `<UserMenu>` in the `<header>`. |
| `lorewire-app/src/app/admin/(panel)/_components/GlobalSearch.tsx` | New — the entire client component (input + dropdown + keyboard + recent picks). |
| `lorewire-app/src/app/admin/(panel)/_components/GlobalSearch.module.css` OR inline Tailwind | Styling. Prefer inline Tailwind to match the rest of the admin. |
| `lorewire-app/src/app/api/admin/search/route.ts` | New — `GET` handler with `requireAdmin()`, tokenise, query both tables, score, snippet, return JSON. |
| `lorewire-app/src/lib/admin-search.ts` | New — the pure scoring + tokenising + snippet functions, no DB or React deps. Unit-testable in isolation. |
| `lorewire-app/src/lib/reddit-source.ts` | Add `listRedditSourcesForSearch(tokens, limit)` that mirrors `listRedditSources` but accepts a token array and returns the minimal candidate columns. |
| `lorewire-app/src/lib/repo.ts` | Add `listStoriesForSearch(tokens, limit)` mirror. |
| `lorewire-app/src/lib/admin-search-recent.ts` | New — typed wrapper around `localStorage` for the recent-picks list (with the existing browser-safe pattern). |

## Testing (rule 18)

Lives in `lorewire-app/tests/` (matches existing pattern of the content inbox tests added today).

### Pure scoring (no DB, no React)

`lorewire-app/tests/admin-search/scoring.test.ts`

- Tokeniser: whitespace split, lowercase, drops <2 char tokens, dedups, trims punctuation off edges.
- Exact phrase in title beats scattered tokens in title.
- All-tokens-in-title beats any-token-in-title.
- Title beats summary beats body (3 / 2 / 1 weighting).
- Prefix bonus fires only when title starts with the full query.
- Subreddit / category exact match gets the +5.
- Score 0 rows are dropped.
- Recency tiebreaker.

### Snippet generation

`lorewire-app/tests/admin-search/snippet.test.ts`

- 140-char window centred on the first match.
- Falls back across summary → body → full_text.
- Markdown bold wrapping is balanced.
- Handles match at start / middle / end of source text.
- Multiple tokens in the same window each get wrapped.

### API route

`lorewire-app/tests/admin-search/route.test.ts`

- Empty `q` → empty results, 200.
- `q.length > 100` → 400.
- Unauthenticated → redirected by `requireAdmin()` (existing pattern).
- Happy path: seed a reddit source + a story, query a known token, both kinds returned with the expected fields.
- Token count cap at 8.
- Parameter binding: a payload like `q="' OR 1=1 --"` returns 0 rows without errors (smoke test for SQL injection guard).

### Component (jsdom)

`lorewire-app/tests/admin-search/component.test.tsx`

- Debounce: 4 keystrokes within the debounce window result in a single fetch.
- `/` focuses the input; `Esc` clears; arrow keys move highlight; Enter navigates.
- `/` does NOT fire when an input / textarea / contenteditable already has focus.
- Recent picks render when input is empty.
- Loading skeleton appears only after the 150ms threshold.
- Error state renders on a rejected fetch and the retry button refires the same `q`.

Run the project test suite (`npm test` / `pnpm test` per the repo) before calling it done.

## Cost (rule 8)

Zero new paid services. SQL `LIKE` against existing rows. The recurring cost of any single query is small even at 30,833 reddit sources (the screenshot count): the candidate fetch returns up to 200 rows that are then scored in JS. On Postgres with the existing `(subreddit, length_chars)` index this is sub-50ms; on SQLite local dev, fine without further indexing.

If future profiling shows the `LIKE` becoming the bottleneck, we can layer Postgres `tsvector` + GIN later without changing the public API.

## Rollback

- The component, the API route, and the new lib files are all additive — no schema migrations.
- Reverting the layout edit removes the bar; reverting the API route makes any leftover requests 404 (the component already handles fetch errors). No data lives in the DB; recent picks are client-side only.

## Open questions

1. **Empty-state recent picks: should they include "did you search for X 5 min ago and nothing matched" entries?** I'd say no — recents are picks (things you clicked), not queries. Cleaner.
2. **Should the bar persist `q` into the URL (`?gq=…`) so a refresh keeps the dropdown open?** Adds complexity; I'd skip in v1.
3. **Result limit per entity (6) — fine, or want 10?** 6 reads comfortably without scrolling; 10 needs a `max-h` scroll. I'd ship with 6 and add a setting if you ever want more.
