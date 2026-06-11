# Articles CMS in the admin

Date: 2026-06-11
Status: approved (council-revised, user-locked); pending implementation
Section in handoff: new top-level admin surface (sits next to Stories)

## Goal

Add a robust, multilingual article CMS to the LoreWire admin so the editorial
team can write, edit, and publish long-form content with Notion-quality
authoring UX. The CMS lives next to the existing Reddit-pipeline Stories
without disturbing them, shares the same auth, data layer, and GCS uploads,
and exposes its content to a sibling Next.js site in the same monorepo via
a typed shared package and direct DB read — no public API surface.

## What is an Article? (definition for the team and the reader)

An Article is a stand-alone editorial piece authored by a human in the admin,
published either in Hebrew or English. Articles are independent of the
Reddit→video pipeline (no shared lifecycle), can reference and link to
Stories, and may later be promoted into the video pipeline (post-v1). Four
types ship at launch: **news** (short, timestamped), **feature** (long-form
essay with hero + sections), **listicle** (numbered ranked items), and
**review** (verdict + rating + pros/cons). Articles publish to a public
`/articles` reader on this site and are consumed by the sibling site via a
typed `@lorewire/articles` package.

This definition is the scope fence. Anything that doesn't fit it (community
features, comments, scheduling, multi-author workflow) is out of scope by
construction.

## Goals, constraints, requirements (locked)

**Goals.** Authoring surface for four article types in Hebrew or English.
Notion-style block editor with custom block types, inline media management,
SEO controls, and versioning with autosave. Reader on this site + typed
package consumed by sibling site.

**Constraints.**

- Stack fixed: Next.js 16.2.9 (App Router, with breaking changes from
  pre-16 — see `lorewire-app/AGENTS.md`), React 19.2.4, TS 5, Tailwind 4,
  raw `postgres` driver in prod + SQLite in dev, custom JWT (`jose`),
  GCS service-account uploads. No ORM. No shadcn.
- Must match existing extreme-cleanliness patterns: `src/lib/schema.ts`,
  `src/lib/repo.ts` with typed queries + `EDITABLE` allow-lists,
  `src/lib/dal.ts` auth gates, `(panel)` route group, server actions.
- Stories pipeline stays untouched.
- No new paid services in v1.
- Authoring is multilingual per article (one row picks a language).
- Sibling site is in the same monorepo — share via package + DB read,
  not a public API.

**Requirements (council-revised).**

- Editor: Tiptap with the Novel.sh Notion-style starter on top. RTL
  via Tiptap's first-class `TextDirection` extension (Hebrew is a
  load-bearing requirement; verified in Context7).
- Built-in blocks at launch: paragraph, headings (h1-h3), bullet/numbered
  lists, quote, divider, code.
- Custom blocks at launch: **callout** (info/warning/success) and
  **image** (with alt text + caption). Gallery, embed, pull-quote,
  comparison defer to Phase 5 (council-recommended cut).
- Inline media: drag-drop image upload to GCS, mandatory alt text,
  captions.
- SEO: per-article slug (collision-checked, scoped per language),
  meta title + description with counts, OG image, JSON-LD
  (`NewsArticle`, `Article`, `ItemList`, `Review` — one per type).
- Versioning: autosave, append-only revision history with coalescing
  (one revision per N seconds of edit activity, plus one on focus loss
  and one on manual save) so the table doesn't explode.
- Sheets: one-shot bootstrap import + inline reference block. No sync.
- Reader: public `/articles` index + `/articles/[locale]/[slug]` pages
  on this site, plus `@lorewire/articles` typed package for the
  sibling site.

## Decisions (locked)

**1. Editor: Tiptap + Novel.sh starter (REPLACES BlockNote choice).**

Original draft picked BlockNote for the Notion UX out of the box. Council
peer review flagged Hebrew RTL as the load-bearing unverified risk. Context7
confirmed: Tiptap ships a first-class `TextDirection` extension with
per-node direction, auto-detection, and explicit Hebrew/Arabic mentions.
BlockNote returned zero RTL/direction results in its docs. Per rule 1
(verify, don't guess), switched to raw Tiptap.

Novel.sh fills the "Notion UX without building from scratch" gap: MIT,
headless, built on Tiptap, ships slash menu via Cmdk, bubble menu,
drag handles, image upload hook. We fork what we need and own the surface.

*Trade-off accepted.* Phase 2 is ~2 days longer than BlockNote would have
been; in exchange, RTL is solved on day 1, we have first-class control
over every block, and we avoid the "drop down to Tiptap and hope" path.
Council called this the highest-risk swap to de-risk before code; this
swap does it.

**2. Data model: two new tables, no impact on `stories`.**

- `articles` — one row per article (canonical state)
- `article_revisions` — append-only history of saved snapshots (coalesced)

Single `articles.type` column (`news`|`feature`|`listicle`|`review`).
Type-specific data in a typed JSON `payload` column (matches existing
`stories.payload` convention). Editor renders a type-specific preset;
reader picks a template per type.

*Council note.* Four types at launch is the user's call against council's
unanimous "ship 2." Real cost is +3-4 days for 4 reader templates, 4
JSON-LD shapes, 4 OG variants. Eyes open, locked.

**3. Sheets: bootstrap import + inline reference only.**

`node-google-spreadsheet` v4 + `google-auth-library` JWT — same service-
account-JWT shape `src/lib/gcs.ts` already uses. No OAuth, no sync engine,
no conflict resolution. Bootstrap import is idempotent via a
`source_sheet_row_id` unique column.

**4. Sibling site: monorepo, shared package + DB read (REPLACES REST API).**

User confirmed the sibling Next.js site lives in the same monorepo. The
original plan's `/api/v1/articles/*` + bearer + CORS is now obsolete and
deleted from the scope. Instead, ship a typed `@lorewire/articles`
workspace package that exports:

- Types for `Article`, `ArticleType`, `ArticleBlock`, `Locale`.
- A small data-access surface that reads from the same `DATABASE_URL`
  (no network hop) and only returns `status='published'` rows by default.
- The block-to-HTML server renderer so both sites render content
  identically.

Sibling site imports the package, reads the DB directly. Zero token
rotation, zero CORS, zero versioned API contract. Aligns with rule 2
(no unnecessary abstractions). Council unanimously preferred this over
the REST plan.

**5. Multilingual: `language` column, RTL-aware editor, locale-prefixed URLs.**

`articles.language` is `'he' | 'en'`. The editor sets Tiptap's
`textDirection: 'rtl'` when `language === 'he'`, and individual blocks
inherit but can be overridden via the per-node command for the
inevitable embedded English (code, links, names). Reader URLs are
`/articles/[locale]/[slug]`. Slug collision-check is per-language. No
translation linking in v1.

**6. Versioning: append-only `article_revisions` with coalescing.**

Each save (autosave or explicit) checks: if the last revision is younger
than N seconds (default 60), update it in place (coalesce). Otherwise
insert a new revision. Always insert on focus loss and on manual save.
Restore writes a new revision marking the restore and updates the main
`articles` row. Retention: keep last 50 + all named revisions.

*Council note.* Original plan's "append on every autosave" was a tarpit
(Contrarian's flag). Coalescing fixes that without losing the audit
trail.

## Phased rollout (council-revised sequence)

Original Phase 1 (textarea-only) left editors unable to write for 8 days.
Council unanimously flagged that as the real problem. Revised: Phase 1
ships the editor so editors are writing by end of week 1.

### Phase 1 — Schema + editor skeleton (target: ~5 days)

*Editors can write a basic article by the end of this phase.*

- Day 1 morning: spike + test harness setup
  - Vitest + dual-engine SQL fixtures (Postgres docker + SQLite file).
  - JWT mock for server-action tests.
  - One end-to-end test that survives a server-action round trip.
  - This is the test-framework day called out by council; budget is real.
- Day 1 afternoon - Day 2: data layer
  - Add `ARTICLES`, `ARTICLE_REVISIONS` to `src/lib/schema.ts` (dual-engine
    pattern, matches `STORIES` / `VIDEO_SEGMENTS`).
  - Extend `src/lib/repo.ts`: `listArticlesSlim`, `getArticle`,
    `getArticleBySlug`, `createArticle`, `updateArticle`, `setStatus`,
    `listRevisions`, `getRevision`, `appendRevision` (coalescing-aware).
  - Mirror `EDITABLE` allow-list pattern.
- Day 3-4: admin UI + editor
  - `/admin/articles` (list, slim columns, filter by type + language +
    status), `/admin/articles/new` (type picker → create draft).
  - `/admin/articles/[id]` editor page with Tiptap + Novel.sh wired in.
  - Built-in blocks only (paragraph, headings, lists, quote, divider,
    code). Custom blocks come in Phase 2.
  - RTL via Tiptap `TextDirection` extension bound to `article.language`.
  - Publish/unpublish/archive actions.
- Day 5: hardening
  - Tests for repo (CRUD, slug collisions per language, status
    transitions, EDITABLE enforcement, revision coalescing).
  - Observability namespaces wired: `[articles repo]`, `[articles action]`,
    `[articles editor]`.
  - Manual QA pass: write a real Hebrew article, write a real English
    article, save, reload, edit.

**Done when:** editor lands. A real article can be written in either
language, saved, published, and read back from the list. Tests green.

### Phase 2 — Custom blocks + media + autosave + type presets (target: ~5 days)

- Custom Tiptap node extensions for **callout** and **image** (the only
  two custom blocks at launch, per council cut). Image enforces alt text
  before publish; callout has 3 variants (info, warning, success).
- Image upload via Novel's image-handler hook → POST `/api/admin/upload`
  → `src/lib/gcs.ts` → returns CDN URL. Drag-drop and paste both work.
- Debounced autosave (1.5s default, configurable in settings) → server
  action that writes `articles.document` + `appendRevision` (coalesced).
- Type-specific editor presets: each of the 4 types gets a tailored
  metadata sidebar (news = dateline + source URL; feature = hero +
  subtitle + sections; listicle = items array editor; review = rating
  + verdict + pros + cons). Stored in `articles.payload` JSON, validated
  by per-type Zod schemas.
- Tests: autosave debounce + revision coalescing logic, image alt-text
  enforcement, type-specific payload validation. Editor itself is manual
  QA per rule 18.

**Done when:** editors can write rich articles with images and callouts,
autosave works without exploding the revision table, and all 4 types
have their full metadata captured.

### Phase 3 — Sheets bootstrap import + SEO panel (target: ~3 days)

- `npm install google-spreadsheet google-auth-library`.
- New env: `SHEETS_SERVICE_ACCOUNT_EMAIL`, `SHEETS_PRIVATE_KEY` (reuse
  the existing GCS service account if it has the Sheets scope, or
  provision a fresh one — open question 2 below).
- `/admin/articles/import` page: paste Sheet URL, pick tab, preview
  first 5 rows mapped to article fields with a column-mapper UI,
  confirm → bulk-insert drafts. Idempotent via `source_sheet_row_id`.
- SEO panel inside editor: slug (collision-checked, language-scoped,
  whitelist `[a-z0-9-]+`), meta title + description with character
  counts, OG image picker, JSON-LD preview (correct schema.org type
  per article type).
- Observability: `[articles sheets-import]`, `[articles seo]` events.
- Tests: column-mapper logic, slug generation handles Hebrew via
  transliteration fallback or random suffix, JSON-LD shape per type.

**Done when:** import 10 rows from a Sheet in one click, SEO panel
catches slug collisions before save, JSON-LD validates against
schema.org.

### Phase 4a — Public reader (target: ~4 days)

*Split from original Phase 4 per council — reader and sibling-package
are different products.*

- Public reader routes (new top-level, not under `/admin`):
  - `/articles` — index, paginated, filterable by language + type
  - `/articles/[locale]/[slug]` — full article page with hero,
    type-specific template (4 templates: news, feature, listicle,
    review), OG/Twitter card metadata, JSON-LD
  - `/articles/[locale]/rss.xml` — RSS feed per language
  - `/articles/og/[id]` — dynamic OG image generation via Next 16
    `ImageResponse` (RTL-aware: render Hebrew right-aligned)
- Server-side Tiptap-to-HTML rendering via `generateHTML` from
  `@tiptap/html` so blocks render identically client and server.
- Observability: `[articles reader]` events.
- Tests: API contract for the read functions, reader HTML rendering
  for all 4 types, OG image renders Hebrew correctly.

**Done when:** a published article shows up at the right URL in the
right language with the right template, OG previews look correct
when shared.

### Phase 4b — `@lorewire/articles` shared package for sibling site (target: ~2 days)

- New workspace package `@lorewire/articles` in the monorepo
  (configure `package.json` workspaces if not already; flag if the
  current repo layout needs adjustment first).
- Exports: types (`Article`, `ArticleType`, `Block`, `Locale`), read
  functions (`listPublished`, `getPublishedBySlug`), and the
  Tiptap-to-HTML server renderer.
- Sibling site imports the package and reads the same `DATABASE_URL`.
  No network, no token, no CORS.
- Tests: package builds cleanly, types export correctly, read
  functions reject non-published rows by default.

**Done when:** sibling site has a working article list and detail
page via the shared package.

### Phase 5 — Revisions UI + remaining custom blocks + Sheets inline (target: ~4 days)

- `/admin/articles/[id]/history`: revision list with timestamp + diff
  snippet.
- Side-by-side diff view (added/removed/changed blocks highlighted).
- Restore-to-revision (writes new revision marking the restore).
- Named-version save action (survives retention pruning).
- Remaining custom blocks deferred from Phase 2: **gallery** (1-N
  images), **embed** (YouTube, X, TikTok with sandboxed iframe and
  strict provider allowlist), **pull-quote**, **comparison**.
- Inline "Insert from Sheets" research block (paste sheet ID + range,
  surface as research data the writer copies into the article).
- Tests: revision retention pruning, restore correctness, diff
  algorithm correctness, embed provider allowlist enforcement.

**Done when:** revision history is browsable, the 4 deferred blocks
are available, and the editor can pull research from Sheets inline.

## Total timeline

~23 working days across 5 phases (5 + 5 + 3 + 4 + 2 + 4). Original
draft was 18; council called that under-scoped. Real estimate honestly
accounts for the test-harness day, the type-specific presets across 4
types (per user override), and splitting Phase 4. Each phase remains
independently mergeable.

## Out of scope (deliberate)

- Two-way Sheets sync, conflict resolution, scheduled pulls.
- Translation linking (`translation_of` relation).
- Multi-user simultaneous editing (Tiptap Cloud / Yjs).
- Comments / suggestion mode.
- Roles beyond `admin`.
- Content scheduling (publish-at-future-time).
- Tags / categories beyond `articles.type`.
- A public REST API (replaced by the monorepo shared package).
- Send-to-video-pipeline integration (Expansionist's idea — deferred
  as a separate plan once Articles ship).
- Embeddings / semantic search (Expansionist's idea — defer; can be
  added as a column without a migration headache because the rest of
  the schema is stable).

## Security (rule 13)

**Data sensitivity.** Articles are published content; the draft body is
moderately sensitive (unpublished editorial). The Google service-account
credential is highly sensitive.

**Attack surface and mitigations.**

- *Admin auth.* `requireAdmin()` from `dal.ts` on every admin route +
  every server action. No new auth surface.
- *Input validation.* Zod schemas at every server action boundary.
  Slug whitelist `[a-z0-9-]+`, length-capped. Document JSON validated
  against the Tiptap schema before persistence (rejects hostile JSON).
- *XSS in editor / reader.* Tiptap JSON rendered server-side via
  `generateHTML`, never unsanitized HTML. Embed blocks (Phase 5) render
  `<iframe sandbox>` with a strict provider allowlist. User-supplied
  URLs validated as `http(s)`-only.
- *SSRF on upload.* The upload endpoint accepts only multipart file
  uploads (no "fetch this URL and upload" path).
- *Sheets credentials.* Env-only, never in DB or code. Logs redact
  the private key.
- *No public API surface in v1.* The monorepo shared-package model
  means no bearer token, no CORS, no rate limiting needed for the
  sibling site. Significant attack-surface reduction vs. the original
  plan.
- *Logging.* Never log article bodies, sheet contents, OAuth tokens,
  or PII. Structural metadata only.

**Fail-closed.** Missing Sheets credential disables import (UI says
"not configured"). Malformed Tiptap document falls back to a read-only
"needs repair" view in the admin.

**Best-practice check (rule 13).** Before Phase 4a lands, re-check
current OWASP guidance for Next 16 route handlers + GCS upload
hardening + RTL XSS edge cases (right-to-left override character).

## Observability (rule 14)

Namespaces:

- `[articles repo]` — DB reads/writes
- `[articles action]` — server actions
- `[articles list]` — list filtering/rendering
- `[articles editor]` — autosave, manual save, block insert, upload
- `[articles upload]` — GCS upload (size, mime, success/failure)
- `[articles sheets-import]` — fetch, preview, commit, idempotency
- `[articles seo]` — slug collision, OG render
- `[articles reader]` — page render, cache hit/miss
- `[articles revisions]` — append, coalesce, restore, prune
- `[articles pkg]` — shared-package usage from sibling site (so we
  can see who calls what)

Shape: `console.info('[articles editor] autosave', { articleId, docSize, revId, coalesced })`
with actual values, not "X happened." Errors → `console.error` same
namespace.

Each phase's "Done when" gate includes a manual log check: open
console, do the canonical action, confirm log lines.

## Settings audit (rule 15)

New settings group in `/admin/settings`:

**Articles › Editing.**
- Default article type for new articles (default `feature`)
- Default language for new articles (default `en` — open question 3)
- Autosave debounce ms (default 1500, range 500-5000)
- Revisions retention count (default 50, range 10-500)
- Revision coalescing window seconds (default 60, range 10-600)

**Articles › Media.**
- Max image upload size (default 10 MB, range 1-50)
- Required alt text on publish (default on)
- Allowed embed providers (Phase 5: default YouTube, X, TikTok)

**Articles › SEO.**
- Default site name for OG (string)
- Default OG image when none set (image URL)
- Default JSON-LD organization block (textarea)

**Articles › Sheets.**
- Service-account email (display only, env-set)
- Sheets scope status (display only)
- Default tab name fallback (default `Sheet1`)

**Deliberately not exposed.** Editor block schema, reader URL shape,
sibling-package contract, revision diff algorithm. These live in code
with TS contracts.

## Testing (rule 18)

Repo has no test framework yet. Phase 1 introduces Vitest with a
budgeted half-day at the start for the harness itself — fixtures for
dual-engine SQL (Postgres docker + SQLite file), JWT mocks, server-
action round-trip helper.

**Per phase.**

- Phase 1: CRUD on articles, slug collisions (per-language), status
  transitions, EDITABLE allow-list, revision coalescing logic.
- Phase 2: autosave debounce, image alt-text enforcement, type-
  specific payload Zod validation, image upload size limits.
  Editor itself is manual QA (rule 18 visual-output exception).
- Phase 3: column-mapper produces expected shape, slug generation
  for Hebrew + English (URL-safe, language-scoped), JSON-LD shape
  per article type matches schema.org.
- Phase 4a: reader HTML rendering for all 4 types, OG image renders
  Hebrew right-aligned, reader rejects unpublished rows.
- Phase 4b: package builds, types export, read functions reject
  non-published by default.
- Phase 5: revision retention + restore, embed provider allowlist
  enforcement, diff correctness.

**Bug-fix discipline.** Every fix during these phases ships with a
regression test that fails on the old code and passes on the new
(rule 18).

**Out of scope.** End-to-end browser tests (Playwright). Visual
regression of the editor.

## Pricing flag (rule 8)

Zero new paid services for v1. Verified live (not training data):

- Tiptap core: MIT, free.
- Novel.sh: MIT, free (open-source Notion-style Tiptap starter).
- `node-google-spreadsheet`: MIT, free.
- Google Sheets API: free tier 300 req/min/project + 60 req/min/user.
  Bootstrap import is well under.
- GCS: already in use; article images add marginal cost
  (~$0.02/GB-month standard storage).
- Vercel Functions: already in use; article reader + admin add
  small marginal invocations.

**Re-check before Phase 4a ships** (rule 8): current GCS pricing,
Vercel Function invocation pricing on current plan.

## Open questions for the user

1. Sibling site path/repo — what's its location in the monorepo so I
   can scaffold the `@lorewire/articles` workspace correctly?
2. Sheets credential — reuse the existing GCS service account (add the
   Sheets scope to the project + share each sheet with the service
   email) or provision a fresh service account just for Sheets?
3. Default article language — `he` or `en`? Pure UX default.
4. Any existing Sheet structure you want the column mapper pre-built
   for? If you can share a tab now I can prebuild the mapping.

## Prerequisites before Phase 1

- Re-read `lorewire-app/node_modules/next/dist/docs/01-app/` for the
  specific Next 16 patterns I'll touch (server actions, route handlers,
  dynamic routes, `cookies()`, `headers()`, `ImageResponse`, metadata
  API). Per the project's `AGENTS.md` directive.
- Context7 Tiptap + Novel.sh + `node-google-spreadsheet` again at the
  start of Phases 2 and 3 to catch version-specific changes.
- One spike commit to verify Novel.sh + Tiptap `TextDirection` extension
  work cleanly together with mixed Hebrew/English content. If they
  fight, fall back to raw Tiptap + a hand-rolled slash menu.

## Decision log

| Decision | Picked | Rejected | Reason |
|---|---|---|---|
| Editor | Tiptap + Novel.sh starter | BlockNote, Lexical, MDX | BlockNote has no documented RTL; Tiptap has first-class `TextDirection`. Verified in Context7. |
| Schema | 2 tables + typed JSON payload | Wide sparse, table-per-type, polymorphic | Matches existing `stories.payload` convention, clean migrations |
| Sheets | Bootstrap import + inline ref | Two-way sync, scheduled pull | User-locked; sync costs 3-5x for marginal gain |
| Sibling site | Monorepo shared package + DB read | REST + bearer + CORS | Sibling lives in same monorepo; no need to invent a network boundary |
| Multilingual | `language` col, locale URLs, no link | Translation linking, per-language tables | v1 simplicity, no real loss |
| Versioning | Append-only revisions + coalescing | Event sourcing, in-row diff, per-keystroke append | Coalescing prevents table explosion (Contrarian flag) |
| Launch types | All 4 | Council recommended 2 | User override, eyes open on +3-4 days |
| Launch custom blocks | 2 (callout + image) | All 6 | Council unanimous; remaining 4 to Phase 5 when editors ask |
| Test framework | Vitest, budgeted | Implicit / skipped | Rule 18: untested code is unfinished |
| Phase 4 split | 4a reader + 4b shared package | One combined "ship reader + API" phase | Council unanimous: different products, different consumers |

## Council pass (rule 11) — accepted, rejected, deferred

**Accepted from council:**
- Cut launch custom blocks 6 → 2 (callout + image only).
- Switch editor library (verified BlockNote has no RTL).
- Drop REST API + bearer + CORS in favor of monorepo shared package.
- Split Phase 4 into reader + sibling package.
- Revision coalescing to prevent autosave-tarpit.
- Re-sequence so editors are writing by end of Phase 1, not week 2.
- Add explicit test-harness budget inside Phase 1.
- Add "What is an Article?" section as scope fence.

**Rejected from council (user override, eyes open):**
- Cut to 2 article types at launch. User keeps all 4. +3-4 days
  acknowledged.

**Rejected from council (architectural):**
- Markdown-only editor (First Principles) — conflicts with locked
  requirement "robust block editor."
- Embeddings column / pgvector / headless syndication / send-to-video-
  pipeline (Expansionist) — scope inflation; revisit post-v1 if
  signals warrant.

**Council blind spots, accepted as risks to mitigate:**
- BlockNote RTL was unverified — verified, swapped library.
- Vitest harness budget was implicit — explicit half-day in Phase 1.
- Editorial workflow / roles were unaddressed — locked at admin-only
  for v1; revisit in v2.
- Content migration on day one — addressed via Phase 3 Sheets import;
  editors can start writing fresh in Phase 1 in parallel.
- "What is an Article?" undefined — section above is the answer.
