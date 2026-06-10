# LoreWire — design generation prompts (dark Netflix + doodle)

Direction: a dark, cinematic, mobile-first streaming app for true internet stories. Lean-back browse (billboard + rails + posters), tap to a title page, then Watch (doodle video) / Read (Article or Gallery) / Read-along (word-sync teleprompter). The app shell is dark and minimal. **Thumbnails are dark cinematic posters (not doodle frames).** The doodle video blends hand-drawn doodle with **realistic, cinematic elements and atmosphere** (cinematic backgrounds and lighting, some motion), not flat white-canvas only. LoreWire keeps its name; vermilion is the one signature color.

## Design tokens

**Fonts**
- Display / wordmark / hero & poster titles: **Archivo** 700-900, tight (-0.02em), poster titles UPPERCASE
- UI / body: **Hanken Grotesk** 400-800
- Micro labels / durations / kickers: **Spline Sans Mono**, uppercase, wide tracking
- Doodle video captions (hand-drawn): **Caveat** 600-700
- Never: Inter, Poppins, Montserrat, Roboto, system-ui as a primary face

Google Fonts:
`https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Caveat:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap`

**Color — app shell (dark cinematic)**
- bg `#0A0A0C` · surface `#15141A` · surface-2 `#211F29` · hairline `rgba(255,255,255,.085)`
- text `#F5F3EF` · muted `#8E8A97` · accent/signature **vermilion `#E8462B`**
- category accents: Drama `#9B3A30` · Entitled `#C06234` · Humor `#C9A227` · Wholesome `#2C7E78` · Dating `#A8466A` · Roommate `#5B3B8A` · Lists `#4C7A53`

**Color — doodle video content (light, hand-drawn)**
- canvas `#FBFAF4` · ink/marker `#1A1714` · accent `#E8462B` · highlighter `#FFD84D`

---

## Prompt 1 — Google Stitch

```
ROLE & CONTEXT (zoom out)
You are an award-winning product designer for a dark, cinematic, mobile-first streaming app called LoreWire. LoreWire is "Netflix for true internet stories": real Reddit stories rewritten into originals and offered as a 1-3 minute hand-drawn video, a readable article, or a read-along (narration with word-by-word highlight). Audience: 22-40, scrolling in spare moments. Feeling: cool, minimal, fun, fast, premium streaming app. NOT a magazine, NOT a generic SaaS template, and NOT a literal Netflix clone — it has one signature: a vermilion accent and a hand-drawn doodle content style.

GLOBAL STYLE
- Dark shell: background #0A0A0C, surfaces #15141A / #211F29, hairlines rgba(255,255,255,.085), text #F5F3EF, muted #8E8A97. ONE accent: vermilion #E8462B.
- Type: titles + wordmark in "Archivo" 800-900, tight tracking, poster titles UPPERCASE. UI/body in "Hanken Grotesk". Durations/labels in "Spline Sans Mono" uppercase. NEVER Inter/Poppins/Montserrat/Roboto.
- Category accent colors: Drama #9B3A30, Entitled #C06234, Humor #C9A227, Wholesome #2C7E78, Dating #A8466A, Roommate #5B3B8A.
- Layout: edge-to-edge imagery, minimal chrome, big poster art, very little body text on browse (titles ride on the artwork like Netflix box art). Rounded 8-12px cards. Bottom tab bar.
- Motion: card press-scale, snap-scrolling rails, slide-up title sheet, slow ken-burns on the billboard. Restrained, premium.
- HARD BANS: no glassmorphism, no purple/blue gradients, no gradient text, no glowing buttons, no floating 3D blobs, no emoji as UI, no heavy text labels cluttering the browse.

SCREENS (zoom in, vertical mobile, ~390px)
1) Home: a full-bleed billboard at top (drifting art, a small "LW ORIGINAL" kicker, a big UPPERCASE Archivo title, 3 dot-separated tags, white Play + translucent More Info buttons, a "Play Something" shuffle). Scrollable category pills under the header (All, Drama, Entitled, Wedding, Roommate, Dating). Then rails: "Continue Watching" (posters with a thin vermilion progress bar), "Top 10 Today" (huge outlined rank numerals beside each poster), genre rows, "New on LoreWire". Posters are portrait, art-forward, title baked on the artwork, tiny mono duration badge. Bottom nav: Home / Search / New / My List.
2) Title page: full-bleed hero still with a big circular Play; back button. Below: UPPERCASE Archivo title; a meta row ("97% Match · 2026 · 1:42 · TRUE · category"); a big white Play button; a row of My List / Rate / Share icon buttons; a short synopsis; then a tab strip — Watch | Read | Read-along — with a vermilion underline on the active tab. A "More Like This" poster row at the bottom.
3) Watch panel: shows the doodle-explainer video frame — a bright vertical card, white canvas #FBFAF4, thick uneven black ink doodle (e.g. an envelope reading "$800"), a tilted polaroid photo, and a yellow (#FFD84D) highlighter label in a hand-drawn "Caveat" font. Calm, low motion. Caption: "Doodle Explainer · vertical".
4) Read panel: a segmented toggle "Article | Gallery". Article = dark reading view, large Archivo headline, body in Hanken Grotesk, a drop cap, an inline illustration with a mono credit, a pull quote, and one "From the original thread" source block (a surface card with a vermilion left border, a short italic quote, and "u/username · r/subreddit · date · View source"). Gallery = full-width swipeable image+text cards with a big hand-drawn numeral on each and progress dots beneath.
5) Read-along panel: a player bar (round vermilion play button, a waveform of thin bars, a mono timecode), then the script in large type where each word lights up from muted grey to white as it is spoken, the current word boxed in vermilion.

Generate all five as one cohesive dark system. Prioritize cinematic minimalism, big art, tiny text, and the one vermilion signature.
```

---

## Prompt 2 — Claude (interactive artifact)

```
You are an award-winning product designer and front-end engineer. Build, as a single self-contained interactive artifact (HTML + Tailwind, mobile-first, framed like a ~390px phone), the UI for LoreWire — a dark, cinematic "Netflix for true internet stories" app. Each story is a 1-3 min hand-drawn video, a readable article, or a read-along with word-by-word highlight.

FONTS ARE MANDATORY. Do NOT use system-ui, Inter, Poppins, Montserrat, or Roboto except as a last fallback. Load in <head>:
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Caveat:wght@600;700&family=Hanken+Grotesk:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">
CSS variables, used everywhere:
--display:'Archivo',sans-serif;  /* wordmark, hero + poster titles, big numerals — heavy, tight, UPPERCASE titles */
--body:'Hanken Grotesk',sans-serif;
--mono:'Spline Sans Mono',monospace;  /* durations, kickers, timecodes */
--hand:'Caveat',cursive;  /* doodle video captions only */
If a font fails to load the design is wrong — verify the families render.

PALETTE
Shell (dark): --bg #0A0A0C, --surface #15141A, --surface2 #211F29, --line rgba(255,255,255,.085), --text #F5F3EF, --muted #8E8A97, --accent #E8462B (vermilion, the only accent). Category accents: Drama #9B3A30, Entitled #C06234, Humor #C9A227, Wholesome #2C7E78, Dating #A8466A, Roommate #5B3B8A.
Doodle content (light): canvas #FBFAF4, ink #1A1714, accent #E8462B, highlighter #FFD84D.

LOOK
Cinematic and minimal: edge-to-edge poster art, almost no body text on browse (titles baked onto the artwork like Netflix box art), 8-12px corners, a bottom tab bar, one vermilion signature. It must read as a sleek streaming app, NOT a magazine, NOT a generic template, and NOT a literal Netflix clone.

AVOID (the AI/clone tells): glassmorphism, blur panels, purple/indigo or blue gradients, gradient text, glowing buttons, 3D blobs, neumorphism, emoji as UI, walls of caption text under every thumbnail.

DELIVER, in one artifact with working interactions:
1) Home: drifting full-bleed billboard (LW ORIGINAL kicker, big UPPERCASE Archivo title, tags, Play + More Info, a "Play Something" shuffle), scrollable category pills, and rails: Continue Watching (vermilion progress bars), Top 10 Today (huge outlined rank numerals), a genre row, New on LoreWire. Portrait, art-forward posters with the title on the artwork and a tiny mono duration badge.
2) Tapping a poster slides up a title page: hero still + circular Play, UPPERCASE title, meta row (Match % · year · runtime chip · TRUE · category), big Play, My List / Rate / Share, synopsis, then tabs Watch | Read | Read-along (vermilion underline on active), and a More Like This row.
3) Watch: render a doodle-explainer frame — bright vertical card, white #FBFAF4 canvas, thick black ink doodle (envelope reading "$800"), a tilted polaroid, a yellow #FFD84D highlighter label in Caveat. Calm, low motion.
4) Read: a working "Article | Gallery" toggle. Article = dark reading view with Archivo headline, Hanken body, drop cap, one inline illustration + mono credit, a pull quote, and one "From the original thread" source card (vermilion left border, short italic quote, "u/username · r/subreddit · date · View source"). Gallery = horizontally swipeable image+text slides, each with a big hand-drawn numeral, plus progress dots.
5) Read-along: a player (round vermilion play, a waveform, a mono timecode) and a large script where words light up grey→white as "spoken" on a timer, the current word boxed in vermilion. Make play actually animate the highlight.
6) A bottom tab bar: Home / Search / New / My List, with the active item in vermilion.

Use real, believable story titles in the categories (NOT lorem ipsum). After the artifact, write 4-5 sentences on the type, color, and motion choices and how this stays cinematic without becoming a Netflix clone.
```

---

## Prompt 3 — Logo (Archivo, dark)

The wordmark moves from Fraunces (old editorial direction) to **Archivo** to match the app.

```
A bold, confident wordmark logo for a streaming app called "LoreWire", set in camel case in a heavy, slightly condensed geometric grotesque sans (Archivo Black / Archivo 900 spirit), tight tracking. Warm off-white (#F5F3EF) lettering on a near-black (#0A0A0C) background, with a single small vermilion-red (#E8462B) dot as the tittle above the "i" as the only color. Clean, modern, premium streaming-brand feel. Flat vector, crisp, horizontal, no gradients, no shadows, no underline, no mockup.
```

Avatar:
```
A minimal app avatar for "LoreWire": the monogram "LW" in a heavy geometric grotesque sans (Archivo Black spirit), warm off-white (#F5F3EF) on a solid near-black (#0A0A0C) background that fills the entire square (no circle on white), with one small vermilion-red (#E8462B) dot accent above the letters. Centered with padding for a circular crop, legible at 32px. Flat vector, no gradients, no shadow, no mockup.
```
