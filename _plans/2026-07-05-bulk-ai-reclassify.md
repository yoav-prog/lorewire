# Bulk "Reclassify AI" action on /admin/content

Date: 2026-07-05. Status: approved (chat), implementing.

## Goal

Let the admin re-run the multi-tag LLM classifier on a hand-picked selection
of stories, straight from the Content list. The whole-library tool at
/admin/reclassify stays for taxonomy-fit reviews; this is the surgical
version for "these 21 rows are wrong, fix them".

Context: the old "Reclassify Drama + uncategorized" button on this page was
retired 2026-07-01 (eeb7ee2) because it ran the pre-taxonomy 6-label
classifier. Its sidebar replacement classifies the whole library only. The
2026-07-03/04 token-starvation incident (PR #222) left ~21 stories stuck on
"Drama" and made the gap obvious: the operator looks for the fix on the
Content page, not in a separate tool.

## Approach

One new server action + one new bulk-bar flow, both copied from the existing
bulk patterns in the same files (refresh-assets is the closest sibling).

- `bulkReclassifyContentAction(items)` in `src/app/admin/actions.ts`:
  per selected story, run `classifyStoryTags` (the same TS classifier the
  /admin/reclassify tool uses, via the admin-selected "llm" model) against
  the ACTIVE categories, then write BOTH `story_tags` (source "llm", first
  tag primary) and `stories.category` (the denormalized label every read
  path renders). Writing only one side is a known footgun: category-only
  writes get reverted by syncStoryPrimaryCategory on boot; tag-only writes
  leave the visible chip stale until the next cold start.
- Confidence floor: reuse `DEFAULT_CONFIDENCE_FLOOR` (0.6) from
  `src/lib/reclassify-tags.ts`. Below the floor, or when the classifier
  returns nothing, the story is left untouched and reported as
  "needs review" - same semantics as the /admin/reclassify review queue.
  The operator retags those by hand via the row chip.
- UI in `ContentList.tsx`: "Reclassify AI" BarButton next to the Category
  picker, confirm modal (count + preview + cost hint), result banner with
  per-outcome counts and per-story lines ("Title - Drama -> Roommate Hell
  (82%)"). Disabled when the selection has no video stories; articles in a
  mixed selection are skipped server-side, like Regenerate does.

## Rejected alternatives

- Per-row "reclassify" entry in the row ... menu: the row already has a
  manual category chip picker; a one-row AI action adds menu noise for
  marginal value. Bulk with one ticked row covers it.
- Extending /admin/reclassify with story filters: keeps the action off the
  page where the operator actually sees the wrong labels; violates the
  "lazy user finds it instantly" bar.
- Undo support: the pre-action tag SET (not just the label) would have to be
  snapshotted to restore faithfully; the existing undo machinery only
  carries one string per row. Cut from scope - re-running the action or the
  manual chip picker recovers any single mistake.

## Security

- Gated on `content.manage` like every other bulk action; validateItems
  caps the batch at MAX_BULK_ITEMS and type-checks every id.
- Closed-set guard: returned slugs are filtered against the CURRENT active
  categories server-side (mirrors applyReclassifyTagsAction), so a
  hallucinated slug can never reach story_tags or stories.category.
- No new inputs reach the LLM beyond story title/body already in the DB.

## Observability

- `[bulk-reclassify click]` with user id + count at entry.
- `[bulk-reclassify item]` per story: id, state, prev, next, confidence.
- `[bulk-reclassify done]` with per-state counts + duration ms.
- Client logs request/result under `[content list reclassify-ai ...]`,
  matching the other bulk flows.

## Settings audit

No new settings. The model comes from the existing admin Models page
("Writing (LLM)" stage selection). The confidence floor stays a code
constant, deliberately shared with /admin/reclassify - two floors would
make the two tools disagree about the same story.

## Testing

`tests/admin/bulk-content-actions.test.ts` (real SQLite test DB, classifier
mocked at the module boundary):

- confident result writes story_tags (primary first, source llm) AND the
  category label; state "retagged".
- same-label result still refreshes tags; state "unchanged".
- below-floor result writes nothing; state "needs_review".
- empty classifier result writes nothing; state "needs_review".
- hallucinated slug is dropped; nothing usable left -> "needs_review".
- articles -> "skipped"; unknown story id -> "errored".

## Deploy

Standard flow: branch `feat/bulk-ai-reclassify` off main, PR into main,
Vercel preview (never promoted manually), merge deploys production.
Rollback = revert the PR. Independent of PR #222 (pipeline classifier cap):
this feature uses the TS classifier, which never had the token cap bug.
