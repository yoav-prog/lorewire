# Captions: accuracy and naturalness

Date: 2026-06-18
Owner: Yoav
Status: research + recommendation, awaiting approval to implement

## What the user asked for

> The captions are synced to the speech, but they don't always reflect the actual speech. It shows "Read" instead of "Red", inserts wrong words, misplaces punctuation. Investigate robustly and recommend the best way to display captions perfectly and naturally.

## Goal

Captions on shorts must (in order):

1. Match the spoken audio **word for word**, including the **exact wording, capitalization, and punctuation** of the source script.
2. Read **naturally** — sentence ends with `.`, questions end with `?`, contractions stay contracted, line breaks fall on phrase boundaries.
3. Stay readable — within mobile safe zones, under industry CPS limits, with the karaoke pulse the current style already lands on phrase pacing.

## Diagnosis: what is actually broken today

The caption pipeline has two voice providers and they take **fundamentally different paths to the caption text**:

### Path A — ElevenLabs (text-authoritative)

[pipeline/voice.py:119-145](pipeline/voice.py#L119-L145) calls `/v1/text-to-speech/{voice_id}/with-timestamps`. ElevenLabs returns:

- the synthesized MP3
- a character-level alignment of the **input script** (your text, exactly as you sent it)

[pipeline/voice.py:97-116](pipeline/voice.py#L97-L116) (`_chars_to_words`) folds those character timings into word records by splitting on whitespace. The character payload **is the source text**, so the caption text on this path cannot say "Read" when the script said "Red" — the worst it can do is miss a space.

### Path B — Google Cloud (ASR-driven, this is the bug)

[pipeline/voice.py:227-260](pipeline/voice.py#L227-L260) sends the script to Google TTS, **throws away the source text**, then re-runs Google Speech-to-Text on its own audio with `enableWordTimeOffsets` to recover word timings ([pipeline/voice.py:318-363](pipeline/voice.py#L318-L363)).

That STT pass is where every reported symptom comes from:

- **Homophone errors** ("Read" / "Red", "their" / "there", "to" / "too") — STT picks whichever surface form its language model rates higher.
- **Wrong words inserted into sentences** — STT can drop, duplicate, or substitute words on quiet syllables, accented vowels, or whenever the TTS voice produces an unusual phoneme.
- **Missing or misplaced punctuation** — Google STT in the `latest_long` model **does not return punctuation at all by default**, so `?` / `.` / `,` never even arrive at the chunker. The downstream chunk-breaker in [pipeline/video.py:512](pipeline/video.py#L512) keys off `[.!?,;:]$`, so on the Google path that break never fires — chunks split only on the 400 ms pause and the 4-word cap.
- **Loss of capitalization** — Google STT returns lowercase; sentence starts and proper nouns come out flat unless we re-cased.

The Google path was added because Google TTS does not return word timings with its synth response (file header comment confirms this); the STT round-trip was a yt-studio-borrowed trick. It works for **timings** — STT is good at "when did each sound happen" — but it is a wrong tool for **text**.

### Why this is structurally severe

The chunker treats the words array as authoritative for both timing **and** text content ([pipeline/video.py:521-535](pipeline/video.py#L521-L535)): `text = " ".join(w["word"] for w in words)`. There is no normalization, no punctuation restoration, no capitalization restoration, no cross-check against the source script. So on the Google path, the caption text is a downstream by-product of an STT pass that can never be as good as the script we already had in our hand. That is the actual root cause.

## Constraints and requirements

- Captions are burnt-in via Remotion ([video/src/DoodleShort.tsx:353](video/src/DoodleShort.tsx#L353)) — we have full pixel control. No SRT/VTT/ASS constraints. We can render whatever we want.
- The active voice provider is admin-configurable ([pipeline/voice.py:81](pipeline/voice.py#L81)); both `google/*` and `elevenlabs/*` selections ship today. Whichever the admin picks must produce correct captions.
- Existing word-highlight modes (`karaoke`, `color`, `scale`, `background`, `none`) are already wired and look good ([video/src/DoodleShort.tsx:447-491](video/src/DoodleShort.tsx#L447-L491)); we should not break that surface.
- Cost ceiling matters per global rule 8. The Google path is cheap; anything I propose has to stay close to that.

## Industry standards I am pinning to

| Spec | Value | Source |
| --- | --- | --- |
| Max characters per line | 42 (Latin-script broadcast standard), 20–32 for mobile-first | Netflix, Polilingua, OpusClip |
| Max lines per chunk | 2 | Netflix |
| Max reading speed | 17 CPS adult standard, 20 CPS Netflix ceiling | Netflix |
| Event duration | min 5/6 s, max 7 s | Netflix |
| Min gap between events | 2 frames | Netflix |
| Caption position (9:16) | lower-middle third, Y ≈ 1200–1550, away from bottom 320 px button column | Houseofmarketers, Kreatli |
| Line break rule | after punctuation, before conjunctions/prepositions; never split noun+article, noun+adjective, verb+pronoun | Netflix |
| Word-by-word vs static block | word-by-word ("karaoke") measurably wins on watch-time and engagement on TikTok/Reels/Shorts | OpusClip, Blitzcut, Submagic |

We already do most of this. The accuracy bug is what stands between the current renderer and "perfect and natural."

## Options

### Option A — Make the source script the single source of truth for caption text (recommended)

**One-paragraph summary.** The TTS input script is what the voice is reading. We already send it in. We keep using each provider's audio + word timings, but we **replace** the text content of every caption with the matching span from the source script — punctuation, capitalization, contractions, numerals, and all. The ElevenLabs path already does this de facto (character alignment is the script); we just stop letting the chunker invent text. The Google path stops being ASR-for-text and becomes alignment-from-text: we keep STT for **when** but graft the **what** back from the script via a Needleman–Wunsch / monotonic-alignment match (word-by-word, with a small edit-distance tolerance for STT's lowercased homophone tokens).

**Detailed explanation.**

1. New file `pipeline/captions.py` with one public function: `align_script_to_words(script: str, words: list[Word]) -> list[Word]`.
2. Tokenize the source script preserving punctuation and capitalization: `["Red", ",", "the", "barn", "was", "old", "."]` (or, more usefully, attach trailing punctuation to the prior word: `["Red,", "the", "barn", "was", "old."]`).
3. Lowercase-and-strip both sides; run a monotonic alignment so token *i* in the script gets matched to STT word *j*. Penalize substitutions lightly, insertions/deletions more — this absorbs occasional STT drops without skipping a script word entirely.
4. Replace `words[j].word` with `script_tokens[i]` (the original-case, original-punctuation form). When STT inserts a phantom word the script doesn't have, drop it (it has no script source). When STT drops a real word, synthesize a 0 ms wedge at the neighbor boundary so the missing word still appears in the chunk and the highlight still pulses on it.
5. On the ElevenLabs path the alignment is already character-monotonic — we can skip the matching and just walk the source string, snapping word boundaries to whitespace as `_chars_to_words` already does. The win is that **punctuation that today gets glued to the next word** ("Red.the") will now cleanly fall as "Red." at the end of one word.
6. Chunker keeps its job — but the punctuation breaks now actually fire on the Google path (because punctuation is back in the tokens), so chunks land on phrase boundaries instead of arbitrary 4-word stops.

**Tradeoffs.**

- Cost: zero. No new API calls.
- Latency: tiny. Monotonic word alignment on 200–500 tokens is sub-millisecond Python.
- Risk: when STT and script diverge by a lot (e.g. the script went through a different LLM rewrite before render and we never persisted the actual rendered text), the aligner needs a clear fallback. We treat the alignment as best-effort and log the edit distance so we see drift in metrics.
- Provider quirks: ElevenLabs **normalizes** the input on render — "$1,000,000" becomes "one million dollars" in the spoken audio but the character alignment is against the **normalized** text. If we splice back from the un-normalized script the captions will read "$1,000,000" while the voice says "one million dollars". We need to feed the alignment the **normalized** form (ElevenLabs exposes `normalized_alignment` on the response — we already pull it as a fallback at [voice.py:143](pipeline/voice.py#L143)) and decide whether captions should show the spoken form or the written form. Recommendation below.

### Option B — Keep Google STT, add a punctuation restorer + a homophone corrector

**One-paragraph summary.** Treat the Google STT output as the source of truth for caption text, but bolt a punctuation restoration model (`rpunct`, `deepmultilingualpunctuation`, or a small BERT classifier) and a homophone post-corrector on top. The model adds `.` / `?` / `,` to the lowercase STT stream and re-cases sentence starts and proper nouns.

**Detailed explanation.** Run the STT word list through `oliverguhr/deepmultilingualpunctuation` (English-supported, MIT-licensed, ~250 MB BERT) or `Felflare/rpunct` (BERT-base, ~91% accuracy on held-out English). The model returns the same tokens with punctuation slotted in and capitalization restored. We then run a homophone pass — but here it gets bad: "Read" vs "Red" is **contextually determined**, and only an LLM with the script in hand can reliably reverse the STT mistake. Without the script, the punctuator helps with shape but the homophones survive.

**Tradeoffs.**

- Cost: free if we self-host the punctuation model (250 MB BERT runs on CPU at < 100 ms for a 2 min narration). If we route through an LLM for homophone correction, we pay per render.
- Latency: a CPU-bound 100 ms BERT pass per render, fine.
- Risk: This option **does not fix the homophones at all**. It only papers over punctuation and casing. The original "Read" / "Red" complaint stays.
- Maintenance: adds a transformer dependency to the pipeline. Disk + memory cost on the render worker. We can shove it into Cloud Run for the same reason we shove voice and video there.

### Option C — Switch to a dedicated forced-alignment pass (WhisperX or ElevenLabs FA)

**One-paragraph summary.** Stop using TTS-provider-returned word timings entirely. After TTS generates the audio, run a dedicated forced-alignment pass that takes `(audio, script)` and returns precise word timings against the script. The script's text wins; the audio gives only timing. WhisperX (wav2vec2 alignment, ~$1.28 per 100 hours on a spot L40S) or ElevenLabs Forced Alignment (`/v1/forced-alignment`) are both viable.

**Detailed explanation.** This is Option A's mechanism but with a different alignment engine. Instead of using STT timings + a script-graft step in Python, we use a model that natively does `(audio, transcript) -> word timings preserving transcript`. ElevenLabs FA is a one-call HTTP endpoint; WhisperX is a Docker image we already have the Cloud Run pattern for (`_plans/2026-06-14-cloud-run-render.md`).

**Tradeoffs.**

- Cost: ElevenLabs FA pricing is not on the public price sheet (verified by reading both the FA docs page and the API pricing page). The third-party reseller Segmind lists "$0.10 per generation." Best to email ElevenLabs sales or send a probe call before committing. Per global rule 8 I am not green-lighting a paid alternative until the real price is in our hand. WhisperX self-hosted is essentially free at our volume (sub-cent per video) but adds an ML deploy.
- Latency: ElevenLabs FA round-trip is ~the length of the audio. WhisperX on a small GPU is 25–30× real time so ~5–7 s for a 2 min narration.
- Risk: heavier than Option A and gives us the same caption text answer (the script wins, alignment supplies timings). The added benefit over Option A is sub-100 ms word boundary accuracy — useful if the karaoke highlight ever feels slightly off, but I have not seen that complaint in the brief.
- Provider lock-in: more.

### Honest comparison

Option A is the right call. The premise of Option B is wrong — it tries to repair downstream what we should never have lost upstream, and it cannot fix homophones at all. Option C is Option A wearing a more expensive coat: it solves the same problem with the same source of truth (script wins), but adds a network call or a GPU worker we do not need because the timings we already get are good enough.

The only thing Option C buys over Option A is sub-100 ms word boundary precision and a graceful failure mode when the script and audio diverge unrecoverably (e.g. someone hand-edited the script after render). Both are nice-to-haves; neither addresses the bug.

## Recommendation

**Adopt Option A. The script is the source of truth for caption text. Provider word arrays are the source of truth for timing only.** Implement in three phases:

### Phase 1 — Caption text is the script (the bug fix)

- Add `pipeline/captions.py` with `align_script_to_words(script, words, provider)`.
- ElevenLabs branch: walk the **normalized** alignment string (we already read `normalized_alignment` as a fallback) and emit words = chunks of non-whitespace characters from that string, with timings from the matching characters' end times. Punctuation that touches a word stays glued to it ("Red." stays one token). This preserves the spoken form exactly (since ElevenLabs normalized "$1,000,000" → "one million dollars", the captions also say that — which is the right thing because they have to match the voice).
- Google branch: monotonic Needleman–Wunsch with `match = same lowercased stem`, `substitute = +1`, `insert/delete = +2`. After alignment, replace `word.word` with the matched script token. Phantom STT words (no script match) drop out; missing STT words get a 0 ms wedge at the neighbor boundary so they still render.
- Both branches: tokenize the script with the same regex the chunker uses to detect punctuation, so a token like `"Red,"` carries the comma and the chunker can break on it ([video/py:512](pipeline/video.py#L512)).
- All caption text in `_finalize_chunk` is now provably a subspan of the original script (logged in tests). The "Read"/"Red" class of bug is structurally impossible from this point forward.

### Phase 2 — Normalize the source script before TTS (read-aloud form)

Even with Option A, the spoken audio reads "$1,000,000" as "one million dollars" but a human looking at the caption probably wants to see the **written** form they would in a magazine. We have to pick: written form (looks normal, doesn't match voice exactly) or spoken form (matches voice but reads weird in text). Industry convention for burnt-in karaoke captions is **spoken form**, because the highlight has to land on what the voice is actually saying ("one [million] dollars" — the word "million" pulses) and the karaoke effect breaks if the highlighted token does not match what the ear hears.

So we **pre-normalize the script before TTS** with a small rule-based pass (currency, dates, abbreviations, "Dr." → "Doctor", "5" → "five" up to single-digit, "$1,000,000" → "one million dollars", etc.) and feed the normalized form to both TTS and the caption renderer. The chunker now sees the same string the voice is reading. ElevenLabs's own docs ([elevenlabs.io/docs/best-practices/prompting/normalization](https://elevenlabs.io/docs/best-practices/prompting/normalization)) say normalization is on by default and recommend pre-normalizing to control how it lands. We are just doing what they recommend.

### Phase 3 — Tighten the visual contract

Now that the text content is correct, harden the renderer against the standards table above:

- **Cap at 42 characters per line, 20 for mobile-only lanes** (we render at 1080×1920, mobile-first — pin at 30 chars per line per chunk, two-line max).
- **CPS budget**: at chunk build time, if a chunk's `text length / duration_seconds > 17`, split it. Right now we cap at 4 words but not at CPS — short words can sail through, long ones cannot.
- **Phrase-aware line breaks**: when a chunk wraps to two lines, break before a conjunction or preposition, never between an article and its noun. Wire a small breaker function in `_finalize_chunk` or in the renderer.
- **Safe zone**: confirm `style.positionY` defaults sit at ~62–75% of frame height (Y ≈ 1200–1440 on a 1920 canvas). Today `positionY` is template-configured — audit defaults to land inside the 9:16 lower-middle third with at least 320 px clear of the bottom button column.
- **Existing karaoke modes stay** — `karaoke`/`color`/`scale`/`background` are already the right industry pattern.

## Settings audit (per global rule 15)

New user-controllable settings introduced by this work:

| Setting | Where | Default | Why a user might flip it |
| --- | --- | --- | --- |
| `captions.text_source` | Admin → Configuration → Captions | `script` | "I want raw STT for diagnostic" → `provider_words`. Hidden behind a "developer" group. |
| `captions.script_normalization` | Admin → Configuration → Captions | `on` | Some users may want literal "$1,000,000" in captions even if it desyncs from voice. |
| `captions.max_chars_per_line` | Admin → Configuration → Captions → Layout | `30` | Localized clients with denser fonts. |
| `captions.max_cps` | Admin → Configuration → Captions → Layout | `17` | Power users want faster reading. |
| `captions.position_y` (already exists in template) | unchanged | per-template | Already exposed via templates; just audit defaults. |
| `captions.word_highlight` (already exists) | unchanged | per-template | No change. |

Group all of these in a single **Captions** settings card under Configuration, not scattered into Voice or Video. Honor existing template overrides — the global value is a default; templates win where they specify.

## Security (per global rule 13)

- The script-graft alignment touches user-supplied story content on the worker. No new attack surface — the script is already trusted input that we send to TTS.
- The normalization pre-pass is pure local Python with rule tables; no LLM call required for Phase 2.
- If we later add an LLM homophone corrector (we shouldn't, per the analysis above), feed it only the script + STT word list — no other story context, no PII beyond what is already in the script.
- No new secrets, no new external endpoints, no new IAM surface. Cloud Run worker permissions unchanged.

## Observability (per global rule 14)

Every step of the new path logs with namespaced lines so a user-reported "captions still wrong" can be diagnosed from the worker log alone:

```
[captions tokenize] script_len=412 tokens=78 has_punct=True
[captions align provider=elevenlabs] words=78 normalized_used=True
[captions align provider=google] script_tokens=78 stt_words=82 matched=76 phantoms=4 missing=2 edit_distance=8
[captions chunk] chunks=22 avg_cps=14.3 max_cps=18.1 over_budget=1
[captions chunk over_budget] chunk_index=11 cps=18.1 text="The first thing you need to know about"
```

Mirror in tests so we can assert "Google path produces text == script tokens" without re-rendering audio.

## Testing (per global rule 18)

- `pipeline/tests/test_captions.py` (new):
  - Tokenization preserves punctuation, splits on whitespace.
  - Monotonic alignment: identical script + STT → 1:1, zero edit distance.
  - Substitution: STT says "read" where script says "Red" → caption emits "Red".
  - Insertion: STT inserts a phantom word → it is dropped, neighbor timings unchanged.
  - Deletion: STT drops a word → a 0 ms wedge is inserted at the neighbor boundary; chunk still includes the missing word.
  - Punctuation snaps to the prior word's token (`"Red"` + `","` → `"Red,"`) so the chunker break-on-punctuation rule fires.
- Update `pipeline/tests/test_voice.py` Google branch to assert the script-graft is applied (the STT word array is replaced with script tokens after alignment).
- Update `pipeline/tests/test_video.py` chunker tests to assert chunks break on punctuation tokens on **both** providers (regression for the current bug where Google path never breaks because STT strips punctuation).
- A snapshot test on a known 30 s narration where we record (script, audio, expected captions) and pin them so any future regression in alignment shows up as a diff.

## Open questions

1. Which voice provider is the default in production today? The codebase ships both `google/chirp3-hd` and `elevenlabs/*` and the active selection lives in DB settings; I did not query the live database. If the default is ElevenLabs, the user complaint about "Read" / "Red" is harder to explain (the ElevenLabs path passes the script through verbatim). Possibilities: (a) the provider was Google when the bad render happened and got switched after; (b) it is ElevenLabs and the bug is a different one — punctuation glue / a normalization difference. Worth a one-line check.
2. Does the normalization pre-pass need to round-trip with the LLM rewrite step? If the article rewrite already produces TTS-clean text, the normalizer is a thin safety net and can ship dumb rules. If it doesn't, we need a richer expander.
3. Should the captions surface **rendered form** (matches voice) or **written form** (looks normal in text)? Recommendation above is rendered form, but if shows are also shared as text reels, written form may matter and we should split the two outputs.

## Sources

- [YouTube Shorts Caption & Subtitle Best Practices in 2026 — OpusClip](https://www.opus.pro/blog/youtube-shorts-caption-subtitle-best-practices)
- [The Complete Guide to Video Captions (2026) — CaptionX](https://caption-x.com/video-captions-guide)
- [Best Caption Style for YouTube Shorts (2026) — Blitzcut](https://blitzcutai.com/blog/best-caption-style-youtube-shorts-2026)
- [Subtitle Formatting: Best Practices & Standards — Video Tap](https://videotap.com/blog/subtitle-formatting-best-practices-and-standards)
- [Captions for Instagram and Short-Form Video — Way With Words](https://waywithwords.net/resource/captioning-short-form-videos-practices/)
- [Closed Captions and Subtitling Tips to Boost Views in 2026 — Polilingua](https://www.polilingua.com/blog/post/subtitling-services-video-captioning.htm)
- [Netflix Timed Text Style Guide — General Requirements](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements)
- [Netflix Timed Text Style Guide — English (USA)](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide)
- [Netflix Subtitle Style Guide Explained — SubtitlesEdit](https://subtitlesedit.com/blog/netflix-subtitle-style-guide-explained)
- [Best Caption Placement for Short-Form Video — Blitzcut](https://blitzcutai.com/blog/best-caption-placement-short-form-video)
- [9:16 Safe Zones Guide — Houseofmarketers](https://houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories-reels/)
- [Safe Zone Hub 2026 — Kreatli](https://kreatli.com/guides/safe-zone-guide)
- [ElevenLabs — Forced Alignment overview](https://elevenlabs.io/docs/overview/capabilities/forced-alignment)
- [ElevenLabs — Forced Alignment API reference](https://elevenlabs.io/docs/api-reference/forced-alignment/create)
- [ElevenLabs — Create speech with timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- [ElevenLabs — Text normalization best practices](https://elevenlabs.io/docs/best-practices/prompting/normalization)
- [ElevenLabs — API pricing](https://elevenlabs.io/pricing/api)
- [Segmind — ElevenLabs Forced Alignment pricing](https://www.segmind.com/models/elevenlabs-forced-alignment/pricing)
- [WhisperX repository](https://github.com/m-bain/whisperX)
- [Tradition or Innovation: A Comparison of Modern ASR Methods for Forced Alignment (arXiv 2406.19363)](https://arxiv.org/pdf/2406.19363)
- [Choosing between Whisper variants — Modal](https://modal.com/blog/choosing-whisper-variants)
- [WhisperX 2026 Guide — Local AI Master](https://localaimaster.com/blog/whisperx-guide)
- [ASR Model Benchmark 2026 — Speechlab](https://www.speechlab.ai/blog-posts/asr-benchmark-7-models-real-audio)
- [rpunct — punctuation restoration](https://github.com/Felflare/rpunct)
- [deepmultilingualpunctuation — Oliver Guhr](https://github.com/oliverguhr/deepmultilingualpunctuation)
- [Submagic — AI Caption Generator](https://www.submagic.co/ai-caption)
- [Opus Clip + Submagic + Captions.ai engineering breakdown — Forasoft](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/opus-clip-descript-submagic-captions-ai-video-editor-tools-2026)
- [Text Normalization (TTS pre-processing) — Devopedia](https://devopedia.org/text-normalization)
- [Captions and Transcripts — Section508.gov](https://www.section508.gov/create/captions-transcripts/)
