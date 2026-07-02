# Poster meta corner split: category + duration chips

Date: 2026-07-02
Status: implemented (this session), not yet committed

## Problem

The poster thumbnails show two meta badges over the artwork: the
category label (top-left) and the duration (top-right). Both lived in
the same top strip. The granular taxonomy (PR5 read-path flip) made
labels up to 20 characters ("Money & Inheritance", "Malicious
Compliance"), and at 9px mono with .18em letter-spacing that is ~133px
of text on a 132px-wide mobile card. Result on both mobile and
desktop rails: the label wrapped into two ragged lines, drifted into
the duration badge, and read as broken. The weak 32% black chip
background made it worse over bright artwork.

## Goal

Both values stay on the poster, always readable, with zero chance of
wrap or collision at any card width (132px mobile rails, 110x68 search
thumbs, 144-220px desktop cells), without touching the baked-in title
area at the bottom center.

## Chosen approach: corner split via a shared PosterMeta component

New `src/components/PosterMeta.tsx`, used by both PosterArt
implementations (AppShell + DesktopShell), replacing the duplicated
badge markup that had already started to drift between shells.

- Category: top-left, alone on its row, so long labels get the full
  card width on a single line. 8px mono caps, .07em tracking (down
  from .18em, which was the width killer), solid `bg-black/65` +
  `backdrop-blur-sm` chip, and a 2px left border in the category's
  taxonomy color (`categoryVisual`) for identity at a 2px width cost
  instead of a dot + gap. `truncate` + `max-w-[calc(100%-16px)]` is
  the safety net for admin-added labels longer than the card.
- Duration: bottom-right, the universal video-thumbnail position
  (YouTube/TikTok convention, instantly parsed), same chip family,
  9px tabular-nums. Sits over the artwork's existing bottom-up
  gradient, so it needs no extra scrim.
- The two chips no longer share an axis, so collision is impossible
  by construction rather than by tuning.

Layout neighbors checked: Top 10 rank numeral (bottom-LEFT, both
shells), vote-count chip (bottom-left), progress bar (bottom edge,
same 1px kiss the vote chip already ships with), RatingBadge (right,
top 28/30 — now reads as a second row under the category line; its
old reason for sitting low was clearing the top-right duration, and
leaving it put keeps it collision-free with the category chip).

## Alternatives rejected

1. One-row meta bar with truncation (flex justify-between, category
   truncates next to duration): only ~9 characters survive on a 132px
   card ("MONEY & I..."), unreadable for half the taxonomy.
2. Drop the category from posters entirely (Netflix-style bare art):
   cleanest visually, but loses real information in mixed rails (Top
   10 Today), and the user asked for both values displayed.
3. Short-label mapping per category ("Money", "Friendships"): needs a
   new data field across 18 categories plus admin CRUD, and
   admin-added categories would still have no short label. Too much
   machinery for a badge.

## Security

No new data, no new inputs, no auth surface. Pure presentational JSX
over already-public catalog fields.

## Observability

No new logs: the chips are static markup with no state transitions or
failure paths. The existing `[lorewire poster err]` hero-image
fallback log is untouched.

## Settings audit

Not exposed as a setting: badge placement is core visual grammar of
the product (like where YouTube puts durations), not a preference a
user would want to flip. No settings layer change.

## Testing

`src/components/PosterMeta.test.tsx` (vitest + happy-dom, mirrors
homepage-rails.test.tsx): renders both chips; single-line truncate +
width cap (the regression that caused this fix); opposite-corner
anchoring; category color keying incl. unknown-category fallback;
empty-value guards; duration-only render for `kicker={false}`.
7 tests green. Pre-existing failures elsewhere in the suite
(privacy-terms legal entity, personal-data schema list, aspect DIMS,
one bulk-content action) do not import the poster components and
predate this change.

## Deploy

Rides the normal flow: feature branch -> PR -> merge to main ->
Vercel auto-deploy. No env, config, or schema changes. Note: this
session's working tree is on `feat/per-category-settings-granular`,
which also carries unrelated in-progress admin-settings work — stage
only the four poster files when committing this piece.
