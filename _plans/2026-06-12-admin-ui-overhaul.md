# Admin UI overhaul: make the editor feel like a video editor

**Status:** draft — awaiting approval
**Author:** Claude (with Yoav)
**Date:** 2026-06-12
**Supersedes:** nothing — this is a UX/design pass, not a feature rewrite

---

## 1. Goals

The video editor (`/admin/videos/[id]`), the Settings page, and the Stories edit page all look like spreadsheets dressed up in dark mode. Number stepper inputs for everything. Hex text for colors. Per-field Save buttons. No visual presets.

After this pass:

- Anything numeric with a clear range becomes a **horizontal slider** with a visible track, draggable thumb, live value display, and a click-to-jump track.
- Anything color becomes a **proper color picker** with a swatch, hex input, color wheel, and 8 recent-colors swatches. Replaces every native `<input type="color">`.
- Anything enumerated with a visual effect (entry animation, word highlight, ken-burns, micro-wiggle, etc.) becomes a **visual chip group** where each chip is a tiny live preview of what the value DOES, not just its name.
- Every panel **auto-saves** on a 500ms debounce. The Save buttons go away. A single inline "Saved 1s ago / Saving… / Failed" status replaces them.
- The Caption Style panel grows a **presets row** at the top: 4–6 named built-in styles ("MrBeast bold", "Karaoke yellow", "Clean white", "Subtle gray", "Tiktok-glow") plus a "Save current as preset" action that persists the user's own named styles.

The bar: opening any panel feels like opening Premiere, CapCut, or DaVinci Resolve. Tactical, dense, polished. Not a settings form.

## 2. Constraints

- Keep the existing dark editor aesthetic — `bg-surface` / `bg-surface2` / `border-line` / `text-ink` / `text-muted` / `var(--color-accent)`. No gradients, no glassmorphism (CLAUDE.md rule 5).
- Keep the existing data layer untouched. Every new control writes through the SAME server actions (`saveStoryCaptionStyleAction`, `saveSettingAction`, etc.) that the current controls use. Zero data-shape changes.
- "NOT the Next.js you know" (per `lorewire-app/AGENTS.md`). Before writing any new route or server-action wiring, re-read the relevant primitives.
- The auto-save debounce MUST coexist with the existing edit-session lock — a foreign session still freezes the controls.
- Accessibility: every slider keyboard-navigable, every color picker focus-trapped while open, every chip group ARIA `radiogroup`-labeled.
- Don't break anything that already works. Toggles, autocomplete, voice selects, textareas, preset chips stay as-is — they're already good.

## 3. Requirements

### 3.1 The component library (built once, used everywhere)

| Component | Use case | Range / API |
|---|---|---|
| `Slider` | Numeric range fields | `value, min, max, step, onChange, label, unit, ticks?, resetTo?` |
| `ColorPicker` | Any hex color field | `value, onChange, recentColors?, presetSwatches?` |
| `ChipGroup` | Enumerated visual choices | `value, options: { id, label, preview: ReactNode }[], onChange` |
| `FieldRow` | Common label + control + inheritance hint + Reset | `label, hint?, inheritance?, children` |
| `AutoSaveStatus` | "Saved 1s ago" inline indicator | `state: idle / saving / saved / error, savedAt?` |
| `PresetRow` | Horizontal scrolling preset cards | `presets, currentMatch?, onApply, onSaveAs?` |

Each component lives under `lorewire-app/src/components/ui/` (new directory) so it's reusable beyond the editor.

### 3.2 What gets upgraded, by surface

**Video editor — Caption Style panel:**
- `position_y` stepper → `Slider` (0..1, step 0.01) with TOP/BOTTOM endpoint labels.
- `size_scale` stepper → `Slider` (0.5..2, step 0.05) with "S"/"L" endpoint labels and 1.0 tick mark.
- `padding_x` stepper → `Slider` (0..200, step 4, unit "px").
- `font_weight` stepper → `ChipGroup` with chips that RENDER text at each weight (300/400/500/600/700/800/900).
- `letter_spacing` stepper → `Slider` (-5..5, step 0.1, unit "px") with 0 tick.
- `line_height` stepper → `Slider` (0.8..2, step 0.05) with 1.0 tick.
- `text_transform` dropdown → `ChipGroup` (Uppercase / None / Lowercase) where each chip transforms the word "Aa" to match.
- `color`, `active_word_color`, `outline_color` native picker → `ColorPicker`.
- `spoken_word_color` text (supports rgba) → keep as text but add `ColorPicker` for the rgb portion and a separate opacity slider.
- `outline_width` stepper → `Slider` (0..12, step 1, unit "px").
- `entry_effect` dropdown → `ChipGroup` (None / Fade / Pop / Slide-up) where each chip shows a 0.5s animation of a sample word on hover.
- `word_highlight` dropdown → `ChipGroup` (None / Karaoke / Color / Scale / Background) where each chip shows a 4-word sample with the highlight effect active.
- **Presets row at the top.** 4–6 built-in named styles, plus "Save current as preset" action.

**Video editor — Trim panel:**
- The dual `clip_start_ms` / `clip_end_ms` becomes ONE range slider with two handles, a filled middle band, and the time tics rendered underneath. Numbers below for fine-tune typing.

**Video editor — Audio panel:**
- `music.gain_db` (already a slider, polish it with the new component).

**Video editor — Overlays panel:**
- `overlay.x`, `overlay.y` (already sliders) → use new `Slider` component, render as a 2D position picker (drag the dot inside a 9:16 box) instead of two separate sliders.
- `overlay.start_ms`, `overlay.end_ms` → range slider tied to the trim window's tics.

**Video editor — Metadata panel:**
- `ken_burns` checkbox → toggle (already is via SettingToggle pattern, just port).

**Video editor — Captions panel:**
- Per-chunk textarea stays. Add a small "Edit lock" toggle per chunk if it's not already there.

**Settings page (`/admin/(panel)/settings/page.tsx`):**
- All `SettingNumber` instances (`pipeline.limit`, `budget.daily_usd`, `media.scene_count`, `media.prop_count`, `video.editor.frame_regen.session_cap_cents`) become `Slider`.
- All toggles already use `SettingToggle` — verify they ALL use the same polished style.

**Stories edit page (`/admin/(panel)/stories/[id]`):**
- `category` dropdown → `ChipGroup` with one chip per category, using the cat color tokens.
- `status` button group → polish with proper "step indicator" appearance (in review → ready → publish), not just buttons.
- `duration` text input → keep as-is (read-only display, computed from audio).
- Title/source/summary/body/teleprompter text fields → keep as-is, just upgrade visual polish (focus ring, subtle background).

**SEO page (`/admin/(panel)/seo/page.tsx`):**
- `seo.theme_color` text → `ColorPicker`.
- `seo.twitter_card_type` dropdown → `ChipGroup` (Summary / Summary Large Image) with mini-preview.
- `seo.sitemap_max_age_days` stepper → `Slider`.

**Templates page (`/admin/(panel)/templates`):**
- Caption-style fields (same as Caption Style panel, but at global/category/story scope). Reuse the same components.

### 3.3 Auto-save UX

- Every form control wraps `useDebouncedSave` (new hook, 500ms).
- The hook calls the appropriate server action when the value settles.
- The `AutoSaveStatus` indicator at the top-right of each panel shows the latest save state. Color flips: muted (idle) → warn (saving) → ink (saved, 2s flash) → danger (failed).
- On error: tooltip shows the error class. The local value stays — user can retry by re-typing.
- A foreign session locks every control (reuses existing `readOnly` flag). Auto-save respects it.

### 3.4 Presets row (Caption Style only for v1)

- Horizontal scrolling row of 4–6 built-in preset cards at the top of the panel.
- Each card: a tiny rendered preview of the caption with that style + a label.
- Click → applies all fields at once with one server action (`applyCaptionStylePresetAction`).
- "Save current as preset" opens a modal: name input + apply scope (this story / category / global). Persists to settings via `setSetting("caption_presets.user", JSON)`. Survives across stories.
- Built-in presets ship in `lib/caption-presets.ts` as a typed array.

## 4. Approach (phased so each phase ships independently)

### Phase A — Foundation (the component library)
- Build `Slider`, `ColorPicker`, `ChipGroup`, `FieldRow`, `AutoSaveStatus`, `useDebouncedSave`.
- Unit tests for each via `@vitest-environment happy-dom` + `renderToString`.
- A Storybook-style demo page under `/admin/(panel)/_demo/ui` (gated by env, hidden in prod) so the UI can be tested in isolation.
- **Acceptance:** every component renders, keyboard-navigates, and has at least 3 tests pinning its contract.

### Phase B — Caption Style panel (highest-impact, single panel)
- Rewrite `CaptionStylePanel.tsx` end-to-end with the new components.
- Wire auto-save through `useDebouncedSave`.
- Build the built-in presets list (4–6 hand-tuned styles in `lib/caption-presets.ts`).
- Add `applyCaptionStylePresetAction` server action.
- Add the "Save current as preset" modal.
- **Acceptance:** the panel renders identically to a designer's mockup, every numeric field is a slider, every color field opens the new color picker, presets row is at the top.

### Phase C — Other video editor tabs
- Trim panel → unified range slider with two handles.
- Audio panel → upgrade gain slider styling.
- Overlays panel → 2D position picker for x/y.
- Metadata + Captions panels → minor polish, no structural changes.

### Phase D — Settings page
- Replace every `SettingNumber` with `Slider`.
- Polish toggle styling for visual consistency.

### Phase E — Stories + SEO + Templates pages
- Category → `ChipGroup` with cat color tokens.
- Status → step indicator.
- SEO theme color → `ColorPicker`.
- SEO Twitter card type → `ChipGroup`.
- Templates page → reuse Caption Style components.

## 5. Rejected alternatives

- **Adopt a UI library (shadcn, Radix, Headless UI).** Tempting, but every project that pulls one of these in this late ends up fighting it — the components don't match the lorewire-specific aesthetic (mono uppercase labels, accent-orange, dark surface tokens), and migrating later costs more than building right now. Rejected.
- **Ship the redesign as one big PR.** Phase A's foundation alone is testable on its own and unblocks B–E in parallel. One big PR loses that velocity. Rejected.
- **Auto-save without debounce.** Every keystroke would fire a server action. Debounced is required. Rejected.
- **Auto-save with explicit Save fallback.** Council called out cognitive overhead from layered save patterns. Pick one. Auto-save it is.
- **Storybook proper.** Big dev-dep, lots of config. A simple `/admin/_demo/ui` page covers the same need. Rejected.

## 6. Security (rule 13)

- All inputs continue to flow through the existing server actions (`saveStoryCaptionStyleAction`, `setSettingAction`, etc.). No new attack surface.
- Color picker hex input validates `^#[0-9a-f]{3,8}$` client-side AND server-side. Sliders validate `Number.isFinite + min..max` server-side.
- "Save current as preset" persists user-supplied preset names. Validate length (`max 60 chars`), reject control characters, escape on display. Stored in the settings table under a per-user key.
- Auto-save debounce + rate limiting: server action receives the same data shape as today, just more frequently. Each action already has its own session-lock + admin auth check.
- `useDebouncedSave` cancels pending writes on unmount so a user navigating away mid-edit doesn't fire a phantom save.

## 7. Observability (rule 14)

Client (`console.info`):
- `[admin ui] slider change` — `{ field, value }`
- `[admin ui] color change` — `{ field, hex }`
- `[admin ui] chip change` — `{ field, choice }`
- `[admin ui] preset applied` — `{ preset_id }`
- `[admin ui] preset saved` — `{ name, scope }`
- `[admin ui] autosave queued` — `{ field, value }`
- `[admin ui] autosave fired` — `{ field, duration_ms }`
- `[admin ui] autosave failed` — `{ field, error_class }`

Server-side: existing logs in each save action are sufficient. Add a single `[admin ui] preset_resolution` log on apply so we can debug which preset the user landed on.

## 8. Settings (rule 15)

Add **two** entries:
- `ui.admin.autosave_debounce_ms` — integer, default `500`. Tunable per-deployment if a slow connection wants 1000ms.
- `ui.admin.caption_presets_user` — JSON array of `{ name, scope, fields }`. Populated by "Save as preset" actions. Read by the presets row.

Intentionally NOT exposed:
- Color picker recents — local-storage only, per-browser. Not a server-side setting.
- Slider tick density, etc. — hardcoded for v1.

## 9. Testing (rule 18)

Unit:
- `Slider.test.tsx` — renders label + value, value updates on prop change, keyboard arrows step by `step`, clamps at min/max, calls `onChange` with the right value.
- `ColorPicker.test.tsx` — opens on swatch click, hex input round-trips, recent-colors update on selection, rejects invalid hex.
- `ChipGroup.test.tsx` — renders each chip, selected chip carries `aria-checked="true"`, click changes value, keyboard arrow navigates.
- `FieldRow.test.tsx` — renders label + children, inheritance hint shows when source ≠ default, Reset button appears when value ≠ inherited.
- `AutoSaveStatus.test.tsx` — renders state per `state` prop, transitions on prop change.
- `useDebouncedSave.test.ts` — debounces by configured ms, cancels on unmount, calls fn with latest value.

Integration:
- `CaptionStylePanel.test.tsx` — preset row renders, applying a preset fires the right action, "Save as preset" modal opens + persists.
- `actions.test.ts` — `applyCaptionStylePresetAction` validates the preset id, applies all fields, rejects unknown ids.

E2E (only if Playwright is already wired):
- Open Caption Style → click "MrBeast bold" preset → see all fields fill → see preview update.
- Drag the trim range slider → see both handles move → see Player update live.

Regression:
- Existing `CaptionStylePanel.test.tsx` (if any) stays green by keeping field IDs + action signatures stable.

## 10. Open questions

1. Color picker library or hand-roll? My bias: hand-roll a minimal one (~150 lines). A library adds a dep, conflicts with the no-glassmorphism rule, and we only need: swatch / hex / wheel / recents. Want confirmation.
2. Built-in preset list — exactly which 4–6? My proposal: MrBeast bold, Karaoke yellow, Clean white, Subtle gray, TikTok glow, Tutorial caption. Each one a real, visually distinct style. Want sign-off on the list before I commit to the names.
3. "Save as preset" — scope options. Plan says "this story / category / global". Should "this story" exist if presets are meant to be REUSED? Maybe just "category / global" is cleaner.
4. Stories page category change — making it a chip group with cat colors visually exposes the existing category palette. Confirm that's desired (vs. keeping the boring dropdown).

## 11. Rollout

- Phase A ships alone behind no flag (it's just new components, no surfaces use them yet).
- Phase B ships gated by `ui.admin.caption_style_v2` flag. Off in prod until verified end-to-end.
- Phases C, D, E ship one-at-a-time behind individual flags. Easier to roll back one surface without losing the others.
- Each phase has its own commit + Vercel deploy.

---

## Approval checkpoint

Yoav: confirm "go" and I start with Phase A — the component library. I'll also answer the four open questions before Phase B lands so we don't have to backtrack.

LLM Council pass before code? My bias: NOT this time. The scope is mostly visual/component work, and the council mostly adds value for design/architectural decisions. This plan's decisions are already concrete (specific control mappings per field). But you have rule 11 on file, so your call.
