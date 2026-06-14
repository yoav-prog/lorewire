# Remotion Lambda — one-time AWS setup

Run these commands in order, on your local machine, with the AWS account
that should host the Lambda function. Each step is ~30 seconds. Total
~10 minutes including the AWS console clicks.

Phase 1 of [_plans/2026-06-14-remotion-lambda-render.md](../_plans/2026-06-14-remotion-lambda-render.md).

## 1. Get the IAM user policy JSON

Run from this directory (`lorewire-app/video/`):

```powershell
npm run lambda:policies-user
```

Copy the printed JSON. In the AWS console:

1. IAM → Users → **Create user** → name it `remotion-lambda-user`
2. Skip "Add user to group"
3. Permissions options → **Attach policies directly** → **Create policy**
4. JSON tab → paste the JSON from above → Next → name it
   `remotion-lambda-user-policy` → Create
5. Back on the Create User screen, attach `remotion-lambda-user-policy`
6. Finish creating the user
7. Open the new user → **Security credentials** → **Create access key**
   → choose "Command Line Interface (CLI)" → Next → Create
8. Copy both the **Access key ID** and **Secret access key** somewhere
   safe — the secret is shown ONCE.

## 2. Get the Lambda role policy JSON

```powershell
npm run lambda:policies-role
```

Copy the printed JSON. In the AWS console:

1. IAM → Roles → **Create role** → AWS service → **Lambda** → Next
2. Skip the "Add permissions" page for now → Next → name it
   `remotion-lambda-role` → Create role
3. Open the new role → **Add permissions** → **Create inline policy**
4. JSON tab → paste the JSON from above → Next → name it
   `remotion-lambda-role-policy` → Create policy

## 3. Export the user keys to your shell

```powershell
$env:REMOTION_AWS_ACCESS_KEY_ID = "<paste access key id>"
$env:REMOTION_AWS_SECRET_ACCESS_KEY = "<paste secret access key>"
```

## 4. Deploy the Lambda function

```powershell
npm run lambda:deploy-function
```

This creates `remotion-render-<hash>` in us-east-1 with 2 GB memory,
240 s timeout, 2 GB ephemeral disk. Takes ~30 seconds. **Copy the
printed `functionName`** — you'll need it in step 6.

## 5. Deploy the composition bundle to S3

```powershell
npm run lambda:deploy-site
```

This builds your composition (everything under `src/`) and uploads it
to `remotionlambda-<region>-<hash>/sites/lorewire/`. Takes ~60 seconds
the first time. **Copy the printed `serveUrl`** (a https URL) — you'll
need it in step 6.

Re-run this command any time you change a file under `video/src/`.

## 6. Set the four env vars in Vercel

Go to Vercel → your project → Settings → Environment Variables. Add
each of these for **Production + Preview**:

| Key | Value |
|---|---|
| `REMOTION_AWS_ACCESS_KEY_ID` | the access key from step 1 |
| `REMOTION_AWS_SECRET_ACCESS_KEY` | the secret from step 1 |
| `REMOTION_AWS_REGION` | `us-east-1` |
| `REMOTION_LAMBDA_FUNCTION_NAME` | from step 4's printed `functionName` |
| `REMOTION_LAMBDA_SERVE_URL` | from step 5's printed `serveUrl` |

## 7. Sanity check

```powershell
npm run lambda:list-functions
```

Should print the function you deployed in step 4. If you see it, you
are done with one-time setup.

## After this, Phase 2+ wires the app code

Phases 2–5 (schema additions, Vercel cron endpoints, drain) ship in
separate PRs and don't need you to re-do anything in AWS. The single
function + single site you deployed handle every render forever.

## Re-deploying after composition changes

You only need to re-run **step 5** (`lambda:deploy-site`) when you
change anything under `video/src/`. The function from step 4 stays the
same until you upgrade Remotion itself.

## Cost reminder

Each render: ~$0.003 of Lambda compute + ~$0.001 of S3. AWS free tier
covers the first ~400k seconds of Lambda compute / month, which is
~6,000 renders. You will not see a bill at LoreWire's current volume.
