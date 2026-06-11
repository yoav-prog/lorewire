import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { saveSettingAction } from "@/app/admin/actions";
import SettingsShell from "@/app/admin/SettingsShell";

// Settings / General. The 17 pipeline settings live here, regrouped into
// named sections so the page reads top-to-bottom as a tour rather than a
// wall of cards. Each field is its own atomic save (existing pattern,
// keeps writes simple) but the visual weight is now the field, not the
// button. Per _plans/2026-06-12-admin-reorg-phase2.md §"Settings/General
// regrouped."

type Field = {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
};

type Section = {
  title: string;
  description?: string;
  fields: Field[];
};

const SECTIONS: Section[] = [
  {
    title: "Pipeline",
    description: "What the Python pipeline pulls and how much it spends.",
    fields: [
      {
        key: "pipeline.subreddit",
        label: "Default subreddit",
        placeholder: "AmItheAsshole",
        hint: "Where the scraper pulls candidate posts from.",
      },
      {
        key: "pipeline.limit",
        label: "Posts per run",
        placeholder: "3",
        hint: "How many posts to process in a single pipeline run.",
      },
      {
        key: "budget.daily_usd",
        label: "Daily spend cap (USD)",
        placeholder: "5",
        hint: "Soft cap the pipeline checks before spending on media.",
      },
    ],
  },
  {
    title: "Voice",
    description: "Narrator voice settings used by the active TTS model.",
    fields: [
      {
        key: "voice.google_voice_name",
        label: "Google voice name",
        placeholder: "en-US-Chirp3-HD-Aoede",
        hint: "Full Google voice id (e.g. en-US-Chirp3-HD-Charon). Used by every Google tier; the pipeline strips the locale prefix automatically when Gemini-TTS is active so the same setting works across tiers.",
      },
      {
        key: "voice.google_style_prompt",
        label: "Gemini-TTS style prompt",
        placeholder:
          "Read this in a calm, conversational tone, like a podcaster telling a story",
        hint: "Only used when a Google Gemini-TTS model is active. Steers delivery (pace, tone, emotion). Counts toward Google's combined 8000-byte cap with the narration text and shows up on the bill.",
      },
      {
        key: "voice.elevenlabs_voice_id",
        label: "ElevenLabs voice id",
        placeholder: "21m00Tcm4TlvDq8ikWAM",
        hint: "The narrator voice used when ElevenLabs is the active model.",
      },
    ],
  },
  {
    title: "Video look",
    description:
      "How generated videos look: scene count, motion, captions, talking-head, props.",
    fields: [
      {
        key: "video.style",
        label: "Video style note",
        placeholder: "doodle explainer, off-white paper, single marker",
        hint: "Steers the look of the generated short.",
      },
      {
        key: "media.scene_count",
        label: "Scenes per story",
        placeholder: "30",
        hint: "Number of doodle scene images the pipeline generates per story. 30 gives ~4 s shots on a 2 min video; 60 gives ~2 s shots. Clamped to 6-60; default 30.",
      },
      {
        key: "video.ken_burns",
        label: "Ken-Burns motion on scenes",
        placeholder: "0",
        hint: "Set to 1 to slowly pan/zoom each scene image during its shot. Off by default. Adds subtle motion when shots hold for 3+ seconds.",
      },
      {
        key: "video.micro_wiggle",
        label: "Micro-wiggle on scenes",
        placeholder: "0",
        hint: "Tiny sinusoidal rotation + translate on each held image. Subtle (max 0.6 deg / 2 px). Set to 1 to enable. Composes with Ken-Burns.",
      },
      {
        key: "video.label_pop",
        label: "Label pop on captions",
        placeholder: "0",
        hint: "Each caption chunk pops a small bold label with the first word in a corner. Yellow box, dark outline, scale-from-0.5 entry. Off by default.",
      },
      {
        key: "video.scribble_draw",
        label: "Scribble-draw on scene start",
        placeholder: "0",
        hint: "Animated hand-doodled SVG stroke that draws on in a corner at each scene cut. 800 ms reveal. Off by default.",
      },
      {
        key: "video.prop_slide",
        label: "Prop slide-ins",
        placeholder: "0",
        hint: "Set to 1 to enable. Small object cutouts slide in from rotating edges every ~20 s. The next --media pipeline run generates the cutouts via kie (~$0.05 each).",
      },
      {
        key: "media.prop_count",
        label: "Props per story",
        placeholder: "5",
        hint: "How many prop cutouts to generate when video.prop_slide is enabled. Clamped 3-10; default 5.",
      },
      {
        key: "video.mouth_swap",
        label: "MouthSwap talking head",
        placeholder: "0",
        hint: "Set to 1 to enable. A small bottom-left bust of the protagonist with lip-flap mouth shapes timed to the narration. The next --media run generates a character portrait + a mouth-removed copy via kie (~$0.10 / story).",
      },
    ],
  },
  {
    title: "Intro / outro splice",
    description:
      "Master switch for the branded clips spliced onto every render. Manage the library and active picks under Intros & outros.",
    fields: [
      {
        key: "video.intro_outro_enabled",
        label: "Intro / outro splice master switch",
        placeholder: "1",
        hint: "Set to 0 to disable intro and outro splicing for every render. Defaults to on when unset. The same value is editable directly on the Intros & outros page.",
      },
    ],
  },
];

export default async function SettingsPage() {
  await requireAdmin();
  const sectionsWithValues = await Promise.all(
    SECTIONS.map(async (s) => ({
      ...s,
      fields: await Promise.all(
        s.fields.map(async (f) => ({
          ...f,
          value: (await getSetting(f.key)) ?? "",
        })),
      ),
    })),
  );

  return (
    <SettingsShell
      active="general"
      title="General"
      description="Pipeline defaults and budgets. Read by the pipeline at run time."
    >
      <div className="space-y-7">
        {sectionsWithValues.map((s) => (
          <section key={s.title}>
            <div className="mb-3">
              <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
                {s.title}
              </h2>
              {s.description && (
                <p className="mt-0.5 text-[13px] text-muted">{s.description}</p>
              )}
            </div>
            <div className="space-y-3">
              {s.fields.map((f) => (
                <form
                  key={f.key}
                  action={saveSettingAction}
                  className="rounded-xl border border-line bg-surface p-4"
                >
                  <input type="hidden" name="key" value={f.key} />
                  <label className="mb-1 block text-[13px] font-semibold text-ink">
                    {f.label}
                  </label>
                  {f.hint && (
                    <p className="mb-2 text-[12px] text-muted">{f.hint}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      name="value"
                      defaultValue={f.value}
                      placeholder={f.placeholder}
                      className="min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
                    />
                    <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
                      Save
                    </button>
                  </div>
                </form>
              ))}
            </div>
          </section>
        ))}

        <section>
          <div className="mb-3">
            <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
              Caption defaults
            </h2>
            <p className="mt-0.5 text-[13px] text-muted">
              Global caption appearance settings — color, motion, typography. Per-video overrides land in the video editor.
            </p>
          </div>
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
        </section>
      </div>
    </SettingsShell>
  );
}
