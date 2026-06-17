import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { listGoogleVoices, listElevenLabsVoices } from "@/lib/voice-providers";
import SettingsShell from "@/app/admin/SettingsShell";
import { loadHeroStyleSettings } from "@/app/admin/actions";
import { HeroStylePicker } from "@/app/admin/(panel)/_components/HeroStylePicker";
import {
  SettingChipGroup,
  SettingSlider,
  SettingToggle,
  SettingNumber,
  SettingPresetText,
  SettingSelect,
  SettingText,
  type SelectOption,
} from "./_components/SettingControls";
import { SubredditAutocomplete } from "./_components/SubredditAutocomplete";
import { NARRATION_VIBES, LENGTH_PRESETS } from "@/lib/shorts-options";
import { ASPECT_CHIP_OPTIONS, type ChipOption } from "@/components/ui";
import {
  isVideoAspect,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";
import {
  DEFAULT_PUBLIC_FLOOR,
  POLL_RAIL_KINDS,
  railEnabledSettingKey,
} from "@/lib/polls";
import {
  DEFAULT_POLL_HOOK_TEMPLATES,
  pollHookSettingKey,
  PUBLISHER_PLATFORMS,
} from "@/lib/publisher-poll-hook";

// Settings / General. Every field now uses the right control: toggles for
// the booleans (previously stringy "0"/"1"), number inputs with min/max for
// the count fields, preset chips on the style + Gemini prompt fields. Voice
// id fields stay text for now — API-backed dropdowns from Google Cloud TTS
// and ElevenLabs land in the follow-up commit once provider credentials
// are wired into the Node side.

/** Categories paired with their lowercased settings key + display
 *  label. Matches the resolver in `pipeline/stages.py:resolve_hero_style`
 *  which reads `hero.category_default.<lowercase cat>` — the lowercase
 *  is intentional so the admin UI's casing doesn't have to match the
 *  story rows' casing. */
const HERO_CATEGORY_KEYS: { category: string; key: string; label: string }[] = [
  { category: "Entitled", key: "entitled", label: "Entitled" },
  { category: "Drama", key: "drama", label: "Drama" },
  { category: "Humor", key: "humor", label: "Humor" },
  { category: "Wholesome", key: "wholesome", label: "Wholesome" },
  { category: "Dating", key: "dating", label: "Dating" },
  { category: "Roommate", key: "roommate", label: "Roommate" },
];

const STYLE_PRESETS = [
  { label: "Doodle marker", value: "doodle explainer, off-white paper, single marker" },
  { label: "Watercolor", value: "watercolor illustration, soft palette, hand-painted edges" },
  { label: "Comic book", value: "comic book panel, bold ink, halftone shading" },
  { label: "Storyboard", value: "rough storyboard, pencil sketch, action lines" },
  { label: "Flat vector", value: "flat vector illustration, simple shapes, vibrant flat colors" },
];

const GEMINI_PROMPT_PRESETS = [
  {
    label: "Calm podcaster",
    value:
      "Read this in a calm, conversational tone, like a podcaster telling a story",
  },
  {
    label: "Excited storyteller",
    value:
      "Read this with energy and excitement, like a storyteller pulling you in",
  },
  {
    label: "Newscaster",
    value: "Read this in a clear, measured news-anchor voice, even pacing",
  },
  {
    label: "Whisper",
    value:
      "Read this in an intimate, near-whisper tone, slower than normal speech",
  },
  {
    label: "Dramatic narrator",
    value: "Read this in a dramatic narrator voice, with pauses and weight",
  },
];

// Helper: a setting stored as "1"/"0"/"true"/"false"/"" is considered ON
// unless it's explicitly OFF. Matches the existing pipeline-side convention.
function readToggle(raw: string | null, defaultOn = false): boolean {
  if (raw === null || raw === "") return defaultOn;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export default async function SettingsPage() {
  await requireCapability("settings.manage");

  // Pull every setting + voice catalog in parallel. The voice catalog fetchers
  // are cached server-side (1h TTL) so this isn't a fresh upstream call on
  // every render — the awaits resolve in microseconds after the first warm.
  const [
    subreddit,
    postsPerRun,
    dailyBudget,
    googleVoice,
    geminiPrompt,
    elevenLabsVoice,
    videoStyle,
    sceneCount,
    kenBurns,
    microWiggle,
    labelPop,
    scribbleDraw,
    propSlide,
    propCount,
    mouthSwap,
    introOutroEnabled,
    frameRegenSessionCapCents,
    defaultAspect,
    sceneCountMode,
    sceneTargetSecondsPerScene,
    cronMaxRowsPerTick,
    scenePromptGrounding,
    characterBibleCache,
    previewSegmentFit,
    worldBibleEnabled,
    characterReferenceImagesEnabled,
    locationReferenceImages,
    sceneImageModel,
    googleVoices,
    elevenLabsVoices,
  ] = await Promise.all([
    getSetting("pipeline.subreddit"),
    getSetting("pipeline.limit"),
    getSetting("budget.daily_usd"),
    getSetting("voice.google_voice_name"),
    getSetting("voice.google_style_prompt"),
    getSetting("voice.elevenlabs_voice_id"),
    getSetting("video.style"),
    getSetting("media.scene_count"),
    getSetting("video.ken_burns"),
    getSetting("video.micro_wiggle"),
    getSetting("video.label_pop"),
    getSetting("video.scribble_draw"),
    getSetting("video.prop_slide"),
    getSetting("media.prop_count"),
    getSetting("video.mouth_swap"),
    getSetting("video.intro_outro_enabled"),
    getSetting("video.editor.frame_regen.session_cap_cents"),
    getSetting("video.default_aspect"),
    getSetting("media.scene_count_mode"),
    getSetting("media.scene_count_target_seconds_per_scene"),
    getSetting("media.cron_max_rows_per_tick"),
    getSetting("video.scene_prompt_grounding"),
    getSetting("video.character_bible_cache"),
    getSetting("video.preview_segment_fit"),
    getSetting("video.world_bible_enabled"),
    getSetting("video.character_reference_images_enabled"),
    getSetting("video.location_reference_images"),
    getSetting("video.scene_image_model"),
    listGoogleVoices(),
    listElevenLabsVoices(),
  ]);

  // Hero style registry — Phase 2 of
  // _plans/2026-06-17-hero-style-registry.md. One round trip pulls the
  // global default, every per-category default, and every pre-generated
  // thumbnail URL so the picker renders without a follow-up round-trip
  // per card.
  const heroStyleSettings = await loadHeroStyleSettings();

  // Article-shorts auto-generate settings (global default + per-category).
  const [shortsAutoEnabled, shortsAutoNarration, shortsAutoLength] =
    await Promise.all([
      getSetting("shorts.auto.enabled"),
      getSetting("shorts.auto.narration"),
      getSetting("shorts.auto.length"),
    ]);

  // Engagement-poll settings (Phase 4.5 + Phase 5 + Phase 5 follow-up
  // of _plans/2026-06-17-engagement-polls.md):
  //   - Three rail toggles read by getHomepagePolls in
  //     app/actions.ts when composing the homepage feed.
  //   - polls.public_floor read by resolvePublicFloor — controls when
  //     percentages reveal on the on-site widget.
  //   - publisher.caption.<platform>.poll_hook_template — per-platform
  //     caption-suffix override consumed by lib/publisher-poll-hook
  //     when the publisher integrates (Phase 1 of the publisher plan).
  //     Default templates ship per §F4; admin can override per platform.
  const [
    railDivisive,
    railAgreed,
    railUnpopular,
    publicFloorRaw,
    endcardEnabled,
    endcardDurationRaw,
    hookYoutube,
    hookTiktok,
    hookInstagram,
    hookFacebook,
  ] = await Promise.all([
    getSetting(railEnabledSettingKey("divisive")),
    getSetting(railEnabledSettingKey("agreed")),
    getSetting(railEnabledSettingKey("unpopular")),
    getSetting("polls.public_floor"),
    getSetting("polls.endcard.enabled"),
    getSetting("polls.endcard.duration_ms"),
    getSetting(pollHookSettingKey("youtube")),
    getSetting(pollHookSettingKey("tiktok")),
    getSetting(pollHookSettingKey("instagram")),
    getSetting(pollHookSettingKey("facebook")),
  ]);
  // Bundle so the section render below stays tidy.
  const pollHookOverrides: Record<(typeof PUBLISHER_PLATFORMS)[number], string> = {
    youtube: hookYoutube ?? "",
    tiktok: hookTiktok ?? "",
    instagram: hookInstagram ?? "",
    facebook: hookFacebook ?? "",
  };
  const SHORT_CATEGORIES = [
    "Dating", "Drama", "Entitled", "Humor", "Roommate", "Wholesome",
  ];
  const shortsAutoByCat: Record<string, string> = {};
  await Promise.all(
    SHORT_CATEGORIES.map(async (c) => {
      shortsAutoByCat[c] = (await getSetting(`shorts.auto.category.${c}`)) ?? "";
    }),
  );
  const narrationOptions: SelectOption[] = NARRATION_VIBES.map((v) => ({
    id: v.id,
    label: v.label,
  }));
  const lengthOptions: SelectOption[] = LENGTH_PRESETS.map((v) => ({
    id: v.id,
    label: v.label,
  }));
  const catOverrideOptions: SelectOption[] = [
    { id: "", label: "Inherit global" },
    { id: "on", label: "Always make a short" },
    { id: "off", label: "Never" },
  ];

  // Map voice catalogs to the SettingSelect option shape. Group Google by
  // locale (the API returns the locale on each voice); group ElevenLabs by
  // accent label. When the catalog is empty (creds missing or API down) the
  // SettingSelect falls back to a plain text input automatically.
  const googleOptions: SelectOption[] = googleVoices.map((v) => ({
    id: v.id,
    label: v.label,
    group: v.locale,
  }));
  const elevenLabsOptions: SelectOption[] = elevenLabsVoices.map((v) => ({
    id: v.id,
    label: v.label,
    group: v.locale || "Other",
  }));

  return (
    <SettingsShell
      active="general"
      title="General"
      description="Pipeline defaults, voice, video look, and the intro/outro splice switch. Read by the pipeline at run time."
    >
      <div className="space-y-8">
        <Section
          title="Article shorts"
          description="Auto-generate a 40-60s vertical doodle short when a story finishes. Off by default. The per-category overrides win over the global default; narration vibe + length apply to every auto-generated short (each short can still be (re)generated manually with its own picks in the video editor)."
        >
          <SettingToggle
            settingKey="shorts.auto.enabled"
            label="Auto-generate a short for every new article"
            hint="When on, each finished story is also queued as a short (unless a category override below says otherwise). Each short costs ~$0.70."
            initialOn={readToggle(shortsAutoEnabled, false)}
          />
          <SettingSelect
            settingKey="shorts.auto.narration"
            label="Default narration vibe"
            hint="The storytelling tone used for auto-generated shorts."
            initial={shortsAutoNarration ?? "suspense"}
            options={narrationOptions}
          />
          <SettingSelect
            settingKey="shorts.auto.length"
            label="Default length"
            hint="Standard is a punchy ~45s; Extended is a ~1 min cut that develops the story more."
            initial={shortsAutoLength ?? "standard"}
            options={lengthOptions}
          />
          {SHORT_CATEGORIES.map((c) => (
            <SettingSelect
              key={c}
              settingKey={`shorts.auto.category.${c}`}
              label={`Category override: ${c}`}
              hint="Inherit follows the global toggle above; Always / Never force it for this category."
              initial={shortsAutoByCat[c] ?? ""}
              options={catOverrideOptions}
            />
          ))}
        </Section>

        <Section
          title="Hero & poster style"
          description="Which named look the hero / poster art uses on every render. Lives ABOVE the existing 'Video & image style' field below — that field still steers scene illustrations + narration; this one steers ONLY the hero / poster. Empty layers fall through: per-story pin → category default → global default → an automatic per-category short-list. Changing a default here only affects FUTURE renders; existing rows keep their current art until you click 'Restyle hero from short character' on the story."
        >
          <HeroStylePicker
            settingKey="hero.global_style_id"
            label="Global default"
            hint="Applied to every category that doesn't have its own default set below. Leave on Auto-pick to let the per-category whitelist drive variety across the catalog."
            selectedId={heroStyleSettings.globalStyleId}
            thumbnails={heroStyleSettings.thumbnails}
            includeAutoOption
            autoOptionLabel="Auto-pick per category"
          />
          {HERO_CATEGORY_KEYS.map(({ category, key, label }) => {
            const selected = heroStyleSettings.categoryDefaults[key] ?? "";
            return (
              <HeroStylePicker
                key={key}
                settingKey={`hero.category_default.${key}`}
                label={`${label} default`}
                hint={`Style applied to ${label} stories that don't have their own per-story pin.`}
                selectedId={selected}
                thumbnails={heroStyleSettings.thumbnails}
                includeAutoOption
                autoOptionLabel="Use global default"
              />
            );
          })}
          <p className="text-[12px] text-ink/55">
            Need to populate the thumbnail previews? Run{" "}
            <code className="rounded bg-line/30 px-1 py-0.5 text-[11px]">
              python -m pipeline.scripts.generate_hero_style_thumbnails
            </code>{" "}
            once after a fresh install or after editing a style&apos;s prompt
            band. Idempotent — re-running with no edits is a no-op.
          </p>
        </Section>

        <Section
          title="Style presets"
          description="Creative direction for everything the pipeline generates — narrator delivery, scene images, and prop cutouts. Pick a preset to fill the field, then tweak."
        >
          <SettingPresetText
            settingKey="video.style"
            label="Video & image style"
            hint="Steers both the rendered video look and the static images the pipeline generates (scenes, prop cutouts, talking-head bust). Used everywhere a story needs a visual style note."
            initial={videoStyle ?? ""}
            presets={STYLE_PRESETS}
            placeholder="doodle explainer, off-white paper, single marker"
          />
          <SettingPresetText
            settingKey="voice.google_style_prompt"
            label="Voice tone"
            hint="Only used when a Google Gemini-TTS model is active. Steers narrator delivery (pace, tone, emotion). Counts toward Google's combined 8000-byte cap."
            initial={geminiPrompt ?? ""}
            presets={GEMINI_PROMPT_PRESETS}
            placeholder="Read this in a calm, conversational tone, like a podcaster telling a story"
          />
        </Section>

        <Section
          title="Image prompts"
          description="How the pipeline builds the prompt sent to kie.ai for each scene image. Grounding ties each scene's prompt to the narration line spoken at that moment; turning it off reverts to the older article-body-only prompts."
        >
          <SettingToggle
            settingKey="video.scene_prompt_grounding"
            label="Ground scene prompts in narration"
            hint="When on, each scene image prompt is built from the caption line the narrator says at that scene, plus a recurring-characters bible. When off, the pipeline asks the model to invent N scenes from the article body (the pre 2026-06-14 behavior). Default on."
            initialOn={readToggle(scenePromptGrounding, true)}
          />
          <SettingToggle
            settingKey="video.character_bible_cache"
            label="Cache the character bible per story"
            hint="Diagnostic toggle. When on, the bible (the 2-4 recurring characters with their visual cues) is computed once per story and reused across scene regens — same characters scene to scene. Off forces a fresh bible on every regen, useful when the cached bible turns out wrong. Default on."
            initialOn={readToggle(characterBibleCache, true)}
          />
        </Section>

        <Section
          title="World bible (Option C)"
          description="2026-06-14: a structured per-story bible of characters, sub-characters, locations, and items, each with a stable id. Characters (and optionally locations) get a canonical reference image so kie.ai's nano-banana-2 endpoint can keep faces consistent scene to scene. Disable the master switch to revert to the previous text-only grounded path."
        >
          <SettingToggle
            settingKey="video.world_bible_enabled"
            label="Use the world bible for scene gen"
            hint="Master switch. When on, scene regens build a structured world bible per story and pass relevant reference images to kie. When off, the pipeline uses the previous grounded path (text-only character bible). Default on."
            initialOn={readToggle(worldBibleEnabled, true)}
          />
          <SettingToggle
            settingKey="video.character_reference_images_enabled"
            label="Generate character reference images"
            hint="When on, every character (and sub-character) in the bible gets one canonical headshot generated up front via the scenes model. Scene calls pass the matching ref to kie so faces stay consistent. Off saves ~$0.04 per character but loses identity persistence. Default on."
            initialOn={readToggle(characterReferenceImagesEnabled, true)}
          />
          <SettingToggle
            settingKey="video.location_reference_images"
            label="Generate location reference images"
            hint="Opt-in. Adds ~$0.04 per location for an empty wide-shot reference. Off by default — locations are usually perceptually marginal in short-form video. Turn on after seeing character refs alone aren't holding the world together."
            initialOn={readToggle(locationReferenceImages, false)}
          />
          <SettingChipGroup<"kie/nano-banana-2" | "kie/nano-banana-pro" | "kie/gpt-image-2">
            settingKey="video.scene_image_model"
            label="Scene image model"
            hint="Which kie.ai model fires the scene calls. Nano-banana-2 ($0.04/image) supports reference-image conditioning and is the default. Pro ($0.09) trades cost for higher fidelity. gpt-image-2 ($0.05) has NO reference support — picking it effectively disables character ref images for scenes."
            initial={
              sceneImageModel === "kie/nano-banana-pro" || sceneImageModel === "kie/gpt-image-2"
                ? sceneImageModel
                : "kie/nano-banana-2"
            }
            options={[
              { id: "kie/nano-banana-2", label: "nano-banana-2 ($0.04)" },
              { id: "kie/nano-banana-pro", label: "nano-banana-pro ($0.09)" },
              { id: "kie/gpt-image-2", label: "gpt-image-2 ($0.05, no refs)" },
            ]}
          />
        </Section>

        <Section
          title="Pipeline"
          description="What the Python pipeline pulls and how much it spends."
        >
          <SubredditAutocomplete
            settingKey="pipeline.subreddit"
            label="Default subreddit"
            hint="Where the scraper pulls candidate posts from. Type to search Reddit — just the name, no r/ prefix."
            initial={subreddit ?? ""}
            placeholder="AmItheAsshole"
          />
          <SettingNumber
            settingKey="pipeline.limit"
            label="Posts per run"
            hint="How many candidate posts to process in a single pipeline run."
            initial={postsPerRun ?? "3"}
            min={1}
            max={20}
          />
          <SettingNumber
            settingKey="budget.daily_usd"
            label="Daily spend cap"
            hint="Soft cap the pipeline checks before spending on media. Resets every 24h rolling."
            initial={dailyBudget ?? "5"}
            min={1}
            max={500}
            prefix="$"
          />
          {/* Per-tick row cap for the Vercel cron drain (see
              `lorewire-app/api/drain_image_renders.py` and
              `_plans/2026-06-13-worker-host-stop-button-observability.md`).
              The Python handler reads this from the env var
              DRAIN_MAX_ROWS_PER_TICK, which the cron Pro-tier deploy
              wires up; this knob exists for visibility + future bump. */}
          <SettingNumber
            settingKey="media.cron_max_rows_per_tick"
            label="Cron drain rows per tick"
            hint="Hard cap on how many image regens the Vercel cron drains per minute. 6 fits inside the 60s function budget at ~7s/image average; bump higher only after watching it run for a week."
            initial={cronMaxRowsPerTick ?? "6"}
            min={1}
            max={60}
          />
        </Section>

        <Section
          title="Voice"
          description="Narrator voice settings used by the active TTS model."
        >
          <SettingSelect
            settingKey="voice.google_voice_name"
            label="Google voice"
            hint={`Voice used by every Google tier; the pipeline strips the locale prefix automatically when Gemini-TTS is active. ${googleOptions.length} voices in the catalog.`}
            initial={googleVoice ?? ""}
            options={googleOptions}
            placeholder="en-US-Chirp3-HD-Aoede"
            emptyHint="Google credentials not configured — paste a voice id manually for now."
          />
          <SettingSelect
            settingKey="voice.elevenlabs_voice_id"
            label="ElevenLabs voice"
            hint={`Used when ElevenLabs is the active model. ${elevenLabsOptions.length} voices from your library.`}
            initial={elevenLabsVoice ?? ""}
            options={elevenLabsOptions}
            placeholder="21m00Tcm4TlvDq8ikWAM"
            emptyHint="ElevenLabs API key not configured — paste a voice id manually for now."
          />
          <p className="rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[12px] text-muted">
            Narrator tone preset for Gemini-TTS lives in <strong className="text-ink">Style presets</strong> above.
          </p>
        </Section>

        <Section
          title="Video look"
          description="Scene count and motion effects applied during render. Visual style preset lives in Style presets above."
        >
          {/* Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: pick the
              default canvas shape for every NEW story. Existing stories
              keep their per-story aspect; the global default flips them
              only when the editor leaves the field unset. */}
          <SettingChipGroup<VideoAspect>
            settingKey="video.default_aspect"
            label="Default aspect ratio"
            hint="Used by every new story unless the editor overrides it. 16:9 fills the YouTube main feed + X / Twitter cards; 9:16 is for Shorts, TikTok, and Reels."
            initial={
              isVideoAspect(defaultAspect) ? defaultAspect : LEGACY_DEFAULT_ASPECT
            }
            options={ASPECT_CHIP_OPTIONS}
          />
          <SceneCountControls
            mode={sceneCountMode ?? ""}
            sceneCount={sceneCount ?? ""}
            targetSecondsPerScene={sceneTargetSecondsPerScene ?? ""}
          />
          <SettingToggle
            settingKey="video.ken_burns"
            label="Ken-Burns motion"
            hint="Slowly pan/zoom each scene image during its shot. Adds subtle motion when shots hold for 3+ seconds."
            initialOn={readToggle(kenBurns)}
          />
          <SettingToggle
            settingKey="video.micro_wiggle"
            label="Micro-wiggle"
            hint="Tiny sinusoidal rotation + translate on each held image (max 0.6 deg / 2 px). Composes with Ken-Burns."
            initialOn={readToggle(microWiggle)}
          />
          <SettingToggle
            settingKey="video.label_pop"
            label="Label pop on captions"
            hint="Each caption chunk pops a small bold label with the first word in a corner. Yellow box, dark outline."
            initialOn={readToggle(labelPop)}
          />
          <SettingToggle
            settingKey="video.scribble_draw"
            label="Scribble-draw on scene start"
            hint="Animated hand-doodled SVG stroke that draws on in a corner at each scene cut (800 ms reveal)."
            initialOn={readToggle(scribbleDraw)}
          />
          <SettingToggle
            settingKey="video.prop_slide"
            label="Prop slide-ins"
            hint="Small object cutouts slide in from rotating edges every ~20 s. The next --media pipeline run generates the cutouts via kie (~$0.05 each)."
            initialOn={readToggle(propSlide)}
          />
          <SettingNumber
            settingKey="media.prop_count"
            label="Props per story"
            hint="How many prop cutouts to generate when prop slide-ins are enabled. Only used when prop slide-ins is on."
            initial={propCount ?? "5"}
            min={3}
            max={10}
          />
          <SettingToggle
            settingKey="video.mouth_swap"
            label="MouthSwap talking head"
            hint="Small bottom-left bust of the protagonist with lip-flap mouth shapes timed to the narration. The next --media run generates a character portrait + mouth-removed copy via kie (~$0.10 / story)."
            initialOn={readToggle(mouthSwap)}
          />
        </Section>

        <Section
          title="Intro / outro splice"
          description="Master switch for the branded clips spliced onto every render. Manage the library and the active picks under Intros & outros."
        >
          <SettingToggle
            settingKey="video.intro_outro_enabled"
            label="Splice intros and outros"
            hint="When on, the active intro and outro are spliced onto every rendered video. Per-story overrides still apply. Defaults to on."
            initialOn={readToggle(introOutroEnabled, true)}
          />
        </Section>

        <Section
          title="Video editor"
          description="Per-frame image regen controls for /admin/videos/[id]. The cap is the safety net against a runaway click in the storyboard."
        >
          <SettingNumber
            settingKey="video.editor.frame_regen.session_cap_cents"
            label="Session cap (cents)"
            hint="Hard cap on frame regen spend per editor session. Counts completed regens at actual cost plus in-flight regens at the per-image estimate. Default 500 cents ($5)."
            initial={frameRegenSessionCapCents ?? "500"}
            min={50}
            max={10000}
          />
          <SettingChipGroup<"cover" | "contain">
            settingKey="video.preview_segment_fit"
            label="Preview intro/outro fit"
            hint="How the editor preview renders a resolved intro or outro when its actual file shape disagrees with the story canvas. Cover fills the frame and crops on mismatch — full-bleed look, but silently hides shape problems. Contain letterboxes — black bars expose any mismatch so a bad normalized file is obvious instead of looking like a mystery zoom. Default Cover."
            initial={previewSegmentFit === "contain" ? "contain" : "cover"}
            options={[
              { id: "cover", label: "Cover (fill, may crop)" },
              { id: "contain", label: "Contain (letterbox)" },
            ]}
          />
        </Section>

        <Section
          title="Caption defaults"
          description="Global caption appearance — color, motion, typography. Per-video overrides land in the video editor."
        >
          <Link
            href="/admin/templates"
            className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-ink">
                  Edit caption defaults
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  Position, typography, color, and motion for the global caption template.
                </p>
              </div>
              <span className="font-mono text-[14px] text-muted">→</span>
            </div>
          </Link>
        </Section>

        <Section
          title="Engagement — Polls"
          description="Story- and article-attached polls (the burnt-in question card on shorts + the on-site widget). Plan: _plans/2026-06-17-engagement-polls.md."
        >
          <SettingToggle
            settingKey={railEnabledSettingKey("divisive")}
            label="Most Divisive rail on the homepage"
            hint="Surface polls whose votes split closest to 50/50. Auto-hides when there's nothing above the floor; turn off to suppress the section entirely."
            initialOn={readToggle(railDivisive, true)}
          />
          <SettingToggle
            settingKey={railEnabledSettingKey("agreed")}
            label="Community Agreed rail on the homepage"
            hint="Surface the most lopsided polls. Same auto-hide behaviour as Divisive."
            initialOn={readToggle(railAgreed, true)}
          />
          <SettingToggle
            settingKey={railEnabledSettingKey("unpopular")}
            label="Unpopular Opinions rail on the homepage"
            hint="Personalized when the visitor has vote history; falls back to landslide stories otherwise."
            initialOn={readToggle(railUnpopular, true)}
          />
          <SettingNumber
            settingKey="polls.public_floor"
            label="Public reveal floor (vote count)"
            hint={`Below this total, the widget hides percentages and shows the pre-floor copy. Prevents misleading 100/0 readouts on fresh polls. Default ${DEFAULT_PUBLIC_FLOOR}.`}
            initial={publicFloorRaw ?? String(DEFAULT_PUBLIC_FLOOR)}
            min={0}
            max={1000}
            step={1}
          />
          <SettingToggle
            settingKey="polls.endcard.enabled"
            label="Burnt-in question card on shorts"
            hint="Bake the 2.5s end card into every short whose story has an enabled poll. Off = ship shorts without the card. Useful when A/B testing the social-platform funnel."
            initialOn={readToggle(endcardEnabled, true)}
          />
          <SettingNumber
            settingKey="polls.endcard.duration_ms"
            label="Card hold (ms)"
            hint="How long the burnt-in card stays on screen at the tail of the short. 500–10000ms. Default 2500ms. Out-of-range values fall back to the default at render time."
            initial={endcardDurationRaw ?? "2500"}
            min={500}
            max={10000}
            step={100}
          />
        </Section>

        <Section
          title="Engagement — Publisher caption hooks"
          description="Per-platform caption suffix appended when a short with an enabled poll is published. Empty = use the default for that platform. Substitution tokens: {question} and {slug}."
        >
          {PUBLISHER_PLATFORMS.map((platform) => (
            <SettingText
              key={platform}
              settingKey={pollHookSettingKey(platform)}
              label={`${platform[0].toUpperCase()}${platform.slice(1)} caption hook`}
              hint={`Default: ${DEFAULT_POLL_HOOK_TEMPLATES[platform].replace(/\n/g, "\\n")}`}
              initial={pollHookOverrides[platform]}
              placeholder="Leave empty to use the platform default"
            />
          ))}
        </Section>
      </div>
    </SettingsShell>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// Scene count controls: a single Auto / Manual chip group up top with
// the right secondary knob beneath it. Mirrors the pipeline's
// `_resolve_scene_count` precedence (override > manual > auto) so the
// admin and the renderer agree without round-tripping through reading
// the raw key namespace.
type SceneCountMode = "auto" | "manual";

const SCENE_COUNT_MODE_OPTIONS: ChipOption<SceneCountMode>[] = [
  {
    id: "auto",
    label: "Auto",
    hint: "LLM-style heuristic: one new scene every ~5 seconds of voiceover. Tunable below.",
  },
  {
    id: "manual",
    label: "Manual",
    hint: "Pin the exact scene count.",
  },
];

function SceneCountControls({
  mode,
  sceneCount,
  targetSecondsPerScene,
}: {
  mode: string;
  sceneCount: string;
  targetSecondsPerScene: string;
}) {
  const resolvedMode: SceneCountMode = mode === "manual" ? "manual" : "auto";
  return (
    <div className="space-y-3">
      <SettingChipGroup<SceneCountMode>
        settingKey="media.scene_count_mode"
        label="Scene count"
        hint="Auto picks a sensible scene count from the voiceover's length (≈ one new scene every N seconds). Manual pins an exact number that every story uses regardless of duration."
        initial={resolvedMode}
        options={SCENE_COUNT_MODE_OPTIONS}
      />
      {resolvedMode === "auto" ? (
        <SettingSlider
          settingKey="media.scene_count_target_seconds_per_scene"
          label="Seconds per scene"
          hint="The voiceover is divided by this number to pick how many scene images to generate. Lower = denser cuts (more images, more cost). Clamped to [6, 60] scenes per story."
          initial={targetSecondsPerScene || "5"}
          min={1}
          max={30}
          step={0.5}
          unit=" s"
          tickValue={5}
        />
      ) : (
        <SettingSlider
          settingKey="media.scene_count"
          label="Scenes per story"
          hint="Number of doodle scene images generated per story. 30 ≈ 4 s shots on a 2 min video; 60 ≈ 2 s shots."
          initial={sceneCount || "30"}
          min={6}
          max={60}
          step={1}
          tickValue={30}
        />
      )}
    </div>
  );
}
