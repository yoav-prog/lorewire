# Content page: multi-select + bulk actions + per-row hover menu

**Date:** 2026-06-19
**Status:** Approved by Yoav, in progress.
**Surface:** `/admin/content` (admin panel).

## Goals

Make the admin Content page operable in bulk: select N rows and run an action on all of them, plus the same actions available per-row via a hover `⋯` menu. Row body click still opens the editor.

Bar: a lazy user (rule 10) lands on the page, sees checkboxes, ticks two rows, sees a bulk bar appear, clicks Publish, confirms once, and is done.

## In scope

- Always-visible checkbox on every row + sticky bulk action bar when ≥1 selected.
- Per-row hover `⋯` menu with the same actions, scoped to that row.
- Bulk actions:
  - **Publish** (status → `published`).
  - **Unpublish** (status → `draft`).
  - **Set status →** picker (draft / review / scripted / rendering / ready / published / archived).
  - **Set category →** picker (Drama / Entitled / Humor / Wholesome / Dating / Roommate). *Stories only* — disabled with tooltip when any selected row is an article.
  - **Delete** (hard delete row + rendered media for stories).
- Confirm modal for every action.
- Undo banner for every reversible action (everything except Delete).
- Per-row action surface: hover `⋯` menu opens to the same set, scoped to one row, sharing the same confirm modal and undo banner.

## Out of scope (and why)

- **Bulk change article sub-kind** (news / feature / listicle / review). Blocked by schema design: `payload` is a type-specific shape (`src/lib/repo.ts:651-656`). Switching type mid-life invalidates payload. If we want this, it needs its own plan that migrates per-row payloads.
- **Bulk change language** (he / en). Same reason. Stories don't even have a language column.
- **Soft delete / trash**. User chose hard delete. No "Trash" tab.
- **Drag-select / shift-click ranges**. Standard checkbox click only.
- **Pagination of selection across filter changes**. Selection clears on filter change (and we'll surface a small note when it does).

## Constraints found in the codebase

- Mutations are Next.js Server Actions in `src/app/admin/actions.ts`, every action calls `requireAdmin()` from `src/lib/dal.ts` and `revalidatePath('/admin/...')` afterwards. New actions match this pattern exactly.
- Story repo functions: `updateStory`, `setStatus` (story status), `setStoryNoindex` already exist. `deleteStory` does **not**.
- Article repo functions: `updateArticle`, `setArticleStatus`, `deleteArticle` already exist. `deleteArticle` already cascades to `article_revisions`.
- GCS helpers exist for upload but **no delete**. We need `deleteObject(key)` and `deleteStoryMedia(storyId, { audioUrl, videoUrl })`.
- GCS URL shape: `https://storage.googleapis.com/<bucket>/<key>`. No CDN intermediate. URL parser is strict — must match this exact host or be logged and skipped.
- Tests: Vitest is the test framework (`package.json:12`). Test file convention: `*.test.ts` next to source. Tests run with `npm test`.
- No toast library. Inline feedback pattern (transient state, `useTransition`) is established by `RebuildAllButton`.

## Behavioral rules

- **Status change** works uniformly because both stories and articles have `status`. Internally, the bulk action re-reads each row from the DB to determine kind (so a client can't trick a story-id into the article path).
- **Category change** works for stories only. When the selection includes any article, the Category control is disabled in the bulk bar with a tooltip: "Category applies to video stories only." Same for the per-row menu on an article row — Category is omitted from the menu.
- **Delete** for an article uses existing `deleteArticle`. For a story: new `deleteStory` deletes the DB row, then `deleteStoryMedia` deletes the rendered audio + video objects from GCS. Both `audio_url` and `video_url` are URL-parsed strictly; mismatched URLs are logged and skipped (we never blindly DELETE).
- **Confirm modal**: a single shared modal. Body summarizes "<verb> N items? (M stories, K articles)" with a list of titles (truncated). Delete additionally requires the admin to type `DELETE` to enable the confirm button.
- **Undo**: appears as a transient inline banner above the list immediately after a non-delete action. It captures `{id → prevStatus | prevCategory}` and reverses via the same server action. Auto-dismisses after 10s. Delete is not undoable; the confirm modal stands in for it.
- **Cross-table batches**: actions accept `[{ kind, id }, ...]` so the server doesn't have to guess. Server still re-validates `kind` against the DB before mutating.
- **Selection across filter changes**: when filter chips change, selection clears (filter changes the visible row set, and selecting stale-invisible rows is a footgun). We surface a one-line note: "Selection cleared after filter change."

## Security (rule 13)

- Every new server action begins with `await requireAdmin()` — no exceptions.
- Action input validation:
  - `items: { kind: "story" | "article", id: string }[]` — kind validated against literal union; id validated against existing-id regex used elsewhere in the repo (UUID-ish).
  - `status` ∈ `STATUSES` enum; rejected otherwise.
  - `category` ∈ `CATEGORIES` enum; rejected otherwise.
  - Hard cap of 200 items per action (the page lists at most 200).
- Defense in depth: server re-reads each row by `id` from its table to confirm kind matches the client claim. A story id sent as `{kind: "article"}` is rejected and logged.
- Hard delete is admin-only and behind typed `DELETE` confirmation in the UI.
- GCS delete: URLs must match `https://storage.googleapis.com/${GCS_BUCKET}/<key>` exactly. Anything else is logged and skipped (we never delete a URL we can't parse).
- Logging never includes title or body content — only ids, prev/next values, and kind.

## Observability (rule 14)

- Server actions:
  - `console.info('[content bulk action] start', { type, count, ids })` at action entry.
  - `console.info('[content bulk item]', { id, kind, ok, prev, next })` per item.
  - `console.error('[content bulk action] failed', { id, error })` on item failure (caught — batch continues).
  - `console.info('[content bulk action] done', { type, ok, failed })` at end.
- GCS:
  - `console.info('[content gcs delete]', { bucket, key })` per object.
  - `console.warn('[content gcs delete] url unparseable', { url })` when the URL doesn't match the expected shape.
- Client (ContentList island):
  - `console.info('[content list selection]', { count })` on selection change.
  - `console.info('[content list bulk submit]', { type, count })` on confirm.
  - `console.info('[content list undo]', { type, count })` on undo click.

## Settings audit (rule 15)

No new settings now. The only obvious knob — "skip confirm for publish/unpublish" — runs against your stated policy (confirm everything). If we want it later, the natural home is `src/app/admin/(panel)/settings`. Flagged, not added.

## Testing (rule 18)

Vitest. Tests live alongside source. Coverage:

- `src/lib/gcs.test.ts`: new `parseGcsUrl(url)` — good URL, bad URL (wrong host), missing host, encoded key with `%2F`. Each case has its own test.
- `src/lib/repo.test.ts`: new `deleteStory(id)` — story row + dependent rows (if any) gone after delete.
- `src/app/admin/content/actions.test.ts` (new file or inside the existing `actions.test.ts` if one exists): `bulkUpdateContentAction` with a mixed batch (1 article, 1 story, 1 invalid id) — invalid is logged and skipped, valid succeed, failure list returned; `bulkDeleteContentAction` with a story that has both audio_url and video_url — DB row gone, both GCS deletes called via a mock.

Full suite (`npm test`) must be green before calling the task done.

## File map

**New**
- `src/app/admin/(panel)/content/ContentList.tsx` — `'use client'` island. Owns selection state, hover menu, sticky bulk bar, confirm modal, undo banner. Receives `rows: ContentRow[]` as prop.
- `src/app/admin/(panel)/content/BulkActionBar.tsx` — sticky bottom bar. Presentational; callbacks up.
- `src/app/admin/(panel)/content/ConfirmActionModal.tsx` — shared confirm dialog with optional typed-confirm.
- `src/app/admin/(panel)/content/UndoBanner.tsx` — transient inline banner above the list.
- `src/app/admin/(panel)/content/RowMenu.tsx` — hover `⋯` menu on a row.

**Edits**
- `src/app/admin/(panel)/content/page.tsx` — keep filter chips server-side; replace inline `rows.map` with `<ContentList rows={rows} />`.
- `src/app/admin/actions.ts` — add `bulkUpdateContentAction` (status / category) and `bulkDeleteContentAction`.
- `src/lib/repo.ts` — add `deleteStory(id)`, expose `setStoryCategory(id, category)` (thin wrapper for clarity around `updateStory`).
- `src/lib/gcs.ts` — add `parseGcsUrl(url): { bucket, key } | null` and `deleteObject(key)` and `deleteStoryMedia(audioUrl, videoUrl)`.

## Cost note (rule 8)

No new paid services. GCS DELETE is a "Class B operation" (~$0.004 / 10k ops). Negligible.

## Reverted-options note (rule 4)

We chose Option A (always-on checkboxes + sticky bulk bar). Considered:
- **Option B**: Gmail-style "Select" mode toggle. Rejected — hides multi-select behind a click; worse for a lazy user.
- **Option C**: shift-click only, no checkboxes. Rejected — invisible affordance; fails rule 10.
