# 3.3 Public UI: real images, audio, video, read-along

Date: 2026-06-11
Status: in progress
Section in handoff: 3.3

## Goal

Wire the columns 3.1 + 3.2 already populated (`hero_image`, `images`,
`audio_url`, `video_url`, `alignment`) into the public site. The CSS-only
poster art, the hand-illustrated doodle frame, and the fake setInterval-driven
read-along all switch over to real generated media when a story has it and
fall back to the current treatment when it doesn't.

## Decisions (locked by precedent / size)

- **Plain `<img>` not `next/image`.** Assets live under `public/generated/...`
  (same-origin), there is no remote loader to configure, and `next/image`'s
  big wins (srcset, lazy, blur placeholder) are moderate at our scale. Using
  `<img>` ships now with zero config; swap to `next/image` if LCP ever shows
  up as a real Web Vital problem. Documented as a deliberate decision, not
  an oversight.
- **Native `<video controls>` with a hero-image poster.** Custom video chrome
  is more design but reinvents fullscreen, keyboard a11y, and scrubbing. The
  Billboard play CTA stays as the design-y entry; the Watch tab gets a native
  player whose poster is the hero image so the brand still leads in.
- **Read-along driven by `<audio>` `timeupdate`.** Drop the fake
  setInterval/SCRIPT. Word index resolves from `story.alignment`, with the
  current word picked by the same linear-scan rule the Remotion composition
  uses (`elapsedMs in [start, end)`). When `alignment` is empty, fall back
  to the existing SCRIPT/setInterval behavior so older stories keep working.

## What changes

### Data layer

1. `pipeline/export_app.py` widens the SQL to also select `hero_image`,
   `images`, `audio_url`, `video_url`, `alignment`. JSON columns are
   deserialized before they go into the emitted TS so the runtime gets a
   real array, not a stringified one.
2. The generated `published.ts` interface grows the matching optional fields.
3. `lorewire-app/src/lib/stories.ts`:
   - `Story` type gains `heroImage?`, `images?: string[]`, `audioUrl?`,
     `videoUrl?`, `alignment?: { word; start; end }[]`.
   - The CMS overlay loop copies the new fields onto existing entries and
     populates them on new ones.

### UI surfaces (both AppShell.tsx and DesktopShell.tsx — symmetric edits)

4. **`PosterArt`**: when `story.heroImage` is set, render an `<img>` as the
   background (object-fit: cover) under the existing kicker / dur pill /
   title-ink-shadow layer. The radial gradient and grain overlay sit on top
   of the image so the brand color remains visible at the edges. When the
   image errors, fall back to the gradient automatically (`onError` strips
   the src).
5. **`Hero` / `Billboard`**: same trick at 500 px tall. The image is centered
   with cover; the bottom gradient + CTA stack are unchanged.
6. **`TitleSheet` / `DetailModal` header**: when heroImage is set, use it as
   the cover instead of the gradient. The big glyph stays as a translucent
   decoration on top (already a layered design).
7. **`WatchDoodle`**: split into two paths. With a `videoUrl`, render
   `<video controls poster={heroImage} preload="metadata" />` in the same
   430 px container the doodle uses, plus the brand tagline ("hand-drawn
   explainer · low-motion") underneath. Without a videoUrl, keep the
   existing illustrated doodle exactly.
8. **`ReadAlong`**: when `audioUrl` + `alignment` are both set, replace the
   fake setInterval with a real `<audio>` element. The play button toggles
   `audio.play()`/`pause()`; `timeupdate` fires the active-word selection;
   the waveform bars fill based on `audio.currentTime / audio.duration`. The
   per-word span styling stays unchanged so the visual feel is identical.
   Without alignment, the existing SCRIPT/setInterval path still runs.

### Observability (rule 14)

- `<img onError>` / `<audio onerror>` / `<video onerror>` each log a
  namespaced line: `console.warn('[lorewire poster err]', { storyId, src })`.
  Quiet on the happy path, loud when a generated asset 404s.

## Cost (rule 8)

Zero. UI changes, no API calls.

## Security (rule 13)

- Assets are loaded from same-origin paths starting with `/generated/`.
  `<img>`/`<video>`/`<audio>` have no `crossOrigin`, no `srcDoc`, no
  `dangerouslySetInnerHTML`. Nothing here changes the surface area.
- `published.ts` is a generated module; the only injection vector would be a
  malicious value in the DB getting embedded as JS. We `JSON.stringify` it,
  so it's escaped.

## Settings audit (rule 15)

- No new admin settings. The pipeline owns "what gets generated"; the public
  UI owns "how it's shown." Viewer-side preferences (autoplay, caption
  visibility) would be a different system if we ever surface them.

## Tests (rule 18)

The Next app has no test framework yet. For this section, the cost/benefit
falls short of adding one:

- The poster/hero/modal changes are visual; rendering correctness is a real
  QA pass (browser play-through), not a unit assertion.
- The active-word logic is identical to the Remotion `findActiveWordIndex`
  helper that already has 4 unit tests in the video project.
- The fallback paths (no heroImage, no alignment, no audio) are short
  conditionals.

Flagging this honestly: the right time to add Vitest is when the next
feature has real testable logic (the Read tab article-pagination, the
search-ranking, etc.). For now, the QA is a manual browser sweep.

## QA plan (rule 6)

1. Pipeline: re-export published rows via `python -m pipeline.export_app`
   (manually publish the `envelope` row first via `/admin`).
2. Start dev: `cd lorewire-app && npm run dev`.
3. Mobile width (browser narrow viewport):
   - Home: Billboard shows hero image; posters in rails show hero images;
     stories without media still render the gradient.
   - Detail modal: header shows hero image; Watch plays the MP4 with the
     hero image as poster; Read shows the article; Read-along plays the
     real audio with the real word timings.
4. Desktop width:
   - Hero shows image; Top 10 / rails show images; DetailModal same as
     mobile.
5. Error cases: rename `envelope/hero.png` to force a 404 and confirm the
   poster falls back to the gradient without breaking the page.
6. Type check: `npm run build` passes.

## Rejected alternatives

- **`next/image` everywhere.** Real LCP gains but requires a config dance
  for `/generated/*` (custom loader or whitelist), and the doodle UI's
  artistic ratios push against `next/image`'s sizing model. Defer until
  there's a real performance signal.
- **Custom video player with brand chrome.** Pretty, but reinvents
  fullscreen, captions track, scrubbing, keyboard a11y. Not worth the cost
  this iteration. Native controls + a hero-image poster keep the brand
  visible at the entry point, which is where it matters most.
- **WebVTT-driven captions burned into the video already render karaoke
  during playback** (the composition already does this). Adding a WebVTT
  layer in the public UI on top of that would double-render the captions.
  Skip.
