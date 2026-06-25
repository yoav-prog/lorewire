import { requireCapability } from "@/lib/dal";
import { STAGES, STAGE_LABEL, options, allSelected } from "@/lib/models";
import { setModelAction } from "@/app/admin/actions";
import SettingsShell from "@/app/admin/SettingsShell";
import SettingsSection from "@/app/admin/SettingsSection";

export default async function ModelsPage() {
  await requireCapability("settings.manage");

  // One settings query for every stage, then build the view model in sync.
  const currentByStage = await allSelected();
  const stages = STAGES.map((st) => ({
    stage: st,
    label: STAGE_LABEL[st],
    opts: options(st),
    current: currentByStage[st],
  }));

  return (
    <SettingsShell
      active="models"
      title="Models"
      description="Pick the AI model for each pipeline stage. Selection is stored in the database and read by the pipeline at run time. API keys stay in the environment."
    >
      <div className="space-y-3">
        {stages.map(({ stage, label, opts, current }) => (
          <SettingsSection
            key={stage}
            title={label}
            status={{ ok: true, label: current }}
          >
            <form
              action={setModelAction}
              className="flex flex-wrap items-center gap-2"
            >
              <input type="hidden" name="stage" value={stage} />
              <select
                name="model"
                defaultValue={current}
                className="rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
              >
                {opts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} {o.wired ? "" : "(not wired yet)"}
                  </option>
                ))}
              </select>
              <button className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90">
                Save
              </button>
            </form>

            <ul className="mt-4 space-y-1.5">
              {opts.map((o) => (
                <li
                  key={o.id}
                  className="flex items-center justify-between gap-3 text-[13px]"
                >
                  <span className={o.id === current ? "text-ink" : "text-muted"}>
                    {o.id === current ? "● " : "○ "}
                    {o.label}
                  </span>
                  <span className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-muted">{o.cost}</span>
                    {!o.wired && (
                      <span className="rounded border border-line px-1.5 py-0.5 text-muted">
                        not wired
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </SettingsSection>
        ))}
      </div>
    </SettingsShell>
  );
}
