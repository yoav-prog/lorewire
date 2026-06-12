# Video aspect ratio: 16:9 by default, 9:16 as a per-story option

**Status:** draft — awaiting approval
**Author:** Claude (with Yoav)
**Date:** 2026-06-12
**Supersedes:** nothing — this is a default-flip + new optionality, not a redesign

---

## 1. Goals

Today the entire LoreWire video pipeline assumes 9:16 portrait (1080×1920). That made sense when the only output was YouTube Shorts / TikTok / Reels. We now want:

- **New stories default to 16:9 landscape** (1920×1080) — wider distribution surface (YouTube main feed, embed-anywhere, X/Twitter cards, LinkedIn).
- **9:16 stays available per-story** — for the short-form pipeline (Shorts, TikTok, Reels).
- A single explicit knob the admin sees on every video editor, on every new story, in Settings → General as the default, and in caption/template scope so the visual contract follows the orientation.
- Existing portrait videos and pinned segments must keep rendering byte-identical so we don't break the back catalog or queued renders mid-flight.

The bar: opening "new story" produces a 16:9 video unless I check "9:16 for Shorts" up front, and that choice is honored by every stage (image gen → composition → segment normalization → public reader player).

## 2. Constraints

- **Hardcoded `1080 × 1920` everywhere.** Confirmed by grep: `video/src/Root.tsx` (composition), `pipeline/segments.py` + `lorewire-app/src/lib/segments-local.ts` (ffmpeg), `pipeline/media.py` + `pipeline/article_media.py` + `pipeline/stages.py` + `pipeline/images.py` (image gen aspects), `lorewire-app/src/app/v/[slug]/page.tsx` (public reader), `lorewire-app/src/app/admin/videos/[id]/EditorClient.tsx` (preview), `PositionPicker.tsx`, `FrameCard.tsx`, `AppShell.tsx`, `DesktopShell.tsx`, `manifest.ts`. Every site requires a branch.
- **Caption template math is portrait-coded.** `position_y` is interpreted against a 1920px-tall frame; `padding_x`, `outline_width`, font-size tiers (96/80/64 px at 1080-wide) all scale relative to portrait. Landscape needs different baselines or a unit reinterpretation.
- **Existing image assets are portrait.** Hero is 3:4, scenes are 1:1, props are 1:1, character mouth-swap is 3:4. Rendering portrait assets inside a 16:9 frame either letterboxes (ugly) or crops (loses content). Image-gen costs paid before the orientation choice was even an option.
- **No new data-shape break.** Old `ShortVideoConfig` rows without an `aspect` field must keep rendering exactly as today (portrait). Implicit-portrait fallback is non-negotiable for back-compat.
- **Settings audit (CLAUDE.md rule 15).** Default aspect lives in Settings → General. New stories inherit it. Per-story override on the editor and on the new-story form.
- **Observability (rule 14).** Every render logs `[render aspect]` with the resolved value so a misdrawn frame is debuggable from the console.

## 3. Requirements

### 3.1 The new `aspect` field on `ShortVideoConfig`

```ts
export type VideoAspect = "16:9" | "9:16";

export interface ShortVideoConfig {
  // ...existing fields...
  aspect?: VideoAspect; // missing = "9:16" for back-compat
}
```

Persisted as part of the story's `video_config` JSON blob, same place every other render-relevant flag lives. Resolution chain at render time:

1. `config.aspect` — explicit per-story choice (default for new stories).
2. `setting("video.default_aspect")` — global default (initial value: `"16:9"`).
3. Hardcoded fallback: `"9:16"` — applied only when reading rows that predate this change.

### 3.2 What the new aspect actually changes

| Concern | Portrait (9:16, 1080×1920) | Landscape (16:9, 1920×1080) |
|---|---|---|
| Remotion composition size | 1080 × 1920 | 1920 × 1080 |
| FFmpeg segment normalization | `scale=1080:1920:force_original_aspect_ratio=increase, crop=1080:1920` | `scale=1920:1080:..., crop=1920:1080` |
| Image gen aspect for hero / cinematic | 3:4 | 16:9 |
| Image gen aspect for scenes | 1:1 | 16:9 |
| Image gen aspect for props | 1:1 | 1:1 (unchanged — they slide in) |
| Mouth-swap character | 3:4 | 16:9 (or stays 3:4 with a smaller anchor) |
| Caption `position_y` math | 0..1 vertical (0=top, 1=bottom of 1920) | Same 0..1, but against 1080px — `position_y=0.85` now sits at y=918 instead of y=1632 |
| Caption font-size base (96 / 80 / 64 px) | computed at 1080-wide | computed at 1920-wide → multiply by 1920/1080 = 1.78 for visual parity |
| `padding_x`, `outline_width` | px on a 1080-wide canvas | scale by 1.78 to look the same |
| Public reader video container | `aspectRatio: "9 / 16"` | `aspectRatio: "16 / 9"` |
| Editor preview frame | `aspectRatio: "9 / 16"` | `aspectRatio: "16 / 9"` |
| PositionPicker box | 9:16 | 16:9 |
| FrameCard thumbnails | 64w × 113h at 9:16 | 64w × 36h at 16:9 |
| Phone-frame shells (AppShell, DesktopShell) | 9:16 hero, 3:4 article | 16:9 hero, 3:4 article (article stays portrait — that's the magazine layout) |
| `manifest.ts` orientation | `"portrait"` | `"any"` (PWA shouldn't pin orientation when both shapes are valid) |

### 3.3 The admin surfaces that need a new control

- **Settings → General**: `video.default_aspect` chip group (16:9 / 9:16) — uses the Phase A ChipGroup with a tiny visual preview of each frame shape. Default initialised to `"16:9"`.
- **Stories → New story form**: same chip group, defaulting to the global setting; choice flows into the row's `video_config.aspect`.
- **Stories → Edit page**: shows the current aspect with an editable chip group. Changing it post-render flags the story for re-render (banner + Render button highlighted).
- **Video editor → Metadata panel**: same chip group, auto-saves like everything else in the panel. Changing it shows a confirmation modal because the entire image asset set may need re-gen.
- **Templates → Caption template**: every tier (global / category / story) gets a sibling aspect-specific tier so a 16:9 template can have a different `position_y` than the 9:16 default. Implementation: separate setting keys (`caption.{tier}.16x9.{field}` vs `caption.{tier}.9x16.{field}`) with the resolver walking both chains.

### 3.4 Image regen story

Switching an existing portrait story to landscape leaves it with portrait scene/hero images. Three handling options:

1. **Smart center-crop** — the renderer crops portrait images to 16:9 on the fly. Cheapest, may lose key content (heads cropped at top, props off-frame).
2. **Letterbox with a doodle-paper background** — keep the portrait image centered, fill the sides with the `#fbfaf4` canvas + a subtle doodle border. Visually OK but feels like a fallback.
3. **Force regen on aspect change** — bulk-regen all images at the new aspect when the admin flips the toggle. Most expensive, best result.

Recommended: (3) but make it explicit. The aspect-change modal in the editor says "Switching to 16:9 will regenerate N images (~$X). Proceed?" with options to skip and accept the letterbox fallback in the meantime. New stories obviously skip this — their images are generated at the chosen aspect from the start.

### 3.5 Pricing implications (CLAUDE.md rule 8)

The image generator (kie.ai) charges per generation regardless of aspect ratio. Image counts per story today: 1 hero + N scenes (default 4-6) + M props (0-3 when prop_slide is on) + 2 mouth-swap (when mouth_swap is on). At ~$0.02 per image (kie.ai's current Nano Banana rate — needs live confirmation per rule 1), the cost is unchanged per render.

But — an existing story that flips orientation costs the full per-story image-gen cycle again (~$0.10–$0.20 depending on settings). I'll surface this in the confirmation modal with the live count and the per-image cost pulled from the same place the Settings → Models page reads it.

**Pricing TODO before Phase 1 ships:** I'll fetch kie.ai's current pricing for the configured image model + verify against `models.dev` before I quote the dollar figure in the UI. Per rule 1 / rule 8 — no training-data guess.

### 3.6 Resolution helper (the seam everything else uses)

```ts
// video/src/aspect.ts (new)
export type VideoAspect = "16:9" | "9:16";

export interface AspectDims {
  width: number;
  height: number;
  cssRatio: string;          // e.g. "16 / 9"
  ffmpegSize: string;        // e.g. "1920:1080"
}

export function aspectDims(aspect: VideoAspect): AspectDims;
export function resolveAspect(
  configAspect: VideoAspect | undefined,
  globalDefault: VideoAspect,
): VideoAspect;
```

Every site that hardcodes 1080×1920 imports `aspectDims(aspect).width / .height` instead. The composition picks dims via `calculateMetadata`. The ffmpeg normalizer reads from `aspectDims().ffmpegSize`. The CSS preview boxes read `aspectDims().cssRatio`. Single source of truth.

## 4. Approach (phased so each phase ships independently)

### Phase 0 — Settings + schema seam (foundation, no UI change)

- Add `VideoAspect`, `aspectDims()`, `resolveAspect()` to `video/src/aspect.ts`.
- Add `aspect?: VideoAspect` to `ShortVideoConfig`. Bump `CURRENT_CONFIG_VERSION` to `3`; ship a migration that leaves missing `aspect` as `undefined` (interpreted as 9:16 at the resolver).
- Add `video.default_aspect` setting (default `"16:9"`).
- Update `video/src/Root.tsx` `calculateMetadata` to read `aspect` from props and emit the right `width` / `height`. Without a UI flip yet, this is invisible.
- **Acceptance:** every existing story renders byte-identical (no `aspect` field → resolver returns 9:16 → dims unchanged). New `video.default_aspect` setting exists but no UI exposes it yet.

### Phase 1 — Composition + caption math respects aspect

- Replace every `1080` / `1920` literal in the composition with `useVideoConfig()`-driven values. Already true for `useCurrentFrame` plumbing; needs an audit of `MicroWiggle`, `LabelPopOn`, `ScribbleDraw`, `PropSlideIn`, `MouthSwap`.
- Caption font-size tiers + `padding_x` + `outline_width` switch from hardcoded 1080-baseline math to `width / 1080` proportional scaling, so a `padding_x` of 64 looks the same at 16:9 (becomes 64 × (1920/1080) = 114 effective px) and 9:16.
- Add unit tests pinning a 16:9 render produces the right canvas size and a 9:16 render still produces the legacy size.
- **Acceptance:** in Remotion Studio, switching `aspect` between 16:9 and 9:16 on the same story flips dimensions live; captions stay readable on both.

### Phase 2 — Pipeline image gen branches on aspect

- `pipeline/media.py`, `pipeline/article_media.py`, `pipeline/stages.py`, `pipeline/images.py` accept an `aspect` parameter and pick the per-asset aspect ratio table (hero: 16:9 vs 3:4; scenes: 16:9 vs 1:1; etc.) from a single resolver.
- The pipeline reads `story.video_config.aspect` (or the global default) and passes through.
- Existing `aspect_ratio="3:4"` call sites stay reachable via the resolver — the back-catalog path is unchanged.
- **Acceptance:** dry-run a story with `aspect=16:9` end-to-end; the queued image-gen jobs request 16:9 aspect strings.

### Phase 3 — Segment normalization branches on aspect

- `pipeline/segments.py` + `lorewire-app/src/lib/segments-local.ts` build their `vf` filter graph from `aspectDims(aspect).ffmpegSize` instead of the literal `1080:1920`.
- Pinned segments (intro / outro) carry an `aspect` field on the row. The pipeline rejects a 9:16 segment for a 16:9 story (or auto-crops with a console warn — pick when we have a real intro library to test against).
- **Acceptance:** uploading an intro at 16:9 to a 16:9 story renders correctly end-to-end.

### Phase 4 — Admin UI exposes the choice

- Settings → General: `video.default_aspect` chip group with two visual previews.
- Story edit page: aspect chip group near the title row.
- New-story form: aspect chip group seeded from the global default.
- Video editor → Metadata panel: aspect chip group with the regen-cost confirmation modal on flip.
- Public reader `/v/[slug]`: container `aspectRatio` reads from the resolved aspect; OG image's `width` / `height` switch too.
- `manifest.ts` `orientation: "any"` (was `"portrait"`).
- Phone-frame shells (`AppShell`, `DesktopShell`): if the surfaced video is 16:9, render the wider preview; if 9:16, keep today's tall column.
- **Acceptance:** new stories default to 16:9 end-to-end without any extra setup.

### Phase 5 — Caption template tiers grow an aspect dimension

- Settings keys grow an aspect prefix: `caption.{tier}.{16x9|9x16}.{field}`. The resolver walks `story-aspect → cat-aspect → global-aspect → global-default → hardcoded`. Missing per-aspect tier inherits from the default.
- Templates page adds an aspect tab next to the existing scope tabs so the admin can edit a 16:9 caption setup distinct from the 9:16 default.
- Phase E's `TemplateFieldGrid` already supports tier overrides — the aspect dimension slots in as another scope key, no new control needed.
- **Acceptance:** flipping a story between 16:9 and 9:16 picks up the aspect-specific caption template if one exists, falls back to the cross-aspect default otherwise.

## 5. Rejected alternatives

- **Letterbox-only fallback (Approach 3 in §3.4).** Cheapest but visually weakest — portrait assets on a 16:9 frame look like a phone screenshot, which is the opposite of "feels deliberate". Rejected as the only option; kept as a per-story escape hatch when the admin doesn't want to pay for regen.
- **Smart center-crop only.** Saves regen cost but loses key content (heads at top of frame, props bottom-cropped). The doodle composition is built around vertical staging; squishing it horizontally destroys the look. Rejected as primary path.
- **Fork the project into "shorts" and "long-form" channels.** Tempting (cleanly separates the workflows) but doubles the maintenance burden and confuses the admin: same story, two URLs, two image sets, two video files. The single-row-with-an-aspect-flag model keeps the editorial workflow unified. Rejected.
- **Ship Phase 0–5 as one big PR.** Each phase is independently testable and the back-compat path (`aspect` missing → portrait) means earlier phases can land in prod without exposing the choice. Phased rollout it is. Rejected the big-bang approach.
- **Use a single composition that internally branches.** Considered keeping `DoodleShort` and just changing `calculateMetadata` to flip dims. That's actually the plan for the composition itself, but the bigger system change (image gen, ffmpeg, captions, UI) needs the aspect plumbed through every layer. The composition is the simple part; everything else is the work.

## 6. Security (CLAUDE.md rule 13)

- `aspect` is a typed `"16:9" | "9:16"` field. The server action that writes it validates against the union; an attacker spoofing a third value gets a rejection, not a free-form ffmpeg size.
- The aspect-change modal calls the same `bulkRegenAction` that already authenticates as admin — no new auth surface.
- The ffmpeg `vf` filter graph reads dimensions from `aspectDims()`, never from user input — there's no shell-injection path that didn't exist before.
- Pinned segments carry an `aspect` row column; the upload sign-URL flow validates the dimension against the row before letting the bytes through.
- The setting `video.default_aspect` is admin-gated like every other setting — no new key, no new sensitivity.

## 7. Observability (CLAUDE.md rule 14)

Logs the renderer + pipeline + admin UI add:

- `[render aspect resolve] { story_id, configAspect, globalDefault, resolved }` — emitted once per render so a wrong-shaped frame is debuggable from the queue worker output.
- `[pipeline aspect resolve] { story_id, resolved, hero_aspect, scene_aspect }` — emitted at the start of image gen for a story so a half-portrait/half-landscape asset set is immediately spottable.
- `[admin ui aspect flip] { story_id, from, to, willRegen, image_count }` — emitted client-side when the admin confirms a flip so we can correlate cost spikes with editorial decisions.
- `[ffmpeg normalize] { aspect, source_size, target_size }` — already logs target size; add the resolved aspect string so a cropped-wrong segment is one grep away.
- Public reader `/v/[slug]` page emits `[reader video render] { story_id, aspect }` so user reports of "the video is sideways on my phone" come with a diagnosable line.

## 8. Settings (CLAUDE.md rule 15)

New entries:

- `video.default_aspect` — `"16:9" | "9:16"`, default `"16:9"`. Drives every new story's initial choice. Exposed in Settings → General as a chip group.
- `caption.{tier}.{aspect}.{field}` — sparse per-aspect override layer for the caption template chain. No new UI entry per se — the Templates page grows an aspect tab.

Intentionally not exposed:

- Per-asset aspect mappings (hero=16:9 vs 3:4, scenes=16:9 vs 1:1). Hardcoded in the resolver — the admin doesn't need to micro-tune image aspect per orientation; we pick the right one.
- Letterbox fallback color. Hardcoded to `#fbfaf4` (the doodle canvas). If we ever need this tunable it can land in a follow-up.

## 9. Testing (CLAUDE.md rule 18)

Unit:

- `aspect.test.ts` — `aspectDims("16:9")` returns 1920×1080 + correct cssRatio + ffmpegSize. `resolveAspect(undefined, "16:9")` returns `"9:16"` (back-compat). `resolveAspect("16:9", "9:16")` returns `"16:9"` (config beats default).
- `Root.test.tsx` (Remotion) — `calculateMetadata` emits the right width/height for both aspects.
- `caption-style.test.ts` — extending: `position_y=0.5` resolves to 540px at 16:9 and 960px at 9:16 (proportional). `padding_x=64` resolves to 64 × (width/1080) px.
- `segments-local.test.ts` — extending: passing `aspect="16:9"` produces `scale=1920:1080:force_original_aspect_ratio=increase, crop=1920:1080`; default still produces the 1080:1920 graph.

Integration:

- `actions.test.ts` — `setStoryAspectAction("16:9")` writes through; flip from 16:9 → 9:16 → 16:9 round-trips cleanly. Invalid aspect rejected.
- Pipeline dry-run end-to-end at both aspects: the same story script produces a 1920×1080 mp4 with `aspect=16:9` and a 1080×1920 mp4 with `aspect=9:16`.

Regression:

- Every existing `1080:1920` / `9:16` test pin stays green — back-compat is the load-bearing requirement.

E2E (only if Playwright is wired):

- Open `/admin/stories/new` → see 16:9 selected by default → submit → resulting story's `video_config.aspect === "16:9"` → render produces 1920×1080 mp4.

## 10. Open questions

1. **The doodle look at 16:9.** The current visual identity (full-bleed doodle paper, centered illustrations, big bottom captions) was designed for portrait. At 16:9 it gets a lot of horizontal whitespace. Do we want a different composition for landscape (side panels for the article context + the doodle on the left, say) or accept that 16:9 will feel "lighter"? I lean: keep the composition identical for v1, evaluate side-by-side, decide on a richer landscape layout in a follow-up plan.
2. **Mouth-swap aspect.** The talking-head bust is anchored bottom-right at a fixed pixel offset that assumes 1080-wide. At 1920-wide it needs to either anchor proportionally (lands further right) or get a new anchor formula tuned for landscape. I lean: proportional anchor for v1; revisit with a real 16:9 render in hand.
3. **Public OG card dimensions.** OG images are 1200×630 (1.91:1). They're already separate from the video aspect, but the auto-generated `/v/[slug]/og` endpoint currently composes against the portrait video frame. For 16:9 we can use the video frame directly (closer match). I lean: switch the OG generator to use the same shape as the resolved aspect for 16:9 stories, leave the 1.91:1 fixed template for 9:16 stories.
4. **Per-aspect caption template tiers.** The plan grows the setting key namespace. Worth doing in Phase 5 or skip and rely on visual scaling alone? My bias: ship Phase 5 because `position_y` semantics genuinely differ (a 0.85 caption near the bottom looks great on 9:16 and weirdly low on 16:9 because the text band is closer to the bottom edge). A small UI cost for editorial flexibility.

## 11. Rollout

- Phase 0 ships alone behind no flag (back-compat path means it's invisible until UI exposes the choice).
- Phase 1 ships alone — renderer respects the aspect when set, but no story has `aspect` set yet so still byte-identical.
- Phase 2 + Phase 3 ship together — once pipeline + ffmpeg respect aspect, the data path is consistent for stories that will eventually flip.
- Phase 4 exposes the UI behind a `ui.admin.video_aspect_v2` flag. Default off for one deploy. Verify on staging end-to-end. Then flip on.
- Phase 5 ships after Phase 4 stabilises so per-aspect template tuning can use real 16:9 renders as reference.
- Existing stories never auto-flip. The global default flips to 16:9 only when Phase 4's UI is enabled — new stories start landing as 16:9 from that moment.

---

## Approval checkpoint

Yoav: confirm "go" and I start with Phase 0. Before Phase 1's caption math change I'll come back with sample renders side-by-side so we agree on what "the doodle look at 16:9" should look like — that's the riskiest creative decision in this plan and I don't want to lock it in without seeing it.

LLM Council pass before code? My bias: **yes** this time. Aspect ratio touches creative direction (the doodle look), commercial strategy (which distribution surfaces matter most), and technical debt (caption math, image gen costs). Five perspectives will surface tradeoffs I can't see alone — particularly around the back-catalog question and whether YouTube-main-feed audience expectations match LoreWire's voice. Rule 11 makes this a council call.
