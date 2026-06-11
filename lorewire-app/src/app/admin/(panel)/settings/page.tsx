import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { listGoogleVoices, listElevenLabsVoices } from "@/lib/voice-providers";
import SettingsShell from "@/app/admin/SettingsShell";
import {
  SettingToggle,
  SettingNumber,
  SettingPresetText,
  SettingSelect,
  type SelectOption,
} from "./_components/SettingControls";
import { SubredditAutocomplete } from "./_components/SubredditAutocomplete";

// Settings / General. Every field now uses the right control: toggles for
// the booleans (previously stringy "0"/"1"), number inputs with min/max for
// the count fields, preset chips on the style + Gemini prompt fields. Voice
// id fields stay text for now — API-backed dropdowns from Google Cloud TTS
// and ElevenLabs land in the follow-up commit once provider credentials
// are wired into the Node side.

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
  await requireAdmin();

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
    listGoogleVoices(),
    listElevenLabsVoices(),
  ]);

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
          <SettingPresetText
            settingKey="voice.google_style_prompt"
            label="Gemini-TTS style prompt"
            hint="Only used when a Google Gemini-TTS model is active. Steers delivery (pace, tone, emotion). Counts toward Google's combined 8000-byte cap with the narration text."
            initial={geminiPrompt ?? ""}
            presets={GEMINI_PROMPT_PRESETS}
            placeholder="Read this in a calm, conversational tone, like a podcaster telling a story"
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
        </Section>

        <Section
          title="Video look"
          description="Visual style, scene count, and motion effects applied during render."
        >
          <SettingPresetText
            settingKey="video.style"
            label="Video style note"
            hint="Steers the look of the generated short. Reuses across the scene image generator."
            initial={videoStyle ?? ""}
            presets={STYLE_PRESETS}
            placeholder="doodle explainer, off-white paper, single marker"
          />
          <SettingNumber
            settingKey="media.scene_count"
            label="Scenes per story"
            hint="Number of doodle scene images generated per story. 30 ≈ 4 s shots on a 2 min video; 60 ≈ 2 s shots."
            initial={sceneCount ?? "30"}
            min={6}
            max={60}
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
