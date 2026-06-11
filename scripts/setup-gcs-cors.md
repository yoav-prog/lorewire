# GCS bucket CORS for the intro/outro upload flow

The admin upload form (`/admin/segments`) PUTs video bytes directly from the
browser to `storage.googleapis.com` — bypassing Vercel's 4.5 MB function
body cap. For that cross-origin PUT to succeed, the bucket must accept
`PUT` (and the preflight `OPTIONS`) from our admin origins.

## One-time setup

Requires `gcloud` / `gsutil` installed and authenticated as a user with
`Storage Admin` on the bucket.

```bash
# Replace with your actual bucket name (matches GCS_BUCKET in Vercel env).
BUCKET="your-bucket-name"

gcloud storage buckets update "gs://${BUCKET}" \
  --cors-file=scripts/setup-gcs-cors.json
```

Or with the older `gsutil` CLI (still works):

```bash
gsutil cors set scripts/setup-gcs-cors.json gs://${BUCKET}
```

## Verify

```bash
gcloud storage buckets describe "gs://${BUCKET}" --format="value(cors_config)"
```

Should print the JSON contents of `setup-gcs-cors.json` (one rule).

## What the rule allows

- `origin`: production (`lorewire.com`), every Vercel preview deployment
  (`*.vercel.app`), and local dev (`localhost:3000`). Add more if you serve
  the admin from another host.
- `method`: `GET` for previews, `PUT` + `OPTIONS` for the upload, `POST`
  reserved for a future direct-form-data path.
- `responseHeader`: the headers the browser needs to read on the PUT
  response. `Range` is critical — chunked uploads use it to discover what
  the server persisted.
- `maxAgeSeconds`: 3600 = preflight cached for an hour per (origin, path)
  pair, so a 25-chunk upload only triggers one preflight.

## When to re-run

- The admin moves to a new origin (e.g., custom subdomain).
- You add a new browser-uploaded asset type (audio, images) — and want the
  same bucket to accept it from a new path. Today the path is implicit; the
  CORS rule is bucket-wide.

## Why this lives in scripts/ rather than being run by the app

The bucket-level CORS config is provisioning, not runtime — running it on
every admin page load would burn an API call per request for no reason and
require a wider service-account scope than the app needs day to day.
Provisioning by hand keeps the production app's GCS credential strictly to
read-write-object scope.
