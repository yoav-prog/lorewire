import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { saveSettingAction } from "@/app/admin/actions";

const FIELDS: { key: string; label: string; placeholder: string; hint?: string }[] =
  [
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
    {
      key: "voice.elevenlabs_voice_id",
      label: "ElevenLabs voice id",
      placeholder: "21m00Tcm4TlvDq8ikWAM",
      hint: "The narrator voice used when ElevenLabs is the active model.",
    },
    {
      key: "video.style",
      label: "Video style note",
      placeholder: "doodle explainer, off-white paper, single marker",
      hint: "Steers the look of the generated short.",
    },
  ];

export default async function SettingsPage() {
  await requireAdmin();
  const fields = await Promise.all(
    FIELDS.map(async (f) => ({ ...f, value: (await getSetting(f.key)) ?? "" })),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Settings
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          Pipeline defaults and budgets. Read by the pipeline at run time.
        </p>
      </div>

      <div className="space-y-3">
        {fields.map((f) => (
          <form
            key={f.key}
            action={saveSettingAction}
            className="rounded-xl border border-line bg-surface p-4"
          >
            <input type="hidden" name="key" value={f.key} />
            <label className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted">
              {f.label}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                name="value"
                defaultValue={f.value}
                placeholder={f.placeholder}
                className="min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
              />
              <button className="rounded-lg border border-line px-4 py-2 text-[14px] text-ink transition-colors hover:border-accent hover:text-accent">
                Save
              </button>
            </div>
            {f.hint && <p className="mt-2 text-[12px] text-muted">{f.hint}</p>}
          </form>
        ))}
      </div>
    </div>
  );
}
