# Voice picker: grid to searchable dropdown

Date: 2026-06-15
Status: implemented 2026-06-15
Related: _plans/2026-06-14-voiceover-picker.md (the original picker)

## Problem

The narrator voice picker rendered the whole catalog as a grid of tiles
(`grid-cols-2 md:grid-cols-3 lg:grid-cols-4`). It is a shared component used in
two narrow containers — the story-detail sidebar and the editor's AUDIO tab — so
it was forced to 4 columns of tiny cards whose names (`truncate`) collapsed to a
single letter. With the full ElevenLabs account (often 50-100+ voices) it became
an unreadable wall with no way to find a specific voice.

## Goal

A compact, searchable picker that works in both narrow containers: find any
voice in one or two keystrokes, preview without leaving the control, and keep
the per-provider cost visible.

## Approach (chosen via AskUserQuestion: "one search, grouped results")

Replace the grid with a combobox in `components/voice-picker/VoicePicker.tsx`:

- A single trigger button shows the current selection (name + provider) or
  "Global default voice". Click opens a panel.
- The panel has an autofocus search box that filters across name, accent, and
  provider label, instantly. Results stay grouped by provider with the cost
  blurb in each group header (rule 8: cost stays visible).
- Lazy: the list is windowed (first 40 filtered rows mount, more load as you
  scroll near the bottom); the preview MP3 is fetched only when its ▶ is
  clicked (the existing single shared `<audio>` element).
- Selecting a voice auto-saves (existing server action) and closes the panel.
  Reset-to-global and Regenerate are unchanged. Escape and outside-click close.

No backend change: the catalog is already loaded server-side and passed in, and
preview audio was already load-on-play. This is a pure front-end swap, so both
the story page and the editor AUDIO tab are fixed by the one component.

## Alternatives rejected

- Provider tabs + per-tab search: hides most voices behind a tab click and
  blocks searching across providers at once. The user picked unified search.
- A combobox library (Headless UI / Radix): avoided to not add a dependency for
  a control we can build cleanly against the existing Tailwind tokens.

## Test note

Tests stay `renderToString`-based (the repo has no testing-library; react 19 +
happy-dom + vitest). The panel renders into the DOM but ships `hidden` when
collapsed, so the static render still contains the rows/sections/testids the
existing assertions lock. Open/search/select interaction runs in the browser and
is out of scope for the static render; added closed-state coverage for the
trigger label, the search box, and the collapsed listbox.

## QA

- 16 tests pass in `VoicePicker.test.tsx` (13 existing + 3 new). Type-clean and
  lint-clean on the component and its test.
- Not yet exercised in a live browser session.
