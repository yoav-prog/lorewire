# Admin panel performance pass

Date: 2026-06-11
Status: in progress
Section in handoff: cross-cutting (Vercel + Postgres production)

## Goal

Make every common /admin interaction feel fast on production. The user reports
"everything in the admin panel is slow and not smooth" across initial load,
nav clicks, the stories list, and form submits. Target a noticeably faster
feel without architectural rewrites; defer Next.js 16 Cache Components for a
follow-up.

## Decisions (locked)

- **Stay on the existing rendering model.** Cache Components requires
  `cacheComponents: true` plus Suspense boundaries around every dynamic
  surface. That is a real architectural change. Out of scope for this pass.
- **Vercel + Postgres** is the deploy target (user confirmed). The
  `postgres` driver pool must be reconfigured for serverless or it will hold
  up to 10 idle conns per instance, exhausting the database.
- **Service worker leaks into /admin.** The SW caches every same-origin GET,
  including admin HTML. That adds a write to IndexedDB on every nav and
  risks stale dashboards. Strip /admin out.
- **Auth double-dip.** The layout calls `requireAdmin()` and every page
  calls `requireAdmin()` again. Both hit `getUserById` on Postgres. Wrap
  `getUserById` in `React.cache` so the per-request memoization de-dupes
  the second call.
- **List queries are unbounded and bloated.** `listStories()` returns every
  story with every column (including `body`, `teleprompter`, `payload`).
  Add slim list and aggregate functions; the dashboard becomes a single
  small query, the stories list becomes a slim columns + LIMIT query.

## Concrete changes

1. `src/lib/db.ts`: configure `postgres()` with `max: 1`,
   `idle_timeout: 20`, `connect_timeout: 10`. Keep `prepare: false` for
   pooler compatibility (Neon/Supabase transaction pooler). Reason: in
   serverless every function instance should hold at most one connection;
   defaults exhaust the DB and slow cold starts.
2. `src/lib/dal.ts`: wrap the per-request user lookup in `React.cache` so
   the layout + page sharing a request hit the DB once, not twice.
3. `src/lib/repo.ts`: add `listStoriesSlim()` (id, slug, title, category,
   status, updated_at, cost_cents) with a `LIMIT`; add `dashboardSummary()`
   that returns `total`, counts grouped by status, and total spend in a
   single SQL.
4. `src/app/admin/(panel)/page.tsx`: switch to `dashboardSummary()` plus
   `listStoriesSlim({ limit: 8 })`, run with `Promise.all` alongside
   `allSelected()`.
5. `src/app/admin/(panel)/stories/page.tsx`: switch to `listStoriesSlim`
   with a reasonable LIMIT (200) and a "show more" hint if we hit it.
6. `src/lib/models.ts`: collapse `allSelected()` into one settings query
   (`SELECT key, value FROM settings WHERE key LIKE 'model.%'`) instead of
   three sequential round trips.
7. `public/sw.js`: bypass `/admin` (and any `/api/`) so the SW does not
   cache or intercept those requests. Bump the cache version so old clients
   recycle their store.
8. `src/app/admin/(panel)/loading.tsx`: add a thin shell-shaped loading UI
   so nav clicks render instantly while the server renders.

## Out of scope (follow-up)

- Cache Components (`cacheComponents: true`, `use cache`, `unstable_instant`)
  for selected admin pages. Requires Suspense wrapping and is a separate
  plan.
- Edge runtime for the proxy/middleware.
- Vercel region selection / Postgres region affinity (requires deploy
  access to verify).
- Indexing the `stories` table (no migration in this plan).

## Observability

- Keep existing `console.info` lines; add timing logs in a follow-up if
  this pass does not move the needle.

## Settings audit

- No new user-facing settings introduced.

## Testing

- This codebase has no test framework yet. Per rule 18, flag and propose
  in a follow-up rather than introducing one mid-fix. Verification this
  pass: type-check (`tsc`), build (`next build`), and a manual nav pass.

## Security

- No auth or authorization surface changes. The cached `getUserById` is
  still per-request scoped (React.cache is request-isolated). The slim
  story queries return a strict subset of columns — no new exposure.
