# Stories rail: desktop layout fix

Date: 2026-06-25
Status: hotfix for PR #79/#80 desktop layout regression
Predecessor: _plans/2026-06-25-stories-rail-and-viewer.md

## Problem

PR #79 shipped the Stories rail above the Hero on desktop with
`className="pt-20"` to clear the fixed TopNav. This pushed the Hero
~180px down (rail's own padding + circles + caption + pt-20),
breaking the full-bleed hero composition. On a 900px viewport the
user sees ~720px of hero — only the forehead of the artwork is
visible, the rest is dark whitespace + rail + nav. Mobile was
unaffected (no fixed top nav competing for space).

User feedback: "looks really bad on desktop... find a much cleaner,
beautiful UI UX friendly way to show stories without breaking the
desktop layout like this. It's fine on mobile."

## Chosen approach

Move the desktop rail OUT of the above-hero band and INTO the
content area, where it lives as the FIRST rail (above Continue
Watching). The Hero gets its full-bleed layout back. The rail
adopts the page's section/title design system so it visually fits
with the other rails (Continue Watching, Top 10, category rails).

### What changes

1. `components/stories/StoriesRail.tsx` — add optional `title?:
   string` prop. When set, the rail renders inside the page's
   design-system shell: `<section className="mt-11">` + `<h2>` title
   row + `max-w-[1600px] mx-auto px-10` content alignment. Matches
   the `Rail()` wrapper used by every other desktop rail. No
   prev/next chevrons (circles are too small for the chevron weight
   to read well). Mobile leaves `title` unset and gets the original
   bare-row presentation.

2. `components/DesktopShell.tsx` — move the `<StoriesRail>`:
   - Out of above-hero (drop `className="pt-20"`).
   - Into the content area, as the FIRST rail inside
     `<div className="relative -mt-20 z-10">`, with `title="Stories"`.
   - Hero is restored to its previous position (first thing in the
     return), full-bleed.

3. `components/AppShell.tsx` — **no change**. Mobile placement was
   correct; user explicitly said mobile is fine.

### What does NOT change

- The viewer overlay (StoriesViewer) is unaffected.
- The `?wire=<id>` deep link still works the same way.
- The viewed-state filter still hides the rail when all-seen.
- Mobile rail still sits above the Billboard, same as before.

## Why this approach

- **Hero stays full-bleed.** The original Netflix-style composition
  is preserved. The user's primary above-the-fold artwork is
  uncompromised.
- **Design system consistency.** Every other rail uses the same
  `<section><h2>...<content-width-container>` shell. The Stories
  rail joins that pattern rather than floating outside it.
- **Discoverability.** "Stories" as the first rail (above Continue
  Watching) still gets prime real estate — users naturally scan
  the first row below the hero. Not above the hero, but still
  immediate.
- **Zero risk to the Hero rotation work.** PR #71/#72 + the recent
  mobile-hero-rotation (PR #78) all assume the Hero is the
  top-most layout element. Restoring that invariant is the
  cleanest possible interaction.

## Alternatives considered

- **B — Float the rail OVER the Hero with a scrim.** Cleaner
  visually if executed well, but adds visual competition with the
  hero artwork + title and requires careful scrim tuning per hero
  image. Higher risk for diminishing return.
- **C — Move it to a vertical right-side panel.** Different pattern
  from mobile, eats horizontal real estate, doesn't match any
  existing surface on the site. Rejected.
- **D — Restyle the rail smaller and keep above-hero.** Even a
  compact 100px-tall band still pushes the hero. Rejected — the
  problem is *position*, not *size*.

## Security / observability

- No new data flow, no new endpoints.
- `[stories rail mount]` log gains a `presentation: "mobile" |
  "desktop"` field so the log clearly identifies which layout
  rendered.

## Testing

- Manual QA on Vercel preview:
  - Desktop homepage: Hero is full-bleed at the top, Stories
    section appears below it with the "Stories" h2 title, lined up
    with the other rails. Tap a circle → viewer opens. Refresh
    after viewing — rail hides cleanly when all-seen.
  - Mobile homepage: rail still above the Billboard, no title, no
    visual change.
- Existing tests (44 stories + 96 rails + 1852 total) stay green
  — only the layout JSX moves, no logic changes.

## Deploy (rule 19)

- Branch: `feat/stories-desktop-layout` off
  `origin/feat/multi-platform-shorts-publisher` (already done via
  worktree).
- PR target: `feat/multi-platform-shorts-publisher` (production
  source, inverted-state rules).
- Vercel: **do not click "Promote to Production" / "Redeploy" /
  "Rebuild"** on the preview — merge into production-source is the
  only deploy trigger.
