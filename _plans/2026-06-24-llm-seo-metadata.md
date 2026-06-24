# LLM-generated per-platform SEO metadata for shorts

Date: 2026-06-24
Branch: `feat/youtube-and-tiktok-auto-publish` (deploying onto `feat/multi-platform-shorts-publisher`)
Status: APPROVED — implementation in progress
Model: `kie/gemini-3-5-flash` via existing `lib/llm.ts`

## Goal

Auto-generate per-platform SEO metadata (titles, descriptions, captions,
hashtags, tags) for every rendered short based on the short's own
content (narration script + title + category), and use that metadata
when publishing to Facebook, Instagram, YouTube, and TikTok instead of
the template-rendered defaults.

This is the Phase 2 deferred from the original YT+TT auto-publish PR.
The Phase 1 templates remain as the fallback when SEO metadata is
absent or stale — fully backwards compatible.

## Why

The current publisher metadata is partially dynamic (hook + title +
article_url + category come from the per-story LLM that already runs
in the pipeline) but the framing copy and hashtags are templated. Two
Drama shorts about wholly different stories get the same hashtags and
the same boilerplate description. The hook is strong; everything
around it is generic.

LLM-generated per-platform metadata makes every short's discovery
surface match the story content. Bigger SEO surface area, better
algorithm signal, more views per render.

## Constraints + decisions

| Decision | Pick | Why |
|---|---|---|
| Model | `kie/gemini-3-5-flash` via existing `lib/llm.ts` | Cheap, fast, structured output supported in the existing client wrapper. Per rule 17 (no provider loyalty), Gemini Flash family is the cheapest-quality for short structured-output tasks at every published price list. |
| Provider routing | OpenAI-compatible chat completions at `api.kie.ai/v1/chat/completions` (existing wrapper) | The other `kie/gemini-*` ids in the registry already route through this endpoint successfully. If kie returns 404 for `gemini-3-5-flash`, I'll add a streamGenerateContent fallback path. |
| Structured output | `response_format: { type: "json_schema", strict: true }` | Already supported in `lib/llm.ts` via the `jsonSchema` option. Strict mode forces the model to match the schema, removes prompt-engineered JSON parsing risk. |
| LLM input | (c) per Yoav: narration script (teleprompter) + title + category | Narration is what viewers actually hear. Metadata that matches narration is more accurate for retention than metadata that summarises the article. |
| Generation trigger | Inline in render_short route, AFTER render success, BEFORE publishers fire. Best-effort: a failure logs and falls through to templates. | Single hot path. Idempotent (skips if already generated and teleprompter unchanged). |
| Persistence | New `stories.seo_metadata_json` TEXT column + `stories.seo_metadata_generated_at` TEXT timestamp | One row per story, four platforms inside one JSON blob. Editable in admin. |
| Editability | New "SEO" tab on `/admin/shorts/[id]` shows each platform's metadata with edit textareas + "Regenerate from narration" button | Admin can tweak before publishing or override entirely. |
| Backwards compatibility | Each publisher's resolution chain: per-publish override → `story.seo_metadata.{platform}` → settings template → DEFAULT_*_TEMPLATE | No breaking change. If metadata is missing, behavior is identical to today. |

## Scope

In scope:
- New `lib/seo-metadata.ts` module (prompt builder, kie call, Zod validation, persistence)
- Schema additions on stories
- `kie/gemini-3-5-flash` in models registry
- Pipeline-side trigger from render_short route
- Resolution-chain update in all four publish modules
- Admin "SEO" tab on the short editor
- One settings toggle (auto-regenerate vs manual-only)
- Tests

Out of scope:
- Image / thumbnail SEO (separate concern)
- Cross-language SEO (English only for now, matching the rest of the pipeline)
- A/B testing two metadata versions per story
- Per-platform regeneration (one regenerate button regenerates all four)

## Schema

```sql
ALTER TABLE stories ADD COLUMN seo_metadata_json TEXT;
ALTER TABLE stories ADD COLUMN seo_metadata_generated_at TEXT;
```

`seo_metadata_json` shape (validated via Zod):

```json
{
  "youtube": {
    "title": "string ≤100 chars",
    "description": "string ≤5000 chars",
    "tags": ["string", "..."]  // 5-8 entries
  },
  "tiktok": {
    "caption": "string ≤2200 chars"  // includes inline hashtags
  },
  "facebook": {
    "caption": "string"
  },
  "instagram": {
    "caption": "string ≤2200 chars"
  }
}
```

## Model registry addition

`config/models.json` + `lorewire-app/src/data/models.json`:

```json
{
  "id": "kie/gemini-3-5-flash",
  "label": "Gemini 3.5 Flash (kie.ai)",
  "provider": "kie",
  "cost": "cheap",
  "wired": true
}
```

No new model selector slot. The publishers read `publisher.seo.kie_model`
settings key (default `kie/gemini-3-5-flash`) directly so admin can
swap without code change.

## Prompt design

One LLM call per story, one JSON object covering all four platforms.

System prompt embeds the per-platform SEO rules from the original plan
(YouTube: 4-6 word title, 150-200 word description, 5-8 tags; TikTok:
150-300 char caption with 3-5 hashtags; FB/IG: hook-first captions
with article link).

User prompt is a JSON-ish block:
```
Story title: {title}
Category: {category}
Narration script:
"""
{teleprompter}
"""
Article URL: {article_url}
Brand voice: hand-drawn one-minute internet stories. Hook-first.
LoreWire's tone is curious and direct, not sensational.
```

Strict JSON output enforced by `response_format`. Temperature 0.7 for
some creative variation (high enough to differentiate two similar
stories' metadata; low enough that the same input yields stable output
across re-runs).

## Generation pipeline

`lib/seo-metadata.ts` exports:

```ts
export async function generateSeoMetadata(args: {
  storyId: string;
  title: string;
  category: string;
  teleprompter: string;
  articleUrl: string;
}): Promise<{ ok: true; metadata: SeoMetadata } | { ok: false; error: string }>;

export async function loadSeoMetadata(storyId: string): Promise<SeoMetadata | null>;
export async function saveSeoMetadata(storyId: string, m: SeoMetadata): Promise<void>;

export function isStaleForTeleprompter(
  generatedAt: string | null,
  teleprompterUpdatedAt: string,
): boolean;
```

`generateSeoMetadata` calls `kie/gemini-3-5-flash` via `lib/llm.ts`
with the `jsonSchema` option. Returns parsed + Zod-validated metadata.
Logs every step namespaced `[seo_metadata]`.

## Render route integration

Inside `/api/render_short/route.ts`, between render success and the
existing FB/IG/YT/TT publisher fan-out:

```ts
await ensureSeoMetadataForStory(story).catch((err) => {
  namespacedLog("seo_metadata_unhandled", { story_id, err: String(err) });
});
// then publishers fire as before
```

`ensureSeoMetadataForStory` is a best-effort wrapper:
- skip if `story.seo_metadata_generated_at` is fresh enough and teleprompter hasn't changed
- otherwise generate + save
- on failure, log and return — publishers fall through to templates

A failure in SEO metadata generation NEVER blocks publishing. The
publishers' resolution chains handle missing metadata gracefully.

## Publisher resolution chain update

Each publisher's metadata resolution becomes:

```
1. args.{titleOverride, captionOverride, ...} (per-publish admin override)
2. story.seo_metadata.{platform}.{field}
3. settings template
4. DEFAULT_*_TEMPLATE constant from the publish module
```

Concretely:
- `publish-to-youtube.ts`: read `seo_metadata.youtube.{title, description, tags}` if present.
- `publish-to-tiktok.ts`: read `seo_metadata.tiktok.caption` if present.
- `publish-to-facebook.ts`: read `seo_metadata.facebook.caption` if present.
- `publish-to-instagram.ts`: read `seo_metadata.instagram.caption` if present.

Each publisher fetches the story row inside its existing logic and
falls through cleanly.

## Admin UI: SEO tab

New tab on `/admin/shorts/[id]` between Voice and the publish buttons:

```
SEO
├── Status: ✓ Generated 5 min ago / ✗ Not generated / ⚠ Stale (regenerate)
├── [Regenerate from narration] button
├── YouTube
│   ├── Title (editable, ≤100 chars)
│   ├── Description (editable, ≤5000 chars)
│   └── Tags (comma-separated, 5-8 entries)
├── TikTok
│   └── Caption (editable, ≤2200 chars)
├── Facebook
│   └── Caption (editable)
└── Instagram
    └── Caption (editable, ≤2200 chars)
```

Same autosave + AutoSaveStatus pattern as the rest of the admin (no
Save buttons, debounced inline save).

Regenerate button calls a server action that runs `generateSeoMetadata`
and replaces the metadata JSON on the story.

## Settings keys

```
publisher.seo.auto_regenerate_on_render  ("0"/"1", default "1")
publisher.seo.kie_model                  (default "kie/gemini-3-5-flash")
```

Add to Settings → Models tab (or to Socials — TBD during impl, will go
where it makes more sense).

## Security (rule 13)

- `KIE_API_KEY` already env-only, never DB, never logs. No new credential.
- The LLM call sends the story body (title + teleprompter + category) to
  kie.ai. The story body is already user-published content; this is the
  same data sent for image generation today. No new data flow concern.
- No PII in the prompt.
- Metadata JSON is admin-editable but has no privileged side effects —
  worst case an admin types something offensive and it gets published.
  Standard content moderation responsibility, not a new risk.

## Observability (rule 14)

Logs namespaced `[seo_metadata <event>]`:
- `generate_start` — story_id, model, input_chars, has_existing_metadata
- `kie_call_ok` / `kie_call_failed` — story_id, model, latency_ms, response_chars, credits_consumed (if surfaced)
- `parse_failed` — story_id, raw_first_300_chars (truncated)
- `validation_failed` — story_id, zod_errors_first_3
- `save_ok` — story_id, generated_at
- `skip_fresh` — story_id, generated_at, teleprompter_unchanged

Publishers gain one new log event each:
- `[publish youtube source]` `{ story_id, source: "seo_metadata" | "template" | "override" }`
- Same for the other three publishers.

So when investigating a published short, you can grep one query to see
exactly where the title/description/caption came from.

## Settings audit (rule 15)

Two settings introduced:
- `publisher.seo.auto_regenerate_on_render` — defaults to ON. Power
  users may want to lock metadata after a manual edit so re-renders
  don't overwrite their tweaks. Lives in Settings → Socials → SEO group.
- `publisher.seo.kie_model` — defaults to `kie/gemini-3-5-flash`. Lets
  admin swap to a stronger or cheaper model. Lives in Settings → Models.

No other user-visible knobs. The per-platform metadata is editable at
the per-short level via the SEO tab.

## Testing (rule 18)

Unit:
- Prompt builder: shapes the system + user prompts correctly for each
  story state (full / empty teleprompter / missing category).
- Zod schema rejects malformed LLM output.
- `isStaleForTeleprompter` returns true when teleprompter has been
  updated after `generated_at`.
- Resolution-chain wins in priority order (override > seo > template).

Integration (stubbed kie fetch):
- Happy path: generate → persist → publisher reads.
- LLM returns malformed JSON: caught by Zod, logged, falls through.
- LLM returns 4xx/5xx: logged, falls through.
- Fresh metadata + unchanged teleprompter: skip regeneration.

Manual smoke:
- Trigger one short render, watch logs for `[seo_metadata generate_start]`
  → `[seo_metadata save_ok]` → `[publish youtube source] source=seo_metadata`.
- Click "Regenerate" on the SEO tab, verify new metadata appears.
- Edit metadata in the SEO tab, watch autosave fire, then publish and
  verify the edited version landed on the platform.

## Cost (rule 8)

kie.ai's published docs for `gemini-3-5-flash` only expose
`credits_consumed: 0.01` per example call. No public per-token pricing
on the docs/billing pages I could reach. Need to confirm in the kie.ai
dashboard.

Expected per-story cost (back-of-envelope):
- Input: ~500-1500 tokens (title + 1-3 min narration)
- Output: ~600-1000 tokens (four platforms of metadata)
- Total: ~1500-2500 tokens
- Gemini 3.5 Flash family pricing at any provider: ≪ $0.01 per call
- LoreWire scale: 1k shorts/month = max $10/month, likely $1-3/month

No new infra. No new subscription. Cost is a rounding error vs the
~$0.70/short pipeline cost.

## Backwards compatibility

If `seo_metadata_json` is NULL or any platform's slot is missing, the
publisher falls through to the existing settings template, which falls
through to the DEFAULT_*_TEMPLATE constant. Same behavior as today.

If kie.ai is down or returns errors, generation skips silently and
the templates apply. Publishing is never blocked.

The new `seo_metadata_json` column is additive (nullable). The schema
migration runs cleanly on existing rows. No data backfill required.

## Open items

1. Verify kie.ai's billing dashboard shows actual $/credit rate after
   first few calls so the cost line in this plan reflects reality.
2. If `kie/gemini-3-5-flash` returns 404 from the chat completions
   endpoint, implement the streamGenerateContent fallback path in
   `lib/llm.ts`. Will only know on first call.

## Phased rollout

1. Land this PR with the toggle defaulting to ON.
2. After deploy, manually trigger one regeneration via the SEO tab on
   a recently-rendered short. Verify the metadata is sensible.
3. Render one new short end-to-end; verify it auto-generates metadata,
   the SEO tab reflects it, and the publishers pick it up on auto-publish.
4. Watch the logs for parse/validation failures over the first 10
   shorts. If rate > 0%, tighten the prompt or schema.
5. If cost-per-story comes in higher than expected on the kie.ai
   dashboard, swap to `kie/gemini-3-pro` via the settings model picker.

## Verification sources

- kie.ai Gemini 3.5 Flash docs:
  https://docs.kie.ai/market/gemini/gemini-3-5-flash
- Existing `lib/llm.ts` (structured-output supported via `jsonSchema` option)
- Existing model registry `lorewire-app/src/data/models.json`
