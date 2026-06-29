# Title length gate + one-click admin regenerate

## The bug (from a 2026-06-25 screenshot)

A live hero rendered the title "MY SON ATE THE MIDDLES OUT OF EVERY
CINNAMON ROLL BEFORE I GOT TO THE TABLE THIS MORNING." — 99 characters,
16 words. It wrapped to nine lines and visually dominated the hero,
crowding out the synopsis, the action buttons, and the artwork.

## Root cause

Three independent failures stack:

1. **The LLM-branded title was empty.** `make_title_and_synopsis` in
   `pipeline/stages.py` returns `("", "")` when the JSON parse fails,
   with no retry and no salvage path.
2. **The fallback hands the raw Reddit headline through to the public
   site.** `pipeline/story_jobs_worker.py:346`:
   `"title": branded_title or idea["headline"]`. Reddit headlines run
   long — they're sentences, not titles — so the "or" branch ships
   exactly the kind of string the branded prompt was designed to
   replace.
3. **The Hero has no render-time defense.** `DesktopShell.tsx:364`
   hardcodes `fontSize: 84` for the title, with `max-w-[620px]`. At 84
   px / `tracking-tightest`, anything past ~30 characters wraps; past
   ~50 characters it starts to dominate the hero; past ~80 characters
   it becomes the entire hero.

Each failure on its own is recoverable. The three together produce the
screenshot.

## Goal

Three layers of defense so this never reaches a viewer again, plus a
one-click recovery path for an admin who spots one that slipped:

1. **Generation gate** — never let a too-long title leave the pipeline.
2. **Render-time floor** — even if one slips through, the hero stays
   composed (font scales down by length bucket).
3. **Admin recovery** — a "Regenerate" button on the article editor's
   Title field that runs the same constrained LLM call on demand and
   writes the new title back.

## Length policy

The Python prompt already says "2 to 6 words." The
`TITLE_STYLE_EXAMPLES` list ranges 9–23 characters. We codify:

- **Soft target**: 2–6 words, ≤ 32 characters.
- **Hard cap**: ≤ 50 characters AND ≤ 8 words. Anything past either
  bound is rejected.

50 chars / 8 words is the line where the hero at 84 px wraps to four
lines or less — visually busy but not catastrophic. Past 50 chars the
render-time floor takes over.

## Chosen approach

### Layer 1 — generation gate (`pipeline/stages.py`)

In `make_title_and_synopsis`:

- After parsing the LLM JSON, run the title through a validator
  (`_title_within_bounds`). If it fails, call the LLM once more with a
  stricter prompt that quotes the previous attempt and explicitly
  rejects it ("Your previous attempt was N characters / M words. Make
  it short — 2 to 6 words, under 32 characters.").
- If the retry also fails the validator, run a deterministic salvage
  (`_salvage_title_from_body`): take the first sentence's leading
  noun-phrase, uppercase, cap at 50 chars / 8 words. Never return an
  empty title, never return the raw Reddit headline.

In `pipeline/story_jobs_worker.py:346`:

- Replace `"title": branded_title or idea["headline"]` with
  `"title": branded_title`. `branded_title` is now guaranteed non-empty
  by the validator+salvage path, so the `or` fallback is dead code; we
  delete the trap instead of leaving it loaded.

### Layer 2 — render-time floor (`DesktopShell.tsx` + `AppShell.tsx`)

Replace the hardcoded `fontSize: 84` with a length-bucket function
`heroTitleFontSize(title)`:

| Chars  | Desktop | Mobile |
|--------|---------|--------|
| ≤ 30   | 84      | 56     |
| 31–50  | 64      | 44     |
| 51–80  | 48      | 34     |
| 81+    | 36      | 28     |

The desktop sizes match today's `84` at the short end so existing well-
sized titles render identically. The mobile picks come from reading
the current `AppShell.tsx` hero size (Phase: I'll grep the actual value
during implementation and key off it).

Logged once per render with the bucket choice so we can grep how often
the floor fires:
`console.info("[hero title size]", { storyId, chars, words, bucket, fontSize })`.

### Layer 3 — admin recovery

A new TypeScript module at `lorewire-app/src/lib/title-regenerator.ts`
mirrors the SEO-metadata pattern (`lib/seo-metadata.ts`):

- `regenerateTitleForStory({ storyId })`:
  - Reads `stories.title`, `stories.body`, `stories.category`.
  - Calls `chatCompletion` (lib/llm.ts) with the same prompt as the
    Python pipeline (extracted to a shared string constant so the
    pipeline and the admin agree on voice).
  - Validates with a Zod schema:
    `z.string().min(3).max(50).regex(/^[A-Z0-9' ,.\-!?$&]+$/)` plus a
    custom `.refine(words ≤ 8)`.
  - On success: writes to `stories.title` via `updateStory`. Returns
    `{ ok: true, title }`.
  - On failure: returns `{ ok: false, error }`. The current title
    stays untouched.

A new server action in
`lorewire-app/src/app/admin/(panel)/articles/[id]/actions.ts` (or the
already-existing admin actions file — whichever matches the
ArticleEditor's existing imports during implementation):
`regenerateStoryTitleAction(storyId)`. Gated by
`requireCapability("content.manage")`. Revalidates the admin path on
success.

A new button in
`lorewire-app/src/app/admin/(panel)/articles/[id]/ArticleEditor.tsx`,
inline with the Title input label: "Regenerate" — when clicked, calls
the action, replaces the input's value with the returned title, shows
a small inline status (`"Generating…"` / `"Saved"` / `"Failed: …"`).
Matches the visual language of the existing SeoMetadataCard
regenerate button.

## Alternatives rejected

1. **Just truncate the title at render time.**
   Cheapest, but cuts mid-word ("MY SON ATE THE MIDDLES OUT OF EVE…"),
   which is uglier than the wrap. And the underlying DB row still has
   the bad title, so search / share / SEO all carry it.

2. **Per-story manual title-only field that overrides the LLM title.**
   The user already has `articles.title` editable in the admin. Adding
   another field is duplication. The right answer is to make the
   automatic flow trustworthy AND make the manual edit easier with a
   one-click regen.

3. **Block publish when the title fails the length check.**
   Tempting (fail loud, fix at the source) but high-friction — every
   bad title becomes an interruption for the admin. Better: never
   produce a bad title in the first place (layer 1), and if one slips
   through give a one-click fix (layer 3). The render-time floor
   (layer 2) keeps the user-visible blast radius bounded while the
   admin reacts.

4. **Call the Python pipeline from the admin via subprocess.**
   The Lorewire app already has its own TS LLM client (`lib/llm.ts`)
   used by the SEO metadata regeneration. Mirror that pattern. Calling
   subprocess from a Next.js server action would add a deploy
   coupling we don't otherwise have.

## Security & safety (rule 13)

- The regenerate action is gated by `requireCapability("content.manage")`
  — same gate every other content-write action uses.
- No user input flows into the LLM prompt; the body comes from
  `stories.body` (already admin-authored content), the category is a
  closed enum.
- The Zod schema's regex pins the title's character set, so even a
  pathological LLM response can't smuggle markup, control characters,
  or excessive whitespace into `stories.title`.
- Failure path returns an error string but never writes to the DB —
  no partial state, no rollback needed.

## Observability (rule 14)

- `pipeline/stages.py`: log `[stages title gate]` with `{ attempt, chars, words, accepted }` on every validator check.
- `pipeline/stages.py`: log `[stages title salvaged]` when the salvage path fires (this is the "rarely happens, must investigate when it does" signal).
- `lib/title-regenerator.ts`: log `[title regen]` with `{ storyId, oldChars, newChars, ok }` per call.
- `actions.ts`: log `[admin title regen]` with `{ storyId, actorId, ok }` per call (auditable).
- `DesktopShell.tsx`: log `[hero title size]` at render with `{ storyId, chars, bucket }` so we can grep how often the floor fires (a high rate = layer 1 is leaking).

## Settings audit (rule 15)

No new settings. The thresholds (50 chars / 8 words / bucket sizes)
are tuned to the brand and the hero geometry — exposing them as user
settings would let an admin shoot themselves in the foot
(`max_chars=200` would re-open the bug). If we ever need to retune,
we change the constants and ship.

## Testing (rule 18)

- **`pipeline/tests/test_stages.py`** — extend:
  - `_title_within_bounds("THE $800 ENVELOPE")` → true
  - `_title_within_bounds("MY SON ATE THE MIDDLES…")` → false
  - Mock `llm.chat` to return a bad title first then a good one →
    `make_title_and_synopsis` returns the good one (retry works).
  - Mock both calls to return bad titles → salvage fires, returns a
    non-empty title within bounds.
- **`lorewire-app/src/lib/title-regenerator.test.ts`** — new:
  - Zod schema accepts brand-voice titles, rejects 99-char strings.
  - `regenerateTitleForStory` with mocked LLM returns new title +
    writes to DB.
  - `regenerateTitleForStory` with mocked LLM returning a bad title
    does NOT write to DB and returns `{ ok: false }`.
- **`DesktopShell.tsx`** — small extracted-pure test on
  `heroTitleFontSize`:
  - 20 chars → 84, 40 chars → 64, 60 chars → 48, 99 chars → 36.
- **Manual QA**:
  - Open the cinnamon-roll story in admin, click Regenerate, verify
    a 2–6 word title comes back and the hero re-renders cleanly.
  - Look at three other live heroes; confirm they still render
    identically (no regression on already-good titles).

## Deploy (rule 19)

- **Branch**: cut a fresh `feat/title-length-gate` off the current
  production-source branch (verify via Vercel before branching, per
  AGENTS.md).
- **PR target**: `main`.
- **Do NOT** manually promote any preview to production from the
  Vercel UI (the inverted-production rule from AGENTS.md still
  applies until main catches up).
- **Rollback**: the Python change is a function-internal hardening; a
  revert restores the old `or idea["headline"]` fallback. The TS
  changes are additive (new file, new action, new button) — a revert
  removes them without touching existing state. The render-time
  floor is a function swap; revert restores the hardcoded 84.

## Open questions

1. **Does `articles.title` need to sync to `stories.title`?**
   The article editor edits `articles.title`. The hero reads
   `stories.title`. During implementation I'll verify whether
   `saveArticleAction` already propagates to `stories`, or whether
   the regen needs to update both. (Best guess from the code: they're
   independent and the publish flow synchronizes — but I'll confirm
   before writing the regenerate.)
2. **Should the regenerate button live on the article editor or on
   the story admin page?**
   The article editor has the title input visible; that's the natural
   home. But if the canonical title lives on `stories`, the story
   admin page might be a better fit. I'll pick based on where the
   admin's eye is when they spot the bug — almost certainly the
   article editor (it's the page they're already on when reviewing a
   piece). The button gets duplicated if a second surface needs it.
