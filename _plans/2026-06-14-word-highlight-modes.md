# Word highlight modes — preview + renderer alignment

**Date:** 2026-06-14
**Trigger:** User reported "word highlight is not working at all" in the video editor with `karaoke` selected.

## Goals

1. Word highlight is visible in the editor preview (currently the preview renders the whole chunk as one block — see [PreviewComposition.tsx:485-523](../lorewire-app/src/components/video-preview/PreviewComposition.tsx#L485-L523) and the comment at line 22-26 stating the preview deliberately doesn't render karaoke).
2. The four non-`none` modes — `karaoke`, `color`, `scale`, `background` — each have a distinct, observable visual effect. Currently the renderer ([DoodleShort.tsx:373-390](../video/src/DoodleShort.tsx#L373-L390)) ignores the value and always renders color-per-word, which made every chip in the CaptionStylePanel look identical (and made the preview look broken because nothing changed at all).
3. Preview and renderer match. The editor must reflect the rendered MP4 byte-for-byte at the per-word level.

## Out of scope

- Per-word timing extraction (already done; chunks ship with `words?: ShortCaptionWord[]`).
- Adding/removing modes from the panel UI.

## Mode semantics

Each chunk is split into words. `findActiveWordIndex(words, elapsedMs)` returns the current word (or -1).

- **none** — render `chunk.text` as a single block, no per-word styling. `color` only.
- **karaoke** — three-state per word.
  - upcoming → `color`
  - active   → `active_word_color`
  - spoken   → `spoken_word_color`
  - 80ms `color` transition between states. (Matches the current renderer's behavior, preserved.)
- **color** — two-state per word.
  - active   → `active_word_color`
  - everything else → `color`
- **scale** — active word scales to 1.15× and uses `active_word_color`; all other words are at base scale and `color`. 120ms ease-out transform transition.
- **background** — active word gets a rounded background pill in `active_word_color`, with text color from `color` (so the word reads against the pill); other words are plain `color`. Pill padding scales with font size.

## Shared helper

Extract the word-splitting (chunk → `ShortCaptionWord[]` with proportional fallback) and active-index logic into a shared pure helper so the preview and renderer can't drift.

- `lorewire-app/src/lib/caption-words.ts` — new, exports `splitChunkWords(chunk)` and re-exports the per-word active-index logic. Pure functions, browser-safe.
- `video/src/caption-words.ts` — already has `findActiveWordIndex`. Add `splitChunkWords` mirror so the renderer stays self-contained (the renderer can't import from `lorewire-app`).

The two `caption-words.ts` files must stay byte-identical for the split helper. Cross-import isn't possible (renderer is its own Remotion project); enforce parity by a unit test that compares the stringified function bodies.

## Files touched

| File | Change |
| --- | --- |
| `lorewire-app/src/lib/caption-words.ts` | NEW — `splitChunkWords`, `findActiveWordIndex` (mirror of `video/src/caption-words.ts`). |
| `lorewire-app/src/components/video-preview/PreviewComposition.tsx` | `CaptionBand` now splits into words and renders per-mode. Update header comment. |
| `video/src/DoodleShort.tsx` | `DoodleCaption` switches on `wordHighlight` to pick a render branch. |
| `video/src/caption-words.ts` | Add `splitChunkWords` (mirror of new helper). |
| `lorewire-app/tests/lib/caption-words.test.ts` | NEW — covers `splitChunkWords` (with/without `words`), `findActiveWordIndex` boundaries. |

## Testing

- Unit tests for `splitChunkWords` — uses provided words when present, falls back to proportional split otherwise.
- Unit tests for `findActiveWordIndex` — boundaries, gaps, before/after.
- Type checks + existing vitest suite must remain green.

## Observability (rule 14)

The CaptionBand is silent today. Add a single `console.info('[caption-preview mode]', { mode, activeIdx, words: words.length })` on the **first frame** of each chunk so an editor debugging "why doesn't it karaoke" can see what mode the preview thinks it's in without reading the resolver chain.

## Settings audit (rule 15)

The `word_highlight` setting already exists in the panel with all four modes exposed. No new controls.

## Security (rule 13)

No user input touches the renderer here; all values come from the typed `CaptionStyleProps`. Mode names are checked against the allow-list in `toPreview()`'s `oneOf("word_highlight", WORD_HIGHLIGHTS, "karaoke")` before reaching the preview. No injection surface.
