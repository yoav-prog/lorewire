# Outsider poster test — instructions

**Purpose.** The LLM Council pass on the Phase 3 OG-card plan
(`_plans/2026-06-29-phase-3-og-poster-cards.md`) flagged that the
existing Phase 2 poster silhouette (illustration + dark band +
condensed all-caps + corner brand pill) may pattern-match to "AI
content farm" at thumb-scroll speed on Twitter — regardless of the
Bebas-not-Impact font swap. Before Phase 3 amplifies that silhouette
to every external link unfurl, we want a falsifiable answer from 3
people who don't work on Lorewire.

If the answer is "AI farm," we redesign Phase 2 first and Phase 3
inherits the new look. If the answer is "deliberate editorial brand,"
we ship Phase 3 with the current design.

**Phase 2 is already live with this poster on IG / FB / YouTube** —
so the risk is already in production. This test is to decide whether
to keep amplifying it.

## What you do (≈10 minutes)

### 1. Pick 3 published stories with strong hooks

Open the admin and pick 3 stories that:

- Are `published`.
- Have a meaningfully different tone from each other (one dramatic,
  one quieter, one with an edge-case hook — long sentence, or
  proper nouns, or a number).
- Have a scene-1 doodle (open the short editor — scene-1 is the
  first frame).

Note the 3 story IDs.

### 2. Render 3 portrait posters locally

For each story, you need its `scene_1_url` (the doodle URL) and a
poster line. The poster line is either `script.hook` (the spoken
cold-open) or — if Phase 2 has already run on this story since
yesterday's merge — `short_config.poster_text` (the dedicated LLM
line). Either works for the outsider test.

Easiest way: pull both from the admin's network tab on the short
editor page, or query the DB:

```sql
SELECT s.id, s.title,
       json_extract(sr.props, '$.doodle_frames[0].url') AS scene_1_url,
       json_extract(sr.props, '$.hook')                  AS hook,
       json_extract(s.short_config, '$.poster_text')     AS poster_text
FROM stories s
JOIN short_renders sr
  ON sr.story_id = s.id
WHERE s.id IN ('story-id-1', 'story-id-2', 'story-id-3')
  AND sr.status = 'done'
ORDER BY sr.finished_at DESC;
```

Then for each story, render the portrait poster:

```bash
cd video
npx remotion still src/Root.tsx PosterStill out.png \
  --props='{
    "scene_1_url": "<scene_1_url>",
    "text":        "<poster_text or hook>",
    "brand_text":  "LORE WIRE"
  }'
```

(`text` is the new single-prop shape from the Phase 2 social-only
refactor — see `video/src/PosterStill.tsx`.)

Rename the outputs:

```
scripts/outsider-test-images/poster-1-portrait.png
scripts/outsider-test-images/poster-2-portrait.png
scripts/outsider-test-images/poster-3-portrait.png
```

(Create the `outsider-test-images/` folder if it doesn't exist.)

### 3. Open the mockup

```bash
# Mac
open scripts/outsider-poster-test.html
# Windows
start scripts\outsider-poster-test.html
```

The page shows the 3 posters twice:

- **Top half** — center-cropped to landscape inside a Twitter / X
  card (the way Twitter actually unfurls them today, with no
  landscape variant).
- **Bottom half** — full portrait, the way Discord / iMessage /
  WhatsApp render them.

There's a feed of dummy tweets between the Lorewire ones so the
posters land IN CONTEXT, not in isolation.

### 4. Share with 3 outsiders

Send each outsider a screenshot of the page (or the local file
zipped — whatever they can open). Ask the three questions printed
at the top:

1. What kind of account / publisher does this look like?
2. Would you click any of these in your feed? Why or why not?
3. What does the red logo pill + dark text band remind you of?

Don't prime them — no "this is mine," no "I'm wondering if it looks
spammy." Just send and ask.

### 5. Bring back the verdict

Three possible outcomes:

- **All three say "AI farm" or some flavor of "low-trust content"** →
  redesign Phase 2 visual register first (whitespace, masthead
  typography, no band overlay per the Outsider council voice), then
  Phase 3a inherits the new look.
- **Mixed reactions** → some legit concern; tweak the design
  (likely the band or the brand pill specifically) before Phase 3a.
- **All three read it as "real publisher" / "editorial brand"** →
  Phase 2 design is good; ship Phase 3a as planned.

## Notes

- The mockup is intentionally minimal CSS — no Twitter trademarks,
  no Discord logos, just enough visual context that the posters
  read as "links unfurling in a feed" rather than "an asset shown
  in isolation."
- If you'd rather use a real Twitter draft tweet for the test
  (drafted but not posted), that works too — paste a story URL into
  the compose box, wait for the unfurl preview, screenshot it.
  Same data. (Won't work for Phase 3 cards until Phase 3a ships, so
  for THIS test the local mockup is fine.)
- This test costs nothing — no LLM tokens, no Cloud Run renders.
  Just `npx remotion still` × 3 locally.
