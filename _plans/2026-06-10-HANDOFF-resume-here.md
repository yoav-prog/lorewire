# LoreWire - HANDOFF: resume here

Date: 2026-06-10
Repo: github.com/yoav-prog/lorewire, branch `main` (this work is at commit 7548809).
Read first: `/CLAUDE.md` (global rules), `_plans/2026-06-10-lorewire-architecture-and-validation.md`
(product/architecture), `_plans/2026-06-10-cms-and-media-pipeline.md` (this build), then this file.

Two trees:
- `lorewire-app/` - Next.js 16.2.9 + React 19 + Tailwind v4 (App Router). The site and the CMS.
- `pipeline/` - Python 3.12, standard library only (no pip installs needed). The content pipeline.

---

## 1. First, make the new machine runnable

These files are gitignored and are NOT in the repo. Copy them from the old machine (USB / password
manager), or recreate them with the same values. Variable names below; bring the values with you.

- `/.env` (repo root): `OPENAI_API_KEY`
- `/.env.local` (repo root): `GITHUB`, `GITHUB_TOKEN`, `VERCEL_TOKEN`, `KIE_API_KEY`,
  `ELEVENLABS_API_KEY`, `DECODO_TOKEN`
- `/lorewire-app/.env.local`: `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`
  (optional: `DATABASE_URL` for Postgres, `PIPELINE_DB` to point at a specific sqlite file)

How the env is loaded:
- The pipeline auto-loads `/.env`, then `/.env.local`, then `pipeline/.env` (see `pipeline/config.py`).
- The Next app loads `lorewire-app/.env.local` (Next convention).
- `GITHUB` is the fine-grained PAT that reaches the video repos; `GITHUB_TOKEN` (ghp_...) is the
  yoav-prog token used to push lorewire.

Tooling: Node 24+ (uses the built-in `node:sqlite`, no native build), Python 3.12.

Install + first run:
```
cd lorewire-app
npm install                      # jose, postgres, server-only are already in package.json
cd ..
python -m pipeline.run --fixture # regenerates the local DB with one real article (needs OPENAI key)
```
The local DB `pipeline/lorewire.db` is gitignored, so it does not travel. The `--fixture` run
recreates it. The admin user auto-seeds from `ADMIN_EMAIL`/`ADMIN_PASSWORD` on first login.

Run the app + admin:
```
cd lorewire-app && npm run dev      # http://localhost:3000  (public)  +  /admin  (CMS)
```
Log in at `/admin/login` with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Push to GitHub (auto-deploys to Vercel prod). Normal `git push` works once git creds are set; or:
```
git push "https://x-access-token:<GITHUB_TOKEN>@github.com/yoav-prog/lorewire.git" main
```

---

## 2. What is DONE and verified (do not rebuild)

- CMS at `/admin`: auth (jose session cookie, scrypt passwords, `src/proxy.ts` guard, DAL in
  `src/lib/dal.ts`), dashboard, review queue, story editor, per-stage model picker, settings.
  Verified end to end (seeded admin, real session, every page 200 against live DB data).
- Dual-driver store `src/lib/db.ts`: `node:sqlite` locally (same file the pipeline writes),
  Postgres when `DATABASE_URL` is set. Canonical schema `src/lib/schema.ts`, mirrored in
  `pipeline/store.py`. Additive column migrations.
- Publish -> live bridge: set a story to "published" in the CMS, run
  `python -m pipeline.export_app` (writes `src/data/published.ts`, only published rows), redeploy.
  `src/lib/stories.ts` overlays published bodies onto the sample catalog. Verified on the live site.
- Pipeline stages, each verified against the real API:
  - Scrape `pipeline/stages.py` - Decodo (ported from `from-amir/redditscraperformsn 2 2.py`).
  - Article - OpenAI rewrite + `_clean_typography` (no smart quotes / em dashes).
  - Images `pipeline/images.py` - kie.ai createTask/poll/download. gpt-image-2 produced an on-brand
    doodle; nano-banana-2 slug confirmed. Marked wired in `config/models.json`.
  - Voice `pipeline/voice.py` - ElevenLabs `/with-timestamps` -> mp3 + word-level timings.
- Model selection is config + DB (admin picks, pipeline resolves via `pipeline/models.py`). Keys
  stay in the environment, never in `config/models.json`.

---

## 3. What is LEFT (priority order, with enough detail to execute)

### 3.1 Orchestrate the media stages into one pipeline run  (HIGHEST VALUE, START HERE)
Right now `pipeline/run.py` is text-only (scrape -> research -> write_article -> store). The image
and voice adapters work standalone but are NOT called by a run, and a story's media columns
(`hero_image`, `images`, `audio_url`, `alignment`) are never populated.
Do:
- Add a `--media` flag to `run.py`. After `write_article`, for each story:
  1. Build 1 hero + 3-5 scene image prompts from the article (a small LLM call, or template the
     doodle style string from the `video.style` setting). Call `images.generate(...)` per prompt,
     `images.download(...)` into `lorewire-app/public/generated/<id>/`. Store the public paths in
     `hero_image` + `images` (JSON array).
  2. Build a narration script (the article, or a tightened 60-90s version) and call
     `voice.synthesize(script, .../narration.mp3)`. Store `audio_url` + `alignment` (the word
     timings JSON).
  3. Update `cost_cents`/`tokens` on the story from `images.totals` + `voice.totals` + llm tokens.
- Gate spending on the `budget.daily_usd` setting before the media calls (read via
  `pipeline.store.get_setting`). Log what was skipped.
The admin editor already renders `hero_image`/`images`/`audio_url`/`video_url` when present, so this
lights up the review screen immediately.

### 3.2 Video stage (Remotion doodle short)
The engine lives in the `youtubestudio` GitHub repo (Remotion doodle video + teleprompter),
reachable with the `GITHUB` fine-grained token in `.env.local`. There is also `newturbovid`
(Python video backend) as an alternative.
Do:
- Clone it (into `_reference/` which is gitignored) and study the Remotion composition + inputs.
  `git clone https://x-access-token:<GITHUB>@github.com/<owner>/youtubestudio.git _reference/youtubestudio`
  (owner is on the user's GitHub; list repos with the token if unsure.)
- Create `pipeline/video.py` (or a small node render script) that takes: the generated images, the
  ElevenLabs mp3, and the word timings, and renders an MP4 via `npx remotion render`. Remotion needs
  Node + a headless Chromium (Remotion installs one) + ffmpeg. Store the result as `video_url`.
- Wire it as the last step of the `--media` run (3.1), behind the budget gate.
- This is the heaviest piece; treat it as its own focused session. Verify with one real render.

### 3.3 Show real images/audio in the public UI
`lorewire-app/src/components/AppShell.tsx` (mobile) and `DesktopShell.tsx` (desktop) draw posters
with a CSS `PosterArt` component and do not use real images. Add optional `hero_image`/`images` to
the `Story` type (already merged via `published.ts`) and render an `<img>`/poster when present, in
`PosterArt`, `Hero`, and the detail modal. Add the audio + word-synced read-along to the Read tab
(the timings are in `alignment`). Keep the existing animation/feel.

### 3.4 Production admin (Vercel)
The public site is live and fine. For `/admin` to work on Vercel, set in the Vercel project env:
`SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `DATABASE_URL` (a real Postgres - Neon free
tier or Google Cloud SQL; the app switches to Postgres automatically when `DATABASE_URL` is set).
`node:sqlite` will not work on Vercel's serverless filesystem, so prod MUST use Postgres.
After Postgres is connected, optionally refactor the public shells to read published stories from
the DB live (instead of the static `published.ts` export), so publishing is instant without a
redeploy. Until then, keep the export bridge (3 in section 2).

### 3.5 Smaller items
- GCS upload for durable media at scale (assets are saved locally for now). Needs a bucket + service
  account credentials; add an upload helper and switch `images.download`/voice output to upload.
- Pipeline should generate a branded LoreWire title + synopsis (currently uses the raw Reddit
  headline; the overlay in `stories.ts` deliberately keeps curated sample titles). Add a title/synopsis
  LLM call in `stages.py` and store them; then let the overlay use them.
- Rotate any secrets that were ever shared in chat (Decodo, Strapi, the OpenAI key in the old
  from-amir script, etc.). Standing security task.

---

## 4. File map (quick reference)

App (lorewire-app/src):
- `proxy.ts` - admin auth guard (Next 16 renamed middleware -> proxy)
- `lib/db.ts` - dual driver; `lib/schema.ts` - canonical schema; `lib/repo.ts` - queries
- `lib/session.ts` - jose cookie; `lib/passwords.ts` - scrypt; `lib/dal.ts` - requireAdmin/seed
- `lib/models.ts` + `data/models.json` - model registry/selection for the picker
- `lib/stories.ts` - sample catalog + `data/published.ts` overlay (public content)
- `app/admin/...` - login, actions.ts, AdminNav, ui.ts, `(panel)/` dashboard+stories+models+settings
- `components/AppShell.tsx` (mobile), `components/DesktopShell.tsx` (desktop) - the public UI

Pipeline (pipeline/):
- `config.py` env loader; `store.py` sqlite store (mirrors schema.ts); `models.py` registry/selection
- `stages.py` scrape+research+write_article (+ Decodo, typography clean)
- `images.py` kie.ai; `voice.py` ElevenLabs; `run.py` orchestrator; `export_app.py` publish export
- `fixtures/sample_post.json` - offline fixture for `--dry-run`/`--fixture`

Config: `/config/models.json` (pipeline's registry copy; keep in sync with the app's `data/models.json`).

---

## 5. Useful commands
```
python -m pipeline.run --dry-run                       # offline, no keys, stub transforms
python -m pipeline.run --fixture                        # fixture post, REAL llm rewrite
python -m pipeline.run --subreddit AmItheAsshole --limit 1   # full real run (scrape + llm)
python -m pipeline.models list                          # show registry + active selections
python -m pipeline.export_app                           # export published stories to the app
cd lorewire-app && npm run build                        # typecheck + production build
cd lorewire-app && npm run dev                          # dev server (public + /admin)
```
