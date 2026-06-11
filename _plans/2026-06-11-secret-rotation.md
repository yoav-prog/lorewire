# Secret rotation runbook

Date: 2026-06-11
Status: standing reference

## Why rotate

The handoff (3.5) flagged this as a standing security task. Concretely:

- The OpenAI key in `/from-amir/*` scripts has been in plaintext on disk and
  in git history since before this project existed.
- The Decodo Scraping API token has appeared in chat conversations during
  pipeline debugging.
- The Strapi admin credentials in earlier handoff drafts and the old CMS
  references.
- Every other key has at minimum been moved through `.env.local` files on
  multiple machines (Yoav's laptop, Amir's laptop, the new machine) — a
  reasonable rotation cadence is once per quarter regardless.

Rotation cadence:

- **Immediately**: anything that was ever pasted into a chat window, a public
  README, a screenshot, or a screen-share recording.
- **Quarterly**: everything else, as a hygiene practice.
- **On personnel change**: anyone who had `.env.local` on their machine loses
  access; every secret they had visibility to gets rotated within 24 hours.

## Order to rotate (highest exposure first)

1. **OpenAI** — the one in `/from-amir/redditscraperformsn 2 2.py` is the
   oldest known plaintext copy.
2. **Decodo** — was pasted in chat in early scrape debugging.
3. **GCS service-account key (`GCS_PRIVATE_KEY`)** — was set on Vercel,
   transit only.
4. **Google TTS/STT service-account key (`GOOGLE_TTS_PRIVATE_KEY`)** — same.
5. **kie.ai (`KIE_API_KEY`)** — has been in `.env.local` since 3.1.
6. **ElevenLabs (`ELEVENLABS_API_KEY`)** — same.
7. **GitHub tokens (`GITHUB`, `GITHUB_TOKEN`)** — yoav-prog yt-studio /
   newturbovid read; the lorewire push token.
8. **Vercel team token (`VERCEL_TOKEN`)** — used for env + deploy automation.
9. **SESSION_SECRET** — rotate any time the admin app shows unusual sessions
   or after an upstream incident at jose / scrypt.
10. **ADMIN_PASSWORD** — rotate if you suspect someone has the value (in
    addition to the email).

## Per-secret rotation steps

### OPENAI_API_KEY

1. https://platform.openai.com/api-keys → **Revoke** the current key.
2. **Create new secret key** with name "lorewire-2026-06-11".
3. Update three places:
   - Local: `c:\Projects\lorewire-app\.env.local` line `OPENAI_API_KEY=...`
   - Vercel:
     ```
     TOKEN=$VERCEL_TOKEN PROJ=prj_ndWOojqxXdDhTQcQugJZkrkZKJri TEAM=team_Tk8KNIfJogqUh1LvlNOPPgKY
     ENVID=$(curl -sS -H "Authorization: Bearer $TOKEN" "https://api.vercel.com/v9/projects/$PROJ/env?teamId=$TEAM" | jq -r '.envs[] | select(.key=="OPENAI_API_KEY") | .id')
     curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
       "https://api.vercel.com/v9/projects/$PROJ/env/$ENVID?teamId=$TEAM" \
       -d '{"value":"sk-NEW-KEY","type":"encrypted","target":["production","preview","development"]}'
     ```
   - `/from-amir/redditscraperformsn 2 2.py` and any other helper scripts:
     scrub the hardcoded key or delete the file entirely. **Do NOT commit
     a fresh key into these scripts.**
4. Trigger a Vercel redeploy so the new value is bound to the runtime:
   ```
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "https://api.vercel.com/v13/deployments?teamId=$TEAM&forceNew=1" \
     -d '{"name":"lorewire","gitSource":{"type":"github","ref":"main","repoId":1265112899}}'
   ```
5. Verify: run `python -m pipeline.run --fixture` locally; confirm a real
   article rewrite. Old key is dead, new key works.

### DECODO_TOKEN

1. https://dashboard.decodo.com → API → revoke current token, generate new.
2. Same three-place update as OpenAI (local + Vercel + delete the old token
   from `/from-amir/*` scripts).
3. Verify: `python -m pipeline.run --subreddit AmItheAsshole --limit 1`
   should scrape successfully.

### GCS_PRIVATE_KEY (Cloud Storage service account)

1. GCP Console → IAM & Admin → Service Accounts → find the GCS account
   (whose email matches `GCS_CLIENT_EMAIL`).
2. Keys tab → **DELETE the old key** (note the key id first).
3. **Create key** → JSON → download the file. Open it and copy the
   `private_key` field value (the PEM with `\n` literals).
4. Update `.env.local` `GCS_PRIVATE_KEY=...` (one line, keep the `\n`
   literals — `pipeline/gcs.py` normalizes them at read time).
5. Update Vercel `GCS_PRIVATE_KEY` env var with the same value.
6. Verify: `python -c "from pipeline import gcs; print(gcs._access_token()[:10])"`
   should mint a token. A real upload via `python -m pipeline.run --fixture --media`
   confirms end to end.

### GOOGLE_TTS_PRIVATE_KEY (Cloud TTS + STT service account)

Same steps as GCS, but on the TTS service account (`GOOGLE_TTS_CLIENT_EMAIL`).
Verify with: `python -m pipeline.run --fixture --media` — voice synth runs.

### KIE_API_KEY

1. https://kie.ai dashboard → API Keys → revoke + create new.
2. Local + Vercel env update.
3. Verify: `python -m pipeline.run --fixture --media` — first image generates.

### ELEVENLABS_API_KEY

1. https://elevenlabs.io/app/settings/api-keys → revoke + create.
2. Local + Vercel.
3. Verify by switching the active voice to elevenlabs and rendering one story:
   `python -m pipeline.models set voice elevenlabs/default && python -m pipeline.run --fixture --media`.
4. Switch back: `python -m pipeline.models set voice google/chirp3-hd`.

### GITHUB + GITHUB_TOKEN

`GITHUB` (fine-grained PAT for yt-studio / newturbovid read-only) and
`GITHUB_TOKEN` (yoav-prog token for pushing the lorewire repo) rotate
independently.

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens
   (classic) or Fine-grained → revoke each.
2. Create replacements with the **same scopes**:
   - `GITHUB`: repo:read on `aporia2026/youtubestudio`, `aporia2026/newturbovid`.
   - `GITHUB_TOKEN`: repo (push) on `yoav-prog/lorewire`.
3. Update `.env.local`. (Vercel doesn't need these — they're local-only.)
4. Verify by re-cloning yt-studio with the new `GITHUB` token, and a real
   `git push` with the new `GITHUB_TOKEN`.

### VERCEL_TOKEN

1. https://vercel.com/account/tokens → revoke current.
2. Create new with scope `lore-wire` team.
3. Update `.env.local` only (Vercel doesn't store its own token).
4. Verify: `curl -H "Authorization: Bearer $NEW_TOKEN" https://api.vercel.com/v9/projects?limit=1` returns the lorewire project.

### SESSION_SECRET

1. Generate: `python -c "import secrets; print(secrets.token_hex(32))"`.
2. Update on Vercel only (no local copy needed for the pipeline).
3. **Side effect**: every existing admin session is invalidated. The next
   `/admin` access redirects to `/admin/login`.

### ADMIN_PASSWORD

1. Generate a new strong password (you pick, or
   `python -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(22)))"`).
2. Update on Vercel.
3. The existing seeded admin row in the `users` table still has the OLD
   scrypt-hashed password. To roll the password into the DB:
   - Option A (simplest): log into `/admin` once with the old password,
     change the password through the (future) settings page — TODO, not
     built yet.
   - Option B (today): truncate the `users` row in Postgres so
     `ensureSeedAdmin()` re-seeds on the next login attempt:
     ```sql
     DELETE FROM users WHERE email = 'yoav.mizrahi@aporianetworks.com';
     ```
     The next login attempt re-seeds from the new env var.

### DATABASE_URL

You generally don't rotate this — it's wired by the Vercel Marketplace Neon
integration and pinned to a specific Neon project. If you ever DO need to
rotate (suspected credential leak):

1. Vercel dashboard → Storage → your Neon database → Settings → **Reset
   password** (this changes the connection-string password).
2. Vercel auto-updates the env var.
3. Pull the new value locally: same fetch-by-id pattern in §"Pull the new
   DATABASE_URL locally" below.

## How to pull a new env value locally after rotation

Same trick `pipeline/store.py` uses for the initial Neon hookup:

```bash
TOKEN=$VERCEL_TOKEN
TEAM=team_Tk8KNIfJogqUh1LvlNOPPgKY
PROJ=prj_ndWOojqxXdDhTQcQugJZkrkZKJri
KEY=DATABASE_URL    # or any rotated key

ENVID=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v9/projects/$PROJ/env?teamId=$TEAM" \
  | python -c "import json,sys;d=json.load(sys.stdin);[print(e['id']) for e in d['envs'] if e['key']=='$KEY']")

curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v1/projects/$PROJ/env/$ENVID?teamId=$TEAM" \
  | python -c "import json,sys;print(json.load(sys.stdin)['value'])"
```

## What NOT to do

- Don't commit any rotated value into git — even temporarily. Vercel env is
  the source of truth; `.env.local` is gitignored locally only.
- Don't put rotated values into chat conversations (including with me).
- Don't reuse the OLD `SESSION_SECRET` after a rotation; every issued
  cookie must die at rotation time.
- Don't delete the OLD service account JSON file from your local disk
  *before* the new key is verified working. Keep both for 24 hours, then
  destroy the old.

## Post-rotation verification checklist

- [ ] `python -m pipeline.run --fixture` succeeds (OpenAI key works).
- [ ] `python -m pipeline.run --fixture --media` succeeds (kie + Google
      TTS + STT + GCS upload all work).
- [ ] `python -m pipeline.video <id>` succeeds (Remotion + GCS upload).
- [ ] `python -m pipeline.export_app` writes a non-empty `published.ts`.
- [ ] Vercel triggered deploy is `READY` at the latest main SHA.
- [ ] `curl https://www.lorewire.com/` returns 200 with the envelope
      story's GCS URLs in the HTML.
- [ ] `curl https://www.lorewire.com/admin` redirects to `/admin/login`
      with 307.
- [ ] `/admin/login` accepts the new ADMIN_EMAIL + ADMIN_PASSWORD pair.
