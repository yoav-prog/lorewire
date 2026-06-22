# Branch + main cleanup after the stale-branch production incident

**Date:** 2026-06-22
**Trigger:** Promoting commit `760ba40` from `feat/multi-platform-shorts-publisher` to production silently removed 20K lines of R2 media work, because that branch was missing the R2 migration. Rollback required.

## Current state (audited)

- **main** is at `98fdb88`. It is **27 commits behind** every active feature branch. Production has been deploying from feature branches, so main never received the feature merges — main has decayed into a stale snapshot.
- **5 active feature branches** (commits dated 2026-06-22), all 90–140 commits ahead of main:
  - `feat/multi-platform-shorts-publisher` (140 ahead) — **now the superset** after merging R2 in (`bfc5987`).
  - `feat/r2-media-migration` (135 ahead) — fully contained in the multi-platform branch.
  - `feat/article-comments` (98 ahead) — fully contained.
  - `feat/share-sheet-and-ratings` (110 ahead) — content contained; only the branch-tip commit identity differs.
  - `feat/gdpr-compliance` (102 ahead) — fully contained.
  - `feat/facebook-login` (90 ahead) — content contained; only the branch-tip commit identity differs.
- **~15 dead branches** (last commit 2026-06-15/16, 0 commits ahead of main) — already merged or abandoned, safe to delete.
- **Working state:** there is active uncommitted in-progress work on `feat/article-comments-restored` (comments admin UI, moderation libs, untracked DB files, etc.). This branch is the user's current working tree and must be preserved.

## Root cause

1. Long-lived feature branches were promoted directly to production via Vercel instead of going through main.
2. Main was never updated, so feature branches diverged from each other without a sync point.
3. When a stale branch's build was promoted, production reverted to whatever state that branch held — losing any work that lived on other branches.

## Target state

- **main is the only branch production deploys from.** No more feature-branch promotions to prod.
- **main contains everything currently in production**, i.e. the contents of `feat/multi-platform-shorts-publisher` HEAD after the R2 merge.
- **Active feature branches** rebase or merge main regularly so the divergence check in `AGENTS.md` always comes back clean.
- **Dead branches deleted** so they can never be accidentally promoted.
- **The git workflow rules** in `lorewire-app/AGENTS.md` (just committed) prevent a repeat: fetch first, run the divergence check in both directions before every push to a long-lived branch, flag the user if main has missing commits, never bundle in pre-existing in-progress work.

## Execution plan

### Phase A — Bring main current (the load-bearing step)

1. Open a PR: `feat/multi-platform-shorts-publisher` → `main`.
2. Review the PR contents: 140 commits, ~20K lines of code that's already been running in production at various points. The merge should be a fast-forward or a clean merge commit.
3. Merge the PR. main now equals the production-deployed superset.
4. **Verify** in the GitHub UI that the merge commit is on main before proceeding.

### Phase B — Fix Vercel deployment config

Manual user step in Vercel UI:
1. Project → Settings → Git → **Production Branch = `main`** (verify).
2. Disable any "auto-promote from feature branch" toggles if present.
3. Preview deployments stay enabled for feature branches (that's fine — they don't affect production).
4. Workflow rule: **promoting a non-main build to production is forbidden going forward.** This needs to be enforced by discipline; Vercel doesn't have a built-in lock against it.

### Phase C — Clean up dead branches

Safe to delete (0 commits ahead of main, last activity 2026-06-15/16):

```
feat/article-shorts
feat/voice-picker-dropdown
feat/homepage-live-catalog
feat/lane-b-c-caption-style
feat/shorts-to-article-media
feat/short-caption-style-tab
feat/reddit-default-to-shorts
feat/short-editor-phase-4-laneC
feat/short-editor-phase-1-scenes
feat/short-editor-render-timeline
feat/intro-outro-per-aspect-active
feat/short-render-events-and-cancel
feat/short-editor-phase-5-edit-session
feat/short-editor-preview-and-surfacings
feat/short-editor-phase-2-captions-laneA
feat/short-editor-phase-3-script-voice-laneB
```

After Phase A:

```
feat/r2-media-migration              # superseded — content already on main
feat/article-comments                # superseded — content already on main
feat/share-sheet-and-ratings         # superseded — content already on main
feat/gdpr-compliance                 # superseded — content already on main
feat/facebook-login                  # superseded — content already on main
feat/multi-platform-shorts-publisher # merged into main, delete after PR closes
```

### Phase D — Handle the live working branch

`feat/article-comments-restored` has active in-progress work (uncommitted) for a comments restoration feature. After Phase A:

1. Wait for the user to commit the in-progress work themselves (the SQLite DB shows an active dev/pipeline session, so I can't safely touch this branch).
2. Once committed, rebase `feat/article-comments-restored` onto the new main so it's based on the production-current state.
3. Open a PR for it to main when the feature is ready.

### Phase E — Going forward

Every new feature:
1. `git checkout main && git pull origin main` — start from a fresh main.
2. `git checkout -b feat/<short-name>` — short-lived branch.
3. Push, open PR, merge to main, delete branch.
4. Long-running branches (>1 day) must merge or rebase main BEFORE pushing new commits. Codified in `lorewire-app/AGENTS.md`.

## What I will NOT do without explicit approval

- Force-push anything.
- Reset main.
- Delete any remote branch.
- Change Vercel config (it's user-controlled, but I can document the required toggles).
- Touch the `feat/article-comments-restored` working tree (live SQLite session present).

## Open questions for the user

1. Approve Phase A (open PR `feat/multi-platform-shorts-publisher` → `main`)?
2. Approve the dead-branch deletion list in Phase C, or trim it?
3. Want me to script the branch deletions (gh CLI) or leave that to a manual sweep?
4. Confirm Vercel Production Branch = main is set (Phase B) or want me to flag what to check?
