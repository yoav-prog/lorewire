# LoreWire — Architecture & Validation Plan

**Date:** 2026-06-10
**Owner:** Yoav (build) · Amir & Amit (product/stakeholders)
**Status:** Draft for review. No production code until this is approved.

---

## 1. Summary

LoreWire is a mobile-first, Netflix-style app for true internet stories. Each story is sourced from Reddit but **rewritten and transformed** into an original piece, never copied verbatim, and offered in three ways: a short **doodle-explainer video** (1 to 3 minutes), a **readable article** (with original illustrations and one styled source block), and a **read-along teleprompter** that highlights words in sync with narration. The content engine reuses two existing Aporia codebases. We do not build volume until a small batch proves real humans come back.

## 2. Goals & success metric

- **Primary metric (validation):** do real readers return? Measured by 7-day return rate and average session depth on a hand-made batch.
- **Product goal:** genuinely good, bingeable stories that build an audience, not a clickbait/arbitrage farm (per Amit's direction).
- **Business goal:** an owned content brand that can also feed syndication (MSN) from the same upstream pipeline.
- **Out of scope for v1:** hundreds/day automation, recommendation personalization, accounts/social features.

## 3. The product

A dark, cinematic, lean-back browse (billboard + rails + posters), tap a poster to a title page, then choose how to consume:

- **Watch** — a 1-3 min vertical video in the doodle-explainer style, **blended with realistic and cinematic elements and atmosphere** (hand-drawn base + cinematic backgrounds, lighting, some motion). Richer than flat doodle, so it costs more than the near-static figure (see Section 7); pin the exact blend on the 3 samples.
- **Read** — the article, with two sub-modes: **Article** (flowing text + inline illustrations + one "From the original thread" source block) and **Gallery** (swipe image+text cards, the listicle format).
- **Read-along** — teleprompter with word-accurate highlight synced to the narration audio.

Built for the lazy user (rule 10): obvious on first open, usable in a spare two minutes, no friction. Mobile is the primary target; desktop is responsive.

## 4. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Name | **LoreWire** (lorewire.com, verified free) | Strong, available, zero rebrand churn |
| Front end | **Next.js** (App Router) | Matches youtubestudio; strong SEO + RSC |
| Look | **Dark, purely-Netflix shell** + bright doodle content | Cinematic browse; distinctive contrast |
| Video style | **Doodle Explainer** (`doodle_explainer_2`) | Proven Reddit-story genre; reuses youtubestudio |
| Image gen | **kie.ai gpt-image-2 (default) → nano-banana-2 (fallback)**. No Atlas | Per user direction |
| Teleprompter + video | Reuse **youtubestudio** (Remotion + Google-STT forced alignment + TTS) | Hard parts already built |
| Upstream logic | Reuse **Amir's scripts** (scrape/ideas/research prompts), rebuild plumbing | Keep value, fix coupling+secrets |
| Source of truth | **Postgres** + a **Google Sheet** as the human control panel | Survives scale; humans still steer |
| CMS / admin | **Custom, built into the Next.js app** (on Postgres) | The admin panel (5A) *is* the CMS; content is pipeline-generated, not hand-authored; no second server. Matches youtubestudio |
| Rollout | **Validation-first**, then 10-30/day, then scale | Council verdict; prove before spend |

## 5. Architecture

```
Reddit ──(Decodo proxy)──► [Scrape] ──► Postgres (raw posts)
                                          │
        Google Sheet (control panel) ◄────┤  steer categories/subreddits, approve/reject
                                          ▼
[Ideas]──►[Research (anti-fabrication)]──►[Script]
                                          ▼
        ┌──────────────── per story ──────────────┐
        │ Narration (TTS) ──► Forced alignment      │  word timing for teleprompter
        │ Doodle frames: kie gpt-image-2 (base)     │
        │   └► sibling edits: nano-banana-2/edit    │  no Atlas
        │ Remotion render (1-3 min vertical video)  │
        └───────────────────────────────────────────┘
                                          ▼
                       Object storage (images/audio/video)
                                          ▼
          Next.js app on Vercel (public site + custom admin/CMS + API)
```

**Reuse map:**
- **youtubestudio** (Next.js + Remotion + TS): teleprompter (`src/components/narrator/`), forced alignment (`src/lib/tts/aligners/google-stt.ts`), doodle style (`doodle_explainer_2`, `src/remotion/`, `src/lib/short-styles.ts`), TTS lanes.
- **Amir's scripts** (Python): Decodo scraper, idea generator, research stage with hard "use only the real post, invent nothing" rules. These move to env-based secrets and write to Postgres instead of Sheets.
- **newturbovid** (Python): not used directly; a simpler image+VO bulk tool. Reference only.

**Infra choices** (object storage, Remotion rendering, Postgres hosting) are resolved in Sections 5B and 13.

## 5A. Admin & control panel

A single role-gated internal admin built into the Next.js app — this **is** the CMS (no separate Strapi). The team runs everything here without touching code. A thin slice (review queue + publish + model defaults) ships in P0; the full panel lands in P1.

**A. Content & articles**
- **Pipeline board:** every story as a card moving through stages (Scraped → Idea → Researched → Scripted → Video → Review → Published), with status, owner, cost-so-far, and failure flags.
- **Review queue:** approve / reject / edit. Inline edit of title, deck, body, gallery slides, thumbnail, tags, category.
- **Publish controls:** publish / unpublish / schedule; **"hidden" vs "in menu"** (Amir's daily front-page articles that aren't in the nav); feature on the billboard; pin to a rail.
- **Regenerate actions:** re-run any single stage for one story (new script, new images, re-render video, re-narrate) without redoing the rest.
- **Dedup:** near-duplicate detection + flag; merge or skip.
- **Bulk actions:** approve / publish / retag / delete many at once.

**B. Design & layout**
- **Theme tokens editor:** the design-system colors and fonts (Section 11) as editable variables with live preview.
- **Thumbnail style toggle:** doodle key-frame vs cinematic, global or per-category (settles the Section 13 question at runtime).
- **Homepage composer:** which rails appear, their order and titles, and the category/query feeding each (Continue Watching, Top 10, genre rows, New); choose the billboard story.
- **Category manager:** names, accent colors, icons, order.
- **Video style settings:** motion level, palette, label style, aspect, intro/outro for the doodle style.

**C. Model defaults & routing (per stage)**
- Editable **default + fallback chain per stage:** images (gpt-image-2 → nano-banana-2), LLM for ideas/research/script, TTS voice/lane, alignment.
- **Models are config, not env.** Model choices live in a registry (`config/models.json`) plus a DB selection, edited via the admin picker (no model env vars). API keys/credentials stay in the environment/secret manager and are never editable in the UI.
- **Voiceover:** ElevenLabs + Google Cloud TTS (reused from youtubestudio). Pick a voice **per video**, or set a **default for all** and **per-category** defaults; premium voices are cost-gated.
- **Cost band shown per model** (like youtubestudio's picker) with a **cost-gate** that asks for confirmation above a threshold.
- **Per-category overrides** (cheaper models for low-priority categories).
- **"Save money" mode** (Amir's `SAVE_MONEY` flag): lower-cost models + fewer frames.

**D. Pipeline & sourcing**
- Categories + subreddits to scrape (mirrors the Google Sheet panel — one source of truth), sort/time filters, per-category amount.
- Cadence/schedule, **daily volume caps**, concurrency limits, retry/backoff policy.
- Per-stage enable/disable and pause.
- **Prompt template manager:** edit the ideas/research/script/image prompts, **versioned**, with a test-run on a sample post before saving.

**E. Cost, usage & safety**
- **Spend dashboard:** per day / stage / model / category; per-article cost; projected monthly vs budget.
- **Budget caps + alerts**, and a hard **kill switch / pause-all** (the runaway + deindex backstop from Section 10).
- **Moderation controls:** thresholds, subreddit/keyword blocklists, PII rules, attribution defaults.
- **Observability:** queue depth, render status, failures with namespaced logs, retry view.

**F. Access & audit (rule 13)**
- Roles: **Owner / Editor / Reviewer**; least privilege (only Owner changes models, budgets, prompts).
- **Audit log** of who changed what (models, budgets, publishes, prompt edits).

## 5B. Hosting & infrastructure

Mostly Google Cloud (we already own it), best-of-breed for the two edges, all behind Cloudflare.

| Layer | Choice | Notes |
|---|---|---|
| DNS / CDN / WAF | **Cloudflare** | Fronts the app and the GCS media |
| Front end | **Next.js on Vercel (Pro)** | Best Next.js host; matches youtubestudio. Cloud Run is the single-cloud alternative |
| Media storage | **Google Cloud Storage** | Already owned; Cloudflare CDN in front. Behind a media-bucket abstraction (R2-swappable) |
| CMS / admin | **Built into the Next.js app** (Vercel) | No separate service; reads/writes Cloud SQL directly |
| Database (source of truth) | **Cloud SQL for Postgres** | + Google Sheet control panel synced to it |
| Pipeline (Python) | **Cloud Run jobs + GCE worker** | Co-located with GCS (no read/write egress) |
| Video render | **Remotion on AWS Lambda** | Reuse youtubestudio; Cloud Run alt for zero-AWS |
| AI services | kie.ai (gpt-image-2 → nano-banana-2), ElevenLabs + Google TTS, Google STT/ElevenLabs align, LLMs, Decodo | API calls |

Flow: `Reddit → Decodo → Cloud Run pipeline → Cloud SQL ⇄ Sheet → (kie/TTS/STT assets) → Remotion Lambda → GCS → Next.js/Vercel (public + admin/CMS, reads Cloud SQL) → Cloudflare → users`.

## 6. Content & legal posture

- **Transform, don't copy.** Every story is rewritten with an original angle; illustrations are original doodles; verbatim Reddit text is never republished as the body.
- **One styled "From the original thread" block** per article (our own type/colors, short quote + attribution + link), used only where authenticity matters. No raw Reddit embeds as filler.
- **Anti-fabrication** is enforced at the research stage (already in Amir's prompts): no invented facts, names, or outcomes.
- **PII / harmful content gate:** strip or fictionalize real names; never feature minors; a moderation pass on source posts (the youtubestudio/MSN policy text is a starting point) and on output.
- **To verify before launch (rule 1):** Reddit Data API / ToS limits on commercial derivative use; FTC AI-content disclosure; the **commercial-license terms of gpt-image-2 and nano-banana output** (can we monetize generated images, with what attribution). Flag to legal, do not assume.

## 7. Cost model (verified pricing, June 2026)

Per-unit, from live sources:

- **kie.ai gpt-image-2:** token-based, ~**$0.04 (portrait/medium)** to ~$0.17 (high) per image. [[kie.ai/gpt-image-2](https://kie.ai/gpt-image-2)]
- **kie.ai nano-banana-2:** from ~**$0.04/image**; standard nano-banana ~$0.02; Pro $0.09 (1-2K)/$0.12 (4K). [[kie.ai/nano-banana-2](https://kie.ai/nano-banana-2)]
- **Remotion Lambda:** a few cents per render; multi-minute renders "a few pennies," complex example ~$0.02. [[remotion.dev cost](https://www.remotion.dev/docs/lambda/cost-example)]
- **Decodo scraping:** ~$0.08-0.50 per 1,000 requests by plan ($99/mo ≈ $0.14/1K standard). Pennies per article. [[decodo.com pricing](https://decodo.com/scraping/web/pricing)]
- **TTS + forced alignment:** approximate; Google TTS ~$4-16 per 1M chars, a 2-4k-char script is well under $0.10. *Verify exact lane.*

**Honest note:** dropping Atlas raises image cost. Atlas's sibling-frame edit banded a whole Short at ~$0.13. With kie charging per image, a 1-3 min video that needs ~10-20 base frames plus sibling edits lands in **~$0.30-1.50 for the image stage** depending on scene count — to be confirmed by metering real renders.

**All-in per finished story+video (estimate, confirm by metering):**

| Line | Range |
|---|---|
| Images (gpt-image-2 base + nano-banana-2 edits) | $0.30-1.50 |
| Narration TTS + alignment | $0.05-0.20 |
| LLM (ideas/research/script) | $0.05-0.40 |
| Remotion render | $0.02-0.10 |
| Scrape (amortized) | pennies |
| **Total** | **~$0.50-2.00 (midpoint ~$1)** |

**Monthly at volume:** 20/day ≈ $300-1,200 · 100/day ≈ $1.5-6k · 300/day ≈ $4.5-18k.

The midpoint is livable; the top of the range at hundreds/day is real money. This is precisely why we validate unit economics on real renders before scaling, and gate spend behind proven return-visit numbers.

## 8. Security (rule 13)

- **Rotate every leaked secret now:** the OpenAI key, both kie.ai keys, the (now-unused) Atlas key, the Decodo token + dashboard login, the Strapi CMS login, the Google service-account JSONs, and the GitHub PAT in `.env.local`. All passed through chat/files and are compromised.
- **No secrets in code.** All via `.env` (gitignored, already added) locally and a secret manager in prod. Scripts read env var *names*, never values.
- **Least privilege** on the Reddit/scrape, storage, and DB credentials. Separate keys per environment.
- **Validate at boundaries**, never trust the client, fail closed on the moderation gate.
- **Public-repo audit:** youtubestudio and newturbovid are public; scan their history for committed keys.
- **Do not log** credentials or source-post PII. Namespaced, value-bearing logs everywhere else (observability from day one).

## 9. Validation experiment (do this first)

Per the council verdict: prove people come back before building the factory.

1. **Hand-produce 3 finished sample stories** (top 3 categories) end-to-end at the real quality bar: rewrite + doodle video + teleprompter + article/gallery. These are the quality bar, the legal test, and the seed batch.
2. Expand to **~20-30 stories**, publish on a minimal Next.js app (can read from files/Postgres; no full pipeline yet).
3. Drive a little real traffic. **Measure:** 7-day return rate, session depth, watch-through, share rate.
4. **Meter true unit cost** on those real renders (settles Section 7).
5. **Kill criterion (define with stakeholders):** e.g., if 30 stories cannot hold a target return rate over 3-4 weeks, stop and rethink, do not scale a loss.

## 10. Rollout phases

- **P0 Validation:** 3 samples → ~20-30, manual/semi-automated, measure. (Gate: QA checklist + legal review of 3 samples.)
- **P1 Small loop:** wire the pipeline to Postgres+Sheet, human-in-the-loop approval, **10-30/day**.
- **P2 Scale:** lift caps toward hundreds/day only after return-visit and unit-economics gates pass; add monitoring + a deindex/kill switch.

## 11. Design system (see `brand/design-prompts.md` for generation prompts)

**Type**
- Display / wordmark / hero & poster titles: **Archivo** (700-900, tracking ~-0.02em; poster titles uppercase).
- UI / body: **Hanken Grotesk** (400-800).
- Micro labels / durations / kickers: **Spline Sans Mono** (uppercase, wide tracking).
- Doodle video captions (hand-drawn): **Caveat** (600-700).
- Banned: Inter, Poppins, Montserrat, Roboto, system-ui as a primary face.

**Color — app shell (dark cinematic)**
- bg `#0A0A0C` · surface `#15141A` · surface-2 `#211F29` · hairline `rgba(255,255,255,.085)`
- text `#F5F3EF` (warm off-white) · muted `#8E8A97`
- accent / signature `#E8462B` (vermilion — our "Netflix red")
- category accents: Drama `#9B3A30` · Entitled `#C06234` · Humor `#C9A227` · Wholesome `#2C7E78` · Dating `#A8466A` · Roommate `#5B3B8A` · Lists `#4C7A53`

**Color — doodle video content (light, hand-drawn)**
- canvas `#FBFAF4` · ink/marker `#1A1714` · accent `#E8462B` · highlighter `#FFD84D`

**Motion:** restrained and cinematic. Card press-scale, snap-scroll rails, slide-up title sheet, slow ken-burns on the billboard, word-sync highlight on the teleprompter. Doodle content stays low-motion/calm. No glassmorphism, no decorative gradients in the shell — the dark is flat and imagery-driven.

## 12. Rejected alternatives (and why)

- **Google Sheets as the database:** dies at hundreds/day (quotas, concurrency, corruption). Kept only as the human control panel.
- **Strapi / Sanity / Contentful (any third-party CMS):** redundant with the bespoke admin (5A), which *is* the CMS. Content is pipeline-generated via API, not hand-authored, and youtubestudio proves the Next.js + Postgres + own-admin pattern. A separate CMS is a second server to run, secure, and fight to fit our review/regenerate flows.
- **Full rebuild of the pipeline from scratch:** wastes Amir's hard-won prompt + research logic.
- **Rename to Loreflick/Lorereel/etc.:** LoreWire is free and strong; rename is the cheapest thing to change later, not worth churn now.
- **Atlas for images:** removed per direction; kie.ai gpt-image-2 → nano-banana-2 instead (costs more, but one fewer vendor and your call).
- **TikTok vertical feed as the spine:** not Netflix; demoted to a "Play Something" shuffle.
- **Cream-paper editorial look (earlier direction):** retired; replaced by the dark cinematic shell. Brand marks + vermilion survive.

## 13. Open questions

1. **Thumbnails — DECIDED:** dark **cinematic** posters (a generated cinematic still per story), not doodle key-frames. Keeps the browse premium, and since the doodle video now carries cinematic elements too, poster and content stay coherent. Adds ~1 cinematic image per story to the cost.
2. **Object storage — DECIDED:** Google Cloud Storage (already owned, pipeline already writes to `aporia-unleash`), fronted by Cloudflare CDN. Keep a media-bucket abstraction so it can swap to R2 if egress ever matters at mass scale.
3. **Remotion render — DECIDED:** reuse youtubestudio's AWS Lambda path; Cloud Run is the single-cloud alternative if zero-AWS is wanted.
4. **TTS lane:** Google vs ElevenLabs vs Gemini TTS (cost vs voice quality) — meter.
5. **How many image calls per 1-3 min doodle video** — meter on real renders to settle Section 7.
6. **Doodle vs drama tone:** confirm the calm hand-drawn style carries the dramatic categories (proven on YouTube, but validate with the 3 samples).
```
