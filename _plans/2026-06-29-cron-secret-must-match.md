# CRON_SECRET must match across Vercel + Cloud Run + pipeline (2026-06-29)

The render service (Cloud Run `lorewire-render`) authenticates every
incoming `/render`, `/render-poster`, `/probe-mp4` call against
`CRON_SECRET`. The Vercel app (and the Python pipeline) sign those calls
with their own `CRON_SECRET`. If the values diverge, Cloud Run returns
`401 unauthorized` and **all** renders + posters silently fail.

## 2026-06-29 incident

Cloud Run's `CRON_SECRET` was rotated to a new value, but Vercel still
held the old one. Every Vercel to Cloud Run call 401'd — video renders,
Phase 2 social posters, and Phase 3a OG posters all failed silently.

Symptom in Vercel logs:

```
[og poster render_failed] {... "http_status":401, "reason":"{\"error\":\"unauthorized\"}"}
```

and zero poster POSTs reaching Cloud Run before the rotation was
finished. The OG-poster backfill returned `helper_returned_null` for
every story.

## Rule

`CRON_SECRET` is a three-place secret: **Vercel env, Cloud Run env, and
the pipeline `.env`.** Rotating it means changing all three and
redeploying each. Never rotate one in isolation.

## Related

The OG/social poster text guard previously rejected all-caps copy
(`all_caps_shock`). It was removed because the poster compositions
uppercase the text for display anyway, so the guard blocked legitimate
all-caps house-style hooks for zero visual difference. That fix peeled
back the first failure layer and exposed the 401 above.
