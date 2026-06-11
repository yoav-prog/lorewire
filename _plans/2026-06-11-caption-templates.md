# Wave 3 Phase 1: Caption template + admin editor

Date: 2026-06-11
Status: in progress
Section in handoff: 3.x (Wave 3 of the visual system, scope chosen "Template + caption controls only")

## Goal

A single named "Caption template" the admin can edit from `/admin/templates`
that controls every caption-rendering knob the Remotion composition currently
hardcodes. Per-category and per-story override layers are Phase 2 — same data
shape, just a second tier in the resolver, deferred to keep this ship small.

## Decisions (locked)

- **Storage = the existing `settings` table** with the prefix
  `caption.<field>`. Keeps the migration to one row per field (no new table)
  and matches how `media.scene_count`, `video.ken_burns`, etc. already live.
- **Tier 1 only**: a single global template. Admin edits "the" caption
  template, no naming/scoping UI. The resolver still has the per-category
  and per-story slots ready (Phase 2 just fills them in).
- **Admin page = new `/admin/templates`** in the existing panel layout.
  Grouped form: position & sizing, typography, color, animation, with a live
  preview that mirrors the Remotion composition's caption styling.
- **Composition reads from props**, not constants. `caption-style.ts` stops
  holding hardcoded values and exposes `resolveCaptionTemplate(partial)` that
  fills defaults the same way it did before, so a missing field still ships
  the doodle-yellow look.
- **Pipeline = single new resolver in `pipeline/video.py`** that pulls every
  `caption.*` setting and embeds them as `props.caption_template`. Tests
  cover the resolver (defaults, mixed override, malformed values).

## Fields in scope (every knob `DoodleCaptionChunk` currently uses)

Numbers and enums; everything stores as TEXT in `settings` and gets parsed:

- **Position & sizing**:
  `caption.position_y` (number 0-1, default 0.55),
  `caption.size_scale` (0.1-3, default 1),
  `caption.padding_x` (0-200, default 64).
- **Typography**:
  `caption.text_transform` (`uppercase | none | lowercase`, default uppercase),
  `caption.letter_spacing` (number, default -0.5),
  `caption.line_height` (number, default 1.05),
  `caption.font_weight` (100-900, default 900).
- **Color**:
  `caption.color` (hex, default #facc15),
  `caption.outline_color` (hex, default #0f172a),
  `caption.outline_width` (0-12, default 6),
  `caption.active_word_color` (hex, default #ffffff),
  `caption.spoken_word_color` (rgba/hex, default rgba(250,204,21,0.45)).
- **Animation**:
  `caption.entry_effect` (`none | fade | pop | slide-up`, default fade),
  `caption.word_highlight` (`none | karaoke | color | scale`, default karaoke).

That's 14 fields, all backwards-compatible with what the composition already
expects (matches `ResolvedDoodleCaptionStyle` in `video/src/caption-style.ts`).

## What changes

### Pipeline

- `pipeline/video.py` gains `_resolve_caption_template()` that walks the 14
  settings keys, parses numerics + enums with defaults, returns a dict.
  Result is embedded under `props.caption_template`.
- Tests in `pipeline/tests/test_video.py` cover: all-defaults, partial
  override, malformed value falls back to default + logs a warning.

### Remotion composition

- `video/src/types.ts` `ShortVideoConfig` gains an optional
  `caption_template?: Partial<ResolvedDoodleCaptionStyle>`.
- `video/src/caption-style.ts` exports `DOODLE_CAPTION_DEFAULTS` plus a new
  `resolveCaptionTemplate(partial)` that does the same job
  `resolveDoodleCaptionStyle()` would do in yt-studio (every field falls
  back to the default when the prop is missing). The existing default
  constants are reused so the look stays identical when no admin override
  is set.
- `DoodleShort.tsx` calls `resolveCaptionTemplate(config.caption_template)`
  once and passes the resolved style into the existing `DoodleCaption`
  component. Zero behavior change when `caption_template` is absent.

### Admin

- New page `/admin/(panel)/templates/page.tsx` server-rendered, behind
  `requireAdmin()`. Grouped form for the 14 fields, each saved through a
  new `saveCaptionTemplateAction()` server action that writes one
  `setSetting()` call per changed field.
- The form has a **live preview pane** that renders the same caption
  styling as the composition (mirrors `DoodleCaptionChunk` styling minus
  the Remotion-specific timing) so the admin sees the effect of every
  change before saving.
- `AdminNav.tsx` gets a "Templates" link.

## Observability (rule 14)

- Saving the template logs `[admin caption-template save]` with the keys
  whose values actually changed (so server logs show the diff without
  leaking the raw values).
- `pipeline/video.py` logs `[video id=<id> caption-template]` with the
  resolved field count when the props are written, so a render that
  surprises the admin can be traced back to which template fields
  applied.

## Cost + security

- **Cost**: zero. Settings reads / writes only. No new API calls.
- **Security**: all fields go through the existing `setSetting()` which is
  behind `requireAdmin()`. Numeric fields validated in the resolver before
  they reach Remotion (no string-to-CSS injection — invalid values fall
  back to defaults).

## Tests (rule 18)

- `pipeline/tests/test_video.py`: `_resolve_caption_template` defaults,
  partial override, malformed value handling. ~5 new cases.
- No React/Remotion render tests; the composition is visual.

## QA plan (rule 6)

1. `python -m unittest discover -s pipeline/tests` stays green.
2. Type-check + production build pass.
3. `/admin/templates` renders with the 14 default values; saving a single
   field round-trips correctly.
4. `python -m pipeline.video envelope` writes
   `video/.props/envelope.json` with the new `caption_template` field.
5. Render envelope locally; visually verify the captions still hit the
   default doodle-yellow look.
6. Change `caption.color` in admin to `#00ff00` (lime green); re-render;
   confirm the captions now render in lime green.

## Phase 2 (deferred, same data shape)

- Per-category settings: `caption.cat.<category>.<field>`.
- Per-story settings: `caption.story.<id>.<field>`.
- Resolver walks story -> category -> global -> defaults.
- Admin UI: dropdown to pick scope on the template page.
- The data + composition stays the same; just two more dictionary reads
  in `_resolve_caption_template()`.

## Phase 3 (multi-week, deferred per the earlier roadmap)

- Motion beats (mouth-swap, micro-wiggle, label-pop, prop-slide,
  scribble-draw): needs the Atlas mouth-removal pass + character cache
  + the new Remotion layers. Separate plan.
