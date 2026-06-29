<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Git workflow — non-negotiable

Production on this project deploys via Vercel, and Vercel can promote a
build from any branch — including a feature branch — to production.
That makes the branch I push to as load-bearing as the diff I write. A
stale feature branch can revert production to a state missing other
features, and the diff in my commit will look innocent while the
outcome is a takedown. This happened on 2026-06-22 when an 8-line CSS
fix promoted from a stale feature branch silently removed 20K lines of
R2 media work from production.

## Before every push

1. **Fetch first.** `git fetch origin` — never reason about branch
   state without a fresh fetch.

2. **Check divergence from main.** Run both directions:
   ```
   git log HEAD..origin/main --oneline    # what main has that this branch is MISSING
   git log origin/main..HEAD --oneline    # what this branch has that main is missing
   ```

3. **If the first list is non-empty, stop and flag.** The branch is
   behind main. List the missing commits to the user, especially
   anything touching: schema, migrations, R2 / media URL resolution,
   env keys, `vercel.json`, `next.config.ts`, image domain allowlists,
   auth providers. Then ask: "Bring main into this branch first, or
   push anyway with the risk?" Default to bringing main in.

4. **Never run `git push` on a long-lived feature branch without this
   check.** Short-lived branches I just created in the same session,
   off a known-fresh main, are the only exception.

## The main = production invariant

Vercel auto-deploys main. **The act of merging anything to main —
including a markdown-only PR — triggers a production deploy of the
whole post-merge main state.** The PR's diff being innocent does NOT
mean the merge is innocent.

This caused a SECOND production takedown on 2026-06-23, on top of the
2026-06-22 stale-branch incident. PR #51 contained only `AGENTS.md` +
a plan markdown — zero application code. When it merged to main, Vercel
deployed main. Main was the stale `98fdb88` baseline (because
production had been deploying from feature branches, so main never
received feature merges). Production lost everything that was running
from the feature-branch state. Identical user-facing symptom as
incident #1, caused by the merge action rather than the push action.

### Before recommending or executing ANY merge to main

1. Identify the branch currently serving production (Vercel dashboard,
   or ask the user). For lorewire this has been
   `feat/r2-media-migration` after both rollbacks.

2. Run the divergence check against that branch, not just main:
   ```
   git fetch origin
   git log origin/main..origin/<production-source-branch> --oneline
   ```

3. **If that returns any commits, main is behind production. Refuse to
   merge any PR to main, even a trivial one.** Tell the user
   explicitly: "Main is behind production by N commits from branch X.
   Merging this PR will replace production with stale main." Then
   block until one of:
   - main is brought current with production (merge the production-
     source branch into main first, resolve any conflicts)
   - Vercel Production Branch is changed off main, so main is no
     longer the deploy trigger

4. Only after main equals or exceeds production state is main safe to
   merge into.

## Never manually promote a non-production-source build in Vercel UI

Vercel's Environments → Production tracks a branch and auto-deploys
pushes to that branch. But Vercel ALSO exposes manual "Promote to
Production" / "Redeploy" / "Rebuild" actions on individual deployments,
and **those actions BYPASS the Production Branch tracking**. Clicking
"Promote to Production" on a deployment from a non-production-source
branch forces a production build from that branch — regardless of
what Environments says is tracked.

This caused a THIRD production takedown on 2026-06-23. After we changed
Vercel Production Branch to `feat/multi-platform-shorts-publisher` (the
inverted state — production runs from a feature branch while main
remains stale), I told Yoav that merging PR #52 to main was safe.
Vercel built the merge as a Preview as expected. Yoav then manually
clicked "Promote to Production" on the main preview thinking that's
how you ship a merged PR — and Vercel promoted stale main over the
multi-platform production, repeating the takedown.

### The rule

In a project where production = a non-main branch (the temporary
inverted state lorewire is in until main catches up):

- **Never click "Promote to Production", "Redeploy", or "Rebuild" on
  any Vercel deployment whose branch is NOT the production-source
  branch.** Doing so forces a production build from whatever branch
  that deployment came from, regardless of Environments tracking.
- The Production Branch in Environments controls AUTO deploys only.
  Manual promotion in the UI overrides it.
- When recommending any merge to main or push to a non-production-
  source branch, ALSO include explicit Vercel-UI safety guidance:
  "Once Vercel builds the preview, do not promote it to production
  manually. It must stay a preview."

### When this rule retires

This rule is for the inverted state. Once main catches up to production
and Vercel Production Branch is set back to main, manual promotion of
main is the normal workflow again. Check Vercel Environments →
Production at the start of any deploy-touching session to know which
state the project is in.

## Branch hygiene

- **One source of truth:** `main` is the only branch production should
  deploy from. Any other deploy is a workflow accident, not a design.
- **Feature branches stay current with main.** If a branch has been
  alive for more than a day, the first thing I do when touching it is
  bring main in (merge or rebase) before adding new commits.
- **Long-running parallel branches are debt.** When I see two feature
  branches both touching shared files (auth, schema, config), flag the
  collision to the user before adding more divergence.
- **PRs target main, not other feature branches.** If asked to PR into
  a non-main branch, confirm that's intentional — it almost always
  means a sequencing problem upstream.

## Commit hygiene

- **One concept per commit.** If `git diff --stat` shows unrelated
  files in the staging area, split before committing. The 2026-06-22
  incident was made worse by parallel branches mixing concerns; clean
  commits are the prerequisite for clean branches.
- **Never bundle in pre-existing in-progress work I didn't touch.**
  Always `git add <specific paths>`, never `git add -A` / `git add .`.
- **Read `git status` before staging, then again after.** Surprises in
  the second read mean I'm about to commit something I don't
  understand.
