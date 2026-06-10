# LoreWire pipeline

Turns Reddit threads into original LoreWire stories: **scrape → idea → research (anti-fabrication) → article → store**. Logic is adapted from Amir's reference scripts (`/from-amir`, kept local); the plumbing is rebuilt so secrets come from the environment and output goes to a real store.

## Dry run (no keys, offline)

Runs the whole flow on a bundled fixture using only the Python standard library, and writes a story to a local SQLite DB. From the repo root:

```bash
python -m pipeline.run --dry-run
```

You should see a processed story listed, and `pipeline/lorewire.db` created.

## Real run (needs rotated keys)

1. `cp pipeline/.env.example pipeline/.env` and fill in rotated keys (LLM, Decodo, kie.ai, TTS). Load it into your shell (or use `python-dotenv`).
2. `python -m pipeline.run --subreddit AmItheAsshole --limit 5`

The external stages (real scrape, LLM research/writing, images, voice, video) are clearly-marked `NotImplementedError` seams to be ported from `/from-amir` once keys are in place.

## Status

- Done: package structure, env-driven config, SQLite store (Postgres-ready schema), dry-runnable text flow.
- Next (needs keys): real Decodo scrape, LLM research/writer, kie.ai images, ElevenLabs/Google TTS + word-alignment, Remotion doodle video (from the youtubestudio engine), and writing finished stories to the app's database.
