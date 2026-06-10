# LoreWire

Netflix for true internet stories. Each story is sourced from Reddit but rewritten and transformed into an original piece, offered three ways: a short doodle-explainer video, a readable article, and a read-along with word-accurate narration.

Mobile-first, dark, cinematic. The internet's stories, retold.

## Status

Validation build (P0). The front-end app shell runs with sample data and placeholder visuals. The content pipeline, database, admin, and real generated media come next. See [_plans/](_plans/) for the full architecture and rollout plan.

## Structure

- `lorewire-app/` — the Next.js 16 + React 19 + Tailwind v4 app (the product).
- `lorewire-design/` — design references exported from the design tools.
- `brand/` — logo and brand assets (wordmark, avatar, design prompts).
- `mockups/` — interactive HTML mockups.
- `_plans/` — the approved architecture and validation plan.

## Run the app

```bash
cd lorewire-app
npm install
npm run dev
```

Then open http://localhost:3000.

## Stack

Next.js (Vercel) · Cloud SQL Postgres · Google Cloud Storage behind Cloudflare · a Python content pipeline on Google Cloud · Remotion (AWS Lambda) for video · kie.ai for images, ElevenLabs and Google Cloud TTS for voice. Custom admin built into the app (no third-party CMS).

## Secrets

No secrets in the repo. Credentials live in `.env.local` (gitignored). Reference scripts that contained hardcoded keys are kept local only and excluded.
