# Video editor overhaul: per-frame images, prompts, regen, robust preview

**Status:** revised after LLM Council pass — awaiting approval to code
**Author:** Claude (with Yoav)
**Date:** 2026-06-12
**Supersedes:** the per-frame UI bits of `_plans/2026-06-11-video-editor.md` (trim/captions/audio/metadata stay as built)

---

## 1. Goals

Make `/admin/videos/[id]` feel like a real video editor instead of a Trim panel with a black canvas.

What the user actually needs to do here:
1. See every frame's **image** (not a filename).
2. See every frame's **prompt** (what the image model was told).
3. **Re-render any frame's image**, optionally after editing its prompt.
4. **Undo** a regen they don't like.
5. See a **live video preview** that reflects edits and never goes black.

Out of scope (v1): overlays editor (still stubbed), multi-track audio, mouth-swap UI, intro/outro override UI, batch prompt ops, versioning history beyond last-1, frame-to-frame consistency locks, render-time prompt overlays for SEO/social. All of these can land later on top of the v1 foundation.

## 2. Constraints

- This is "NOT the Next.js you know" (per `lorewire-app/AGENTS.md`). Before writing route/server-action code, read `node_modules/next/dist/docs/` for the relevant primitives.
- Existing schema and pipeline patterns must be respected — no parallel data layer. The `IMAGE_RENDERS` table + `regen_one()` worker is the canonical regen pipeline.
- Local SQLite + prod Postgres parity. JSON-blob shape changes are mirrored in `pipeline/store.py`.
- Tab UX must not regress (TRIM / CAPTIONS / STYLE / AUDIO / OVERLAYS / METADATA stay where they are).
- Edit session locking (`claimEditSession` / `heartbeatEditSession`) already exists for the editor — frame regen must coexist with it cleanly.
- All cost-bearing actions get flagged in the UI before they fire (CLAUDE.md rule 8). Pricing for the active image model is checked online before shipping.

## 3. Requirements

Per frame:
- Square thumbnail (the frame's current image).
- Visible prompt, editable.
- **Revert** button (snapshot of previous URL + prompt, restored in one click).
- Regenerate button with inline cost label.
- Queued / generating / **error** / done status — error state must be explicit, not just "not done".

Editor header:
- **Running session spend** ("$0.12 this session") always visible while the editor is open.
- **Stale-render badge** when any frame's `url` has changed since the last MP4 render.

Center preview:
- Mounts reliably. If the Player runtime is loading, show a clear loading state. If image URLs are missing, show a labeled diagnostic empty state with the story id. **Never a black void.**

## 4. Approach (revised after council pass)

End-to-end, in this order. Each phase is independently shippable.

### Phase 0 — Black-canvas root cause (was Phase 6)
**Ship alone before any feature work.** Open `/admin/videos/[id]` with the story from the user's screenshot. Devtools open. Find the actual cause. Candidates, top down:
1. `previewFrameUrls` resolves empty for this story (server-side path mismatch).
2. `@remotion/player` dynamic import fails silently (the `loading:` fallback never replaces).
3. An ancestor wrapper has `bg-black` or similar masking a sized-zero Player.
4. `inputProps` shape drifted vs. `PreviewComposition`'s expected props after recent schema edits.
5. CORS / signed-URL 403 on the frame asset URLs.

Whatever it is, fix root cause. Add a regression test (Vitest + DOM assertions, or Playwright if already wired) that asserts the center area always renders Player OR labeled empty state — never just darkness. Add `[video editor preview] mounted` / `[video editor preview] empty` / `[video editor preview] player_error` logs (rule 14).

Acceptance: the user opens the editor and sees something legible in the center on every story, including stories with zero frames.

### Phase 1 — Read-only frame cards
Replace the left rail's text-only list with vertical frame cards:
- Thumbnail from `previewFrameUrls[idx]`.
- Frame index + caption snippet.
- Filename (smaller).
- **Prompt slot is deferred to Phase 2.** Investigation 2026-06-12 found
  prompts are never persisted anywhere — `make_image_prompts` runs at
  pipeline time and only the `prompt_hash` is written (to
  `IMAGE_RENDERS.prompt_hash`). The actual prompt text isn't on the
  story, the scene, or the render row. So "derive from source story
  scene" doesn't work and showing a placeholder under every card now
  would just be UI debt. Phase 2 adds `image_prompt` to `DoodleFrame`
  and either backfills via a one-shot pipeline pass or fills the slot
  on first regen.

Phase 1 ships: thumbnails + caption + filename. One of the user's three
top complaints ("see every frame's image") goes away in a small PR
with zero data-model risk.

### Phase 2 — Schema with stable IDs + Zod boundary
- Add `id: string` to `DoodleFrame` (UUID, stable across edits) in `lib/schema.ts` + `lib/video-config.ts` Zod schema.
- Add `image_prompt?: string` and `prev_image?: { url: string; image_prompt: string; replaced_at: string }` to `DoodleFrame`. Single-step history (last-1) is enough for Revert; deeper history is out of scope for v1.
- **Strict Zod parser at the read boundary.** Every read of `stories.video_config` goes through one parser that fails closed on shape drift and writes a `[video-config parse] failed` log. No more silent ghost fields.
- Backfill: on first read of an old config, mint stable `id`s in-memory and lazy-write on next save. No data migration; the parser handles missing-id gracefully.
- Mirror parser in `pipeline/store.py` so the pipeline can't write a config the editor refuses.

### Phase 3 — Regen end-to-end on one frame
Wire the full pipeline for `frame:<frameId>` using the stable ID, not an index. Index-based slugs are race-fragile (insert/delete shifts every ID).

- Pipeline: extend `pipeline/media.py::regen_one()` with `frame:<id>` handler mirroring `_regen_one_scene`. Prompt source: `doodle_frames[i].image_prompt`; if absent, fall back to the matching story scene prompt with a `[regen frame] prompt_fallback` warning.
- Server action `queueFrameImageRegen(storyId, frameId, newPrompt?)`:
  - Validates the edit session lock.
  - **Idempotency key** = `sha256(frameId + prompt_hash)`. The `IMAGE_RENDERS` queue de-dupes on this key for in-flight rows so double-click + retry never double-charges.
  - Before write: snapshot `{ url, image_prompt }` into `prev_image` so Revert always works.
  - On success: update `doodle_frames[i].url`, `.image_prompt`, set `prev_image` to the pre-regen snapshot.
  - Rate-limit per admin (default 60/min, server enforced).
- Revert action `revertFrameImage(storyId, frameId)`: restore `prev_image` into the live fields and clear `prev_image`. No model call; free.

Prove the loop on **frame 0 only** before generalizing. Once it works for one, it's a `forEach` away from working for all.

### Phase 4 — Generalize + cost controls + stale-render badge
- Apply Phase 3 to every frame card.
- Editor header: running session spend ("$0.12 this session"), refreshed live as queue rows complete.
- Editor header: **stale-render badge** when any `doodle_frames[i].url` has changed since the last `video_renders` row for this story. Click → "Re-render video" CTA (uses existing `queueRender` action).
- **Confirm on bulk** modal: if a user clicks Regenerate on more than N frames in M seconds (configurable cap, default `bulk_confirm_threshold = 3`), show one confirm modal with total estimated cost before any fire.
- **Hard per-session cap**: server-enforced. Default `frame_regen_session_cap_cents = 500`. Once hit, server rejects with a clear error, UI surfaces "Session spend cap reached. Lift cap in Settings or wait."
- **Error UX per card**: failed regen shows the error class + a Retry button + a "Copy diagnostics" link.

### Phase 5 — Live updates by polling
- 2-second polling of `latestRenderForAsset('story', storyId, 'frame:<id>')` for any in-flight regen — reuse the GranularRegenGrid pattern.
- On completion, merge new URL into the memoised `livePreviewConfig` so the Player swaps without a page reload.
- Optimistic UI: "Regenerating…" overlay on the thumbnail the moment the queue accepts the job.
- During pending: preview shows the OLD frame until completion (not loading, not new) and the Player overlay says "Frame 3 regenerating…". Decided explicitly per Outsider's review.

No SSE / websocket. 2s polling on jobs that take 20s+ is fine.

## 5. Rejected alternatives

- **Original 6-phase order (Phase 6 = canvas fix).** Rejected by 4/5 council advisors. If the canvas stays black, every other phase is decorating a broken preview.
- **Index-based `frame:N` slug.** Rejected: insert/delete renumbers every frame, so an in-flight regen for frame 4 could land on what is now frame 5. Stable `frame:<id>` is correct.
- **`video_shots` table (First Principles).** Rejected for v1: real schema entity is more correct over months but adds a SQLite + Postgres migration and a join on every editor load. We keep the JSON blob with stable IDs + a strict parser. Revisit if concurrent-edit volume actually forces the issue.
- **Expansionist's scope (batch ops, versioning, consistency locks, render-time overlays).** Rejected for v1. Three reviewers flagged this as the biggest blind spot in the original plan — gold-plating on a foundation that hadn't been built yet. All of it remains possible on top of the Phase 2 schema later.
- **SSE / websocket for live status.** Rejected: 2s polling on 20s+ jobs is cheap and reliable; SSE adds infra surface for no user-visible win.
- **Five settings toggles.** Rejected. Three of them are infrastructure that should never be a user knob (rate limit, diagnostics, confirm-before-first). One is a View preference (thumbnail size) that doesn't need shipping in v1. Cost-inline default-on. Only the per-session hard cap stays as a Settings entry.

## 6. Security (rule 13)

- **Prompt injection / abuse:** server-side length cap (2000 chars), reject control characters, log the prompt hash not the prompt body to the queue (matches `IMAGE_RENDERS.prompt_hash`).
- **Authorization:** every regen action requires a valid edit session for this story. Two admins regenerating the same frame race-safe via the idempotency key.
- **Cost authorization at org level, not just session:** beyond `frame_regen_session_cap_cents`, add `frame_regen_daily_cap_cents_per_admin` (default `2000`) enforced server-side. 80% warning surfaces in the editor header. Caps are checked before the queue insert, not after.
- **Audit:** every regen logs `[video editor regen] queued` server-side with `{ story_id, frame_id, admin_email, prompt_hash, est_cents, idempotency_key }`. Append-only audit channel.
- **No secrets in client bundles** — image model API keys stay server-side.
- **Stale-lock recovery:** if `claimEditSession` is stale > `STALE_SESSION_MS`, regen action rejects with "Edit session expired — refresh" and does not queue. Prevents two-tab same-admin races from charging twice.

## 7. Observability (rule 14)

Client (`console.info`):
- `[video editor preview] mounted` — `{ story_id, frame_count, preview_url_count }`
- `[video editor preview] empty` — `{ story_id, reason }`
- `[video editor preview] player_error` — `{ story_id, message }`
- `[video editor frame] selected` — `{ story_id, frame_id, has_prompt }`
- `[video editor frame] prompt edited` — `{ story_id, frame_id, prompt_len }`
- `[video editor regen] click` — `{ story_id, frame_id, prompt_edited, bulk_count }`
- `[video editor regen] enqueued` — `{ story_id, frame_id, render_id, est_cents }`
- `[video editor regen] status` — `{ story_id, frame_id, status }` (each poll transition)
- `[video editor regen] completed` — `{ story_id, frame_id, new_url, cents }`
- `[video editor regen] failed` — `{ story_id, frame_id, error_class }`
- `[video editor revert] click` — `{ story_id, frame_id }`
- `[video editor stale] visible` — `{ story_id, stale_frame_count }`
- `[video editor spend] tick` — `{ story_id, session_cents, daily_cents }` (every queue completion)

Server (Python):
- `[regen frame] start` — `story_id, frame_id, prompt_hash, idempotency_key`
- `[regen frame] prompt_fallback` — `story_id, frame_id`
- `[regen frame] done` — `story_id, frame_id, cents, ms`
- `[regen frame] failed` — `story_id, frame_id, error_class, message`
- `[video-config parse] failed` — `story_id, error, raw_keys`

Server (Next):
- `[video editor regen] action invoked` — `{ story_id, frame_id, admin_email, prompt_edited }`
- `[video editor regen] rejected` — `{ story_id, frame_id, reason: 'session_expired' | 'session_cap' | 'daily_cap' | 'rate_limit' | 'idempotency_dedup' }`
- `[video editor revert] action invoked` — `{ story_id, frame_id, admin_email }`

## 8. Settings (rule 15)

Add **one** entry under `Settings → Video editor`:
- `video.editor.frame_regen.session_cap_cents` — integer, default `500`. Hard cap per editor session. Server-enforced.

Intentionally **not** exposed (council called the original 5 toggles cognitive overload):
- Confirm-before-first-regen — hardcode: confirm on bulk (≥3 frames in 5s).
- Rate limit — infrastructure, not a user knob.
- Cost inline — always on.
- Preview diagnostics — always on; "labeled empty state" is the default behavior of the new component, no toggle.
- Thumbnail size — fixed for v1; revisit if anyone asks.

## 9. Testing (rule 18)

Unit:
- `lib/video-config.test.ts` — `id` and `image_prompt` and `prev_image` parse, defaults work, parser fails closed on bad shape, round-trips.
- `pipeline/tests/test_frame_regen.py` — golden path on `frame:<id>`, missing id, missing prompt fallback, idempotency-key dedup, prev_image snapshot before write, dry-run.
- `pipeline/tests/test_store_video_config.py` — Python-side parser parity with the TS Zod schema.

Integration:
- `app/admin/videos/[id]/actions.test.ts` — `queueFrameImageRegen` writes the queue row, rejects without a session lock, rejects on cap hit, dedupes on idempotency key, snapshots `prev_image`.
- `app/admin/videos/[id]/actions.test.ts` — `revertFrameImage` restores `prev_image` and clears it; no model call.
- `lib/repo.test.ts` — loading a story with mixed-id and prev-image frames.

Regression:
- Existing `EditorClient` trim / caption / metadata tests stay green unchanged.
- New: center area test asserts Player OR labeled empty state — never a void.

E2E (only if Playwright is already wired):
- Open editor → click frame → edit prompt → Regenerate → see "Regenerating" → see thumbnail swap → click Revert → see original restored.
- Open editor for a story with zero `previewFrameUrls` → see labeled empty state.

If Playwright is NOT wired, do not bootstrap it in this PR. Use Vitest + a short manual checklist; bootstrap E2E as a separate plan when it pays for itself.

## 10. Open questions

1. ~~Frame ↔ scene cardinality.~~ Will verify in code during Phase 1: if `doodle_frames` is strictly 1:1 with `story.scenes`, the prompt-fallback fast-path is trivial; if N:1, the fallback still works but multiple frames may share the source prompt.
2. ~~Regen scope.~~ Resolved 2026-06-12: video-config-local. Frame regen never overwrites the source story scene.
3. **Cost per frame regen.** Need pricing check (rule 8) on the active image model before Phase 3 ships. The cost surfaces in the Regenerate button label and the session spend counter.
4. **Idempotency window.** How long does the queue treat the same `idempotency_key` as a dedup hit? Initial proposal: while a row with that key is in `queued` or `generating`, plus 30s after `done`. Open to tuning.

## 11. Rollout

- Phase 0 ships standalone, no feature flag — it's a bug fix.
- Phase 1 ships standalone — read-only enhancement, no risk surface.
- Phase 2 + 3 + 4 + 5 land behind `video.editor.frame_regen_v1` flag. Off in prod until verified end-to-end on a real story.

---

## Approval checkpoint

Yoav: confirm "go" and I start with Phase 0 — reproducing the black canvas in your dev environment and finding the actual cause. Nothing else gets touched until that's fixed and verified.
