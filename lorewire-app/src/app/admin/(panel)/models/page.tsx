import { requireAdmin } from "@/lib/dal";
import { STAGES, STAGE_LABEL, options, selected } from "@/lib/models";
import { setModelAction } from "@/app/admin/actions";

export default async function ModelsPage() {
  await requireAdmin();

  const stages = await Promise.all(
    STAGES.map(async (st) => ({
      stage: st,
      label: STAGE_LABEL[st],
      opts: options(st),
      current: await selected(st),
    })),
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Models
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          Pick the model for each stage. Selection is stored in the database and
          read by the pipeline at run time. API keys stay in the environment.
        </p>
      </div>

      {stages.map(({ stage, label, opts, current }) => (
        <section key={stage} className="rounded-xl border border-line bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-mono text-[12px] uppercase tracking-wider text-muted">
              {label}
            </h2>
            <span className="font-mono text-[11px] text-ink">{current}</span>
          </div>

          <form action={setModelAction} className="flex flex-wrap items-center gap-2">
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
        </section>
      ))}
    </div>
  );
}
