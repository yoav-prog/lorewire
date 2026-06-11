import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { saveCaptionTemplateAction } from "@/app/admin/actions";
import { CaptionTemplatePreview } from "./preview";

// Wave 3 Phase 1: a single global caption template the admin can tune.
// Per-category and per-story override layers are Phase 2 (same resolver,
// new dropdown above the form). Fields mirror what DoodleShort.tsx reads
// through resolveCaptionTemplate() — defaults match the original
// doodle-yellow look so an admin starting from scratch sees the existing
// composition styling and edits forward from there.

const DEFAULTS: Record<string, string> = {
  "caption.position_y": "0.55",
  "caption.size_scale": "1",
  "caption.padding_x": "64",
  "caption.text_transform": "uppercase",
  "caption.letter_spacing": "-0.5",
  "caption.line_height": "1.05",
  "caption.font_weight": "900",
  "caption.color": "#facc15",
  "caption.outline_color": "#0f172a",
  "caption.outline_width": "6",
  "caption.active_word_color": "#ffffff",
  "caption.spoken_word_color": "rgba(250, 204, 21, 0.45)",
  "caption.entry_effect": "fade",
  "caption.word_highlight": "karaoke",
};

type FieldDef = {
  key: string;
  label: string;
  hint?: string;
} & (
  | { kind: "number"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "text" }
  | { kind: "select"; options: string[] }
);

const POSITION_FIELDS: FieldDef[] = [
  { key: "caption.position_y", label: "Position Y (0 = top, 1 = bottom)", kind: "number", min: 0, max: 1, step: 0.01, hint: "Where the caption band sits inside the 1920px-tall frame." },
  { key: "caption.size_scale", label: "Size scale", kind: "number", min: 0.5, max: 2, step: 0.05, hint: "Multiplier on the auto-sized base font (96 / 80 / 64 px for 2-4 / 5-6 / 7+ word chunks)." },
  { key: "caption.padding_x", label: "Side padding (px)", kind: "number", min: 0, max: 200, step: 4 },
];

const TYPOGRAPHY_FIELDS: FieldDef[] = [
  { key: "caption.text_transform", label: "Text transform", kind: "select", options: ["uppercase", "none", "lowercase"] },
  { key: "caption.font_weight", label: "Font weight", kind: "number", min: 100, max: 900, step: 100 },
  { key: "caption.letter_spacing", label: "Letter spacing (px)", kind: "number", min: -5, max: 5, step: 0.1 },
  { key: "caption.line_height", label: "Line height", kind: "number", min: 0.8, max: 2, step: 0.05 },
];

const COLOR_FIELDS: FieldDef[] = [
  { key: "caption.color", label: "Word color (default)", kind: "color" },
  { key: "caption.active_word_color", label: "Active word color", kind: "color", hint: "The word currently being spoken — sits on top of the body color." },
  { key: "caption.spoken_word_color", label: "Spoken word color", kind: "text", hint: "Past words; supports rgba() so a dim-then-fade effect works." },
  { key: "caption.outline_color", label: "Outline color", kind: "color" },
  { key: "caption.outline_width", label: "Outline width (px)", kind: "number", min: 0, max: 12, step: 1 },
];

const ANIMATION_FIELDS: FieldDef[] = [
  { key: "caption.entry_effect", label: "Entry effect", kind: "select", options: ["none", "fade", "pop", "slide-up"] },
  { key: "caption.word_highlight", label: "Word highlight style", kind: "select", options: ["none", "karaoke", "color", "scale", "background"], hint: "Karaoke is the classic dim-past + bright-current; none disables active-word emphasis entirely." },
];

const ALL_FIELDS: FieldDef[] = [
  ...POSITION_FIELDS,
  ...TYPOGRAPHY_FIELDS,
  ...COLOR_FIELDS,
  ...ANIMATION_FIELDS,
];

export default async function TemplatesPage() {
  await requireAdmin();
  // Pull current values in parallel; the empty-string fallback means a
  // never-saved field shows the default in the input rather than blank.
  const values: Record<string, string> = {};
  await Promise.all(
    ALL_FIELDS.map(async (f) => {
      const v = (await getSetting(f.key)) ?? "";
      values[f.key] = v || DEFAULTS[f.key] || "";
    }),
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Caption template
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          Global caption styling for every story the pipeline renders. The
          composition reads these on every render; existing renders pick up
          changes the next time you re-render. Empty fields fall back to the
          doodle-yellow defaults shown as placeholders.
        </p>
      </header>

      <form action={saveCaptionTemplateAction} className="space-y-7">
        {/* hidden prev-value pairs so the server action knows which fields
            actually changed and the audit log shows the diff */}
        {ALL_FIELDS.map((f) => (
          <input key={`prev-${f.key}`} type="hidden" name={`__prev__${f.key}`} value={values[f.key]} />
        ))}

        <FieldGroup title="Position & sizing" fields={POSITION_FIELDS} values={values} />
        <FieldGroup title="Typography" fields={TYPOGRAPHY_FIELDS} values={values} />
        <FieldGroup title="Color" fields={COLOR_FIELDS} values={values} />
        <FieldGroup title="Animation" fields={ANIMATION_FIELDS} values={values} />

        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted">
            Preview
          </p>
          <CaptionTemplatePreview defaults={values} />
        </div>

        <button
          type="submit"
          className="rounded-lg border border-accent bg-accent px-4 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent/90"
        >
          Save template
        </button>
      </form>
    </div>
  );
}

function FieldGroup({
  title,
  fields,
  values,
}: {
  title: string;
  fields: FieldDef[];
  values: Record<string, string>;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
        {title}
      </legend>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {fields.map((f) => (
          <FieldInput key={f.key} field={f} value={values[f.key]} />
        ))}
      </div>
    </fieldset>
  );
}

function FieldInput({ field, value }: { field: FieldDef; value: string }) {
  const baseClass =
    "min-w-[120px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
  let control;
  switch (field.kind) {
    case "number":
      control = (
        <input
          name={field.key}
          type="number"
          defaultValue={value}
          min={field.min}
          max={field.max}
          step={field.step}
          className={baseClass}
        />
      );
      break;
    case "color":
      control = (
        <input
          name={field.key}
          type="color"
          defaultValue={normalizeHex(value)}
          className="h-10 w-20 rounded-lg border border-line bg-bg p-1"
        />
      );
      break;
    case "select":
      control = (
        <select name={field.key} defaultValue={value} className={baseClass}>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case "text":
      control = (
        <input name={field.key} type="text" defaultValue={value} className={baseClass} />
      );
      break;
  }
  return (
    <label className="rounded-xl border border-line bg-surface p-3">
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">
        {field.label}
      </div>
      <div className="flex items-center gap-2">{control}</div>
      {field.hint && <p className="mt-2 text-[12px] text-muted">{field.hint}</p>}
    </label>
  );
}

// <input type="color"> only accepts #RRGGBB. rgba() values get the empty
// default; the text-typed spoken_word_color field is where rgba() lives.
function normalizeHex(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return "#000000";
}
