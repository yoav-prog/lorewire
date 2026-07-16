# Safety judge v2 backtest

Validates the recalibrated safety judge (`v2` in `src/lib/story-safety-judge.ts`)
before it is ever trusted in production. Phase 2 of
`_plans/2026-07-15-autopilot-auto-publish-israel-drop.md`.

## The bar

The run passes (exit 0) only when **both** hold:

- **Zero false holds** on SAFE content — the ordinary AITA-style drama the judge
  wrongly held ~100% of the time. This is the miscalibration we are fixing.
- **Zero missed dangers** on the hand-seeded BAD content — one clear example per
  danger category (named-real-person defamation, minor harm, sexual, gore, hate,
  policy). A miss here is a real strike/defamation risk.

The v2 system prompt and model are read straight out of
`src/lib/story-safety-judge.ts` at runtime, so the harness always tests the live
prompt. The JSON schema and the `decision === "publish"` pass rule mirror the
lib and are pinned by `src/lib/story-safety-judge.test.ts`.

## Run

Needs a real `OPENAI_API_KEY` (env or `.env.local`). Makes real calls — the full
set is a few cents.

```
node scripts/safety-judge-eval/run-eval.mjs                    # built-in fixtures
node scripts/safety-judge-eval/run-eval.mjs --goldset=./held-66.json
node scripts/safety-judge-eval/run-eval.mjs --limit=4          # quick smoke
```

## The real goldset (the 66)

The built-in SAFE fixtures stand in until you replay the **actual** 66
held-then-published stories from prod. Export them to a JSON array of
`{ id, title, body }` (all are expected to publish), then pass `--goldset`.

Rough export (prod Postgres — adjust to taste):

```sql
SELECT json_agg(json_build_object('id', s.id, 'title', s.title, 'body', s.body))
FROM stories s
WHERE s.id IN (
  SELECT DISTINCT story_id FROM scheduler_decisions WHERE decision = 'auto_held'
)
AND s.status = 'published';   -- the ones you later published by hand
```

Save the result as `held-66.json` and run with `--goldset=./held-66.json`.

## Then what

Only after a run passes with the real goldset should the safety-check mode be
moved from **Shadow** to **Active** at `/admin/scheduler`. Even then, watch the
"held & why" list and "Published by autopilot" for a few days, and keep the
emergency stop one click away.
