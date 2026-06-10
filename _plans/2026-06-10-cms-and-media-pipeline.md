# LoreWire: CMS + media pipeline build

Date: 2026-06-10
Status: in progress (video stage pending)

## Goal

Make the whole LoreWire pipeline work end to end and ship an extremely robust,
custom CMS (admin panel) for reviewing and publishing stories, with model
selection driven from the admin (not env vars). Keep API keys secret in the
environment.

## What is built and verified

### Robust CMS (Next.js 16 admin, at /admin)
- Auth: jose JWT session in an httpOnly cookie, scrypt password hashing
  (node:crypto, no native dep), `src/proxy.ts` optimistic guard on /admin, and a
  Data Access Layer (`src/lib/dal.ts`) that does the authoritative DB/role check
  at the data source. First admin is seeded from env on first login.
- Pages: login, dashboard (counts, active models, spend, recent), review queue
  with status filters, story editor (title/category/synopsis/body/read-along +
  media preview + status transitions), model picker per stage, settings.
- Server actions re-check `requireAdmin()` before every mutation.
- Verified end to end: seeded the real admin, minted a real session, fetched
  every admin page (all 200, all rendering live DB data).

### Data layer (dual driver)
- `src/lib/db.ts`: Postgres via DATABASE_URL (porsager `postgres`), else Node 24
  `node:sqlite` against the same file the pipeline writes
  (`../pipeline/lorewire.db`). Portable SQL ("?" -> "$1" translation, TEXT ids,
  ISO timestamps, JSON-as-text). Schema in `src/lib/schema.ts`, mirrored in
  `pipeline/store.py`. Additive migration adds missing columns on older DBs.

### Publish -> live bridge
- The public site reads a static catalog, so publishing is: set status to
  "published" in the CMS, run `python -m pipeline.export_app` (exports only
  published rows into `src/data/published.ts`), redeploy. `lib/stories.ts`
  overlays published bodies onto the sample catalog. Verified: published the
  envelope story, exported, rebuilt, confirmed the body is in the shipped bundle.

### Pipeline (Python, stdlib only)
- Scrape: real Decodo Scraping API (`pipeline/stages.py`), ported from
  from-amir. Verified live against r/AmItheAsshole.
- Write: OpenAI rewrite with a typography sanitizer (straight quotes, no em
  dashes) to match brand voice. Full real run verified on a live post.
- Images: `pipeline/images.py`, kie.ai createTask + poll recordInfo + download.
  Verified: generated and saved an on-brand doodle (gpt-image-2). nano-banana-2
  slug confirmed from docs.
- Voice: `pipeline/voice.py`, ElevenLabs /with-timestamps -> mp3 + word-level
  timings for the read-along. Verified: 20 words aligned with accurate times.
- Model selection: `config/models.json` registry + DB settings; the admin picks,
  the pipeline resolves. gpt-image-2, nano-banana-2, elevenlabs marked wired.

## Decisions

- No external DB required for the validation phase: SQLite locally, Postgres in
  prod by setting DATABASE_URL (Neon/Cloud SQL). Lift-and-shift, not a rewrite.
- Custom CMS in Next.js (no Strapi).
- Assets saved locally during validation; GCS upload is a later swap (needs
  bucket + credentials).
- Public shells keep importing the static catalog; a live DB read in the public
  UI only pays off once a prod Postgres exists, so it is deferred.

## Remaining

- Video stage: fetch the Remotion doodle-explainer engine from the GitHub repo
  (GITHUB token) and port it; render a short from images + narration + timings.
- Production admin: set SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, and
  DATABASE_URL (Postgres) in Vercel so /admin works on the live host. Public site
  works without them.
- GCS asset upload for durable media at scale.
- Pipeline should generate a branded title/synopsis (currently uses the raw
  Reddit headline; editable in the CMS).
- Rotate any previously leaked secrets.

## Security

- Keys only in gitignored env files (.env / .env.local), never in code or the
  registry. Sessions are httpOnly + signed; secure flag on in production.
- Authorization checked at the data source in every action and admin page, not
  only in the proxy. Passwords scrypt-hashed, constant-time verify.
