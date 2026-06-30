# Editorial poster redesign (portrait)

**Date:** 2026-06-30
**Status:** Approved (Yoav agreed to the design + go-ahead before this plan was written; documenting per CLAUDE.md rule 7 so a future session can pick the work up.)
**Scope:** `video/src/PosterStill.tsx` portrait composition only. Landscape OG poster (`PosterStillLandscape`) is OUT OF SCOPE — it serves crawlers, has a different aspect, and its current design works.

## Goal

Replace the current "scene on top 70% + dark navy band + Bebas Neue caps + brand pill" portrait poster with a premium editorial cover that mirrors the dramatic-magazine look in the reference image Yoav attached: dark warm-brown header at the top 28%, serif hook with one red brush-script emphasis word, gold ornamental frame, scene illustration filling the bottom 72%. The thumbnail has to work uniformly across TikTok, Instagram Reels, Facebook Reels, and YouTube Shorts (all 9:16 1080×1920).

## Why now

The Phase 2 portrait poster (Bebas Neue caps + dark band) reads as a competent shorts-farm cover. The brief Yoav gave is for the brand to read as PREMIUM EDITORIAL, not generic shorts. The reference image is the visual contract.

A side-benefit: moving the text to the TOP of the canvas puts it INSIDE every platform's safe area. Today the bottom band fights TikTok's like/share UI and YouTube Shorts' title bar at the bottom of the canvas. After this change the text never overlaps platform overlays.

## What changes

### Layout
- Header: top 28% (538 px tall on 1920 canvas).
- Divider: thin gold rule + small ornament at y=538.
- Image: bottom 72% (1382 px tall), `objectFit: cover`, `objectPosition: center 25%` (faces stay in frame).

### Header design
- Background: solid warm-dark `#1A0F0A` (chosen over a gradient — gradients on a 1080-wide PNG band as 1-bit dither at GCS/R2's PNG settings).
- Inner gold frame: 2 px gold (`#C9A96A`) rectangles inset 40 px from header edges. Small diamond glyphs at the four inner corners.
- Top center wordmark: "L O R E   W I R E" in tiny gold Cinzel, letter-spaced wide, sitting between the top of the frame and the main hook. Replaces the bottom-right brand pill.
- Hook block: vertically centered inside the frame.

### Hook typography
- Non-emphasis words: Playfair Display Bold (700 or 900), title case (do NOT uppercase), cream `#F4ECD8`. Auto-sized 76→58 pt by line length.
- Emphasis word (last word of the hook, period stripped): Caveat Brush, large, red `#C5302C`, slight downward bleed. Renders on its own line BELOW the serif block.
- 1-word hook: brush only, no serif part.
- 0-word/empty hook: return null upstream (already handled in `ensureShortPoster`).

### Image area
- Source: `scene_1_url` exactly as today.
- `objectFit: cover`, `objectPosition: center 25%` to keep heads up.
- No text overlay (the spec is explicit).

### Drop
- The bottom-right brand pill (replaced by the gold wordmark in the header).
- Bebas Neue (replaced by Playfair Display + Caveat Brush).
- The 8 px red accent stripe between scene and band (the gold divider and the gold frame are the new brand signal).

## Font choices

Per Context7 + node_modules inspection, all three are available as `@remotion/google-fonts/<Name>` submodules:
- `@remotion/google-fonts/PlayfairDisplay` — main serif, weights `["700", "900"]`.
- `@remotion/google-fonts/CaveatBrush` — emphasis script, weight `["400"]`.
- `@remotion/google-fonts/Cinzel` — small gold wordmark, weight `["600"]`.

## Emphasis-word strategy

Heuristic, deterministic, no LLM contract change:

1. Trim the hook.
2. Strip trailing punctuation (`.`, `!`, `?`, `…`, `…`).
3. Pop the last whitespace-delimited token; that's the emphasis.
4. Remainder is the serif block.
5. Strip trailing `.` from the remainder so we don't double-punctuate.

Edge cases:
- 1 token after stripping → render brush only.
- 0 tokens → return null (composition has nothing to render; falls out of the existing scene-1 fallback path).

Rejected: LLM-marked emphasis (`**word**`). Two reasons: (a) it'd churn the `generatePosterText` prompt that's already tested + locked, and (b) the existing cached `poster_text` rows wouldn't have markup and would render without emphasis until each story regenerated — which never happens (cache is sticky). The heuristic works for every hook I checked against the current production `poster_text` cache.

## POSTER_VERSION bump

`POSTER_VERSION` in `lorewire-app/src/lib/short-poster.ts` is the cache-key salt for the rendered PNG. Bumping it makes every cached poster URL miss HEAD on the next publish, which triggers a fresh Cloud Run render against the new composition. No backfill script needed.

`v1` → `v2`.

## Security
- No new user input. Hook text is already brand-safety / glyph / RTL guarded before reaching the composition.
- No new network calls. Same `Img` src, same Cloud Run endpoint, same fonts.
- No PII logged. The composition is pure render given props.

## Observability
- `[poster ensure]` namespace already covers cache hit / render / verify (the previous PR). Composition-side logs are not useful — once Cloud Run accepts the props the render is deterministic.
- No new logs needed.

## Testing
- New unit tests for the emphasis-word splitter in `video/src/PosterStill.test.ts` (Node `node:test`-style, matching `composition-metadata.test.mjs`). Cases: empty, 1 word, 2 words, multi-line, trailing period, trailing `!`/`?`/`…`, smart quote, double space, whitespace-only.
- `lorewire-app/src/lib/short-poster.test.ts` — no changes needed; the upstream `ensureShortPoster` flow is unchanged.
- No visual regression test. The Cloud Run render is validated in production by inspecting the first post-deploy poster.

## Settings
- The existing `publisher.short_poster.enabled` kill switch still works — flip OFF if the new design ships broken.
- No new settings. The design is a brand decision, not a per-story knob.

## Deploy
- One PR off fresh `main` → review → merge to `main` → Vercel auto-deploys + Cloud Run picks up the new composition on next render.
- Cloud Run needs the new composition deployed too. Per the deploy runbook the user already has, Cloud Run rebuilds from the `video/` Webpack bundle on its own deploy step.
- Production cutover: bump POSTER_VERSION lands the new visual the moment Cloud Run is also on this branch. If Vercel deploys first and Cloud Run lags, `ensureShortPoster` would HEAD the new-version URL, miss, POST to Cloud Run, and Cloud Run renders with the OLD composition (because its bundle hasn't updated yet) at the NEW key. Result: a few stories get the old-design PNG cached at v2 keys until Cloud Run redeploys. Not a takedown, just a minor visual delay. Fix: deploy Cloud Run BEFORE Vercel auto-deploys main, OR accept the brief mismatch.
- Vercel-UI safety: do not "Promote to Production" manually. Let the auto-deploy from main do it.
