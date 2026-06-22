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
