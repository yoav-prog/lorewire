import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { getSetting, listStories } from "@/lib/repo";
import { saveCaptionTemplateAction } from "@/app/admin/actions";
import { CaptionTemplatePreview } from "./preview";

// Wave 3 Phase 2: the global template from Phase 1 is now the bottom of a
// three-tier scope chain (per-story > per-category > global > defaults). The
// editor picks one tier at a time so the admin sees the explicit override
// values, with the inherited value shown as placeholder hint.
//
// URL scheme:
//   /admin/templates                            -> global tier
//   /admin/templates?scope=cat&cat=Drama        -> Drama category overrides
//   /admin/templates?scope=story&story=envelope -> envelope per-story overrides
//
// Per-story / per-category overrides are sparse: a field left empty inherits
// from the parent tier. The pipeline-side resolve_caption_template_for()
// walks the chain at render time.

const CATEGORIES = ["Drama", "Entitled", "Humor", "Wholesome", "Dating", "Roommate"] as const;

const DEFAULTS: Record<string, string> = {
  "position_y": "0.55",
  "size_scale": "1",
  "padding_x": "64",
  "text_transform": "uppercase",
  "letter_spacing": "-0.5",
  "line_height": "1.05",
  "font_weight": "900",
  "color": "#facc15",
  "outline_color": "#0f172a",
  "outline_width": "6",
  "active_word_color": "#ffffff",
  "spoken_word_color": "rgba(250, 204, 21, 0.45)",
  "entry_effect": "fade",
  "word_highlight": "karaoke",
};

type FieldDef = {
  bare: string; // the bare field name (e.g. "position_y")
  label: string;
  hint?: string;
} & (
  | { kind: "number"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "text" }
  | { kind: "select"; options: string[] }
);

const POSITION_FIELDS: FieldDef[] = [
  { bare: "position_y", label: "Position Y (0 = top, 1 = bottom)", kind: "number", min: 0, max: 1, step: 0.01, hint: "Where the caption band sits inside the 1920px-tall frame." },
  { bare: "size_scale", label: "Size scale", kind: "number", min: 0.5, max: 2, step: 0.05, hint: "Multiplier on the auto-sized base font (96 / 80 / 64 px for 2-4 / 5-6 / 7+ word chunks)." },
  { bare: "padding_x", label: "Side padding (px)", kind: "number", min: 0, max: 200, step: 4 },
];

const TYPOGRAPHY_FIELDS: FieldDef[] = [
  { bare: "text_transform", label: "Text transform", kind: "select", options: ["uppercase", "none", "lowercase"] },
  { bare: "font_weight", label: "Font weight", kind: "number", min: 100, max: 900, step: 100 },
  { bare: "letter_spacing", label: "Letter spacing (px)", kind: "number", min: -5, max: 5, step: 0.1 },
  { bare: "line_height", label: "Line height", kind: "number", min: 0.8, max: 2, step: 0.05 },
];

const COLOR_FIELDS: FieldDef[] = [
  { bare: "color", label: "Word color (default)", kind: "color" },
  { bare: "active_word_color", label: "Active word color", kind: "color", hint: "The word currently being spoken." },
  { bare: "spoken_word_color", label: "Spoken word color", kind: "text", hint: "Past words; supports rgba()." },
  { bare: "outline_color", label: "Outline color", kind: "color" },
  { bare: "outline_width", label: "Outline width (px)", kind: "number", min: 0, max: 12, step: 1 },
];

const ANIMATION_FIELDS: FieldDef[] = [
  { bare: "entry_effect", label: "Entry effect", kind: "select", options: ["none", "fade", "pop", "slide-up"] },
  { bare: "word_highlight", label: "Word highlight style", kind: "select", options: ["none", "karaoke", "color", "scale", "background"], hint: "Karaoke is the dim-past + bright-current default." },
];

const ALL_FIELDS: FieldDef[] = [
  ...POSITION_FIELDS,
  ...TYPOGRAPHY_FIELDS,
  ...COLOR_FIELDS,
  ...ANIMATION_FIELDS,
];

// Key prefix for a given scope. Empty story/cat falls back to global so a
// missing search param defaults safely.
function prefixFor(scope: string, cat?: string, story?: string): string {
  if (scope === "story" && story) return `caption.story.${story}`;
  if (scope === "cat" && cat) return `caption.cat.${cat}`;
  return "caption";
}

// Pulls the value at the immediate parent tier so the form can show what the
// admin's field would inherit if left empty. story -> cat -> global -> default.
async function inheritedValue(
  bare: string,
  scope: string,
  cat?: string,
  story?: string,
): Promise<string> {
  if (scope === "story") {
    if (cat) {
      const v = await getSetting(`caption.cat.${cat}.${bare}`);
      if (v) return v;
    }
    const v = await getSetting(`caption.${bare}`);
    if (v) return v;
  } else if (scope === "cat") {
    const v = await getSetting(`caption.${bare}`);
    if (v) return v;
  }
  return DEFAULTS[bare];
}

interface PageProps {
  searchParams: Promise<{ scope?: string; cat?: string; story?: string }>;
}

export default async function TemplatesPage({ searchParams }: PageProps) {
  await requireAdmin();
  const params = await searchParams;
  const scope = params.scope === "cat" || params.scope === "story" ? params.scope : "global";
  const cat = params.cat;
  const story = params.story;
  const prefix = prefixFor(scope, cat, story);

  // Stories list for the story-scope dropdown. Cap at 100 — the admin can
  // type-search via the browser's built-in select filtering.
  const stories: { id: string; title: string }[] =
    scope === "story"
      ? (await listStories({ limit: 100 })).map((s) => ({
          id: s.id,
          title: s.title || s.id,
        }))
      : [];

  // Explicit override values at THIS scope (empty = inherits). Also pull what
  // each field would inherit so the placeholder shows the effective value.
  const values: Record<string, string> = {};
  const placeholders: Record<string, string> = {};
  await Promise.all(
    ALL_FIELDS.map(async (f) => {
      values[f.bare] = (await getSetting(`${prefix}.${f.bare}`)) ?? "";
      placeholders[f.bare] = scope === "global"
        ? DEFAULTS[f.bare]
        : await inheritedValue(f.bare, scope, cat, story);
    }),
  );

  const scopeLabel = scope === "story"
    ? `Story: ${stories.find((s) => s.id === story)?.title ?? story ?? "(none selected)"}`
    : scope === "cat"
    ? `Category: ${cat ?? "(none selected)"}`
    : "Global template";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Caption template
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          The Remotion composition reads these on every render and walks
          story &rarr; category &rarr; global &rarr; defaults. Per-tier values
          are sparse — leaving a field empty here means it inherits from the
          parent tier (the placeholder shows what that inherited value is).
        </p>
      </header>

      <ScopeSwitcher current={scope} cat={cat} story={story} stories={stories} />

      <div className="rounded-xl border border-line bg-surface2 px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">Editing:</span>{" "}
        <span className="font-display text-[14px] font-semibold text-ink">{scopeLabel}</span>
      </div>

      <form action={saveCaptionTemplateAction} className="space-y-7">
        <input type="hidden" name="__scope" value={scope} />
        {cat && <input type="hidden" name="__cat" value={cat} />}
        {story && <input type="hidden" name="__story" value={story} />}
        {ALL_FIELDS.map((f) => (
          <input key={`prev-${f.bare}`} type="hidden" name={`__prev__${f.bare}`} value={values[f.bare]} />
        ))}

        <FieldGroup title="Position & sizing" fields={POSITION_FIELDS} values={values} placeholders={placeholders} />
        <FieldGroup title="Typography" fields={TYPOGRAPHY_FIELDS} values={values} placeholders={placeholders} />
        <FieldGroup title="Color" fields={COLOR_FIELDS} values={values} placeholders={placeholders} />
        <FieldGroup title="Animation" fields={ANIMATION_FIELDS} values={values} placeholders={placeholders} />

        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted">
            Preview (live)
          </p>
          {/* Preview always uses the *effective* values for this scope: explicit
              if set, inherited otherwise. The preview component reads the form
              inputs directly so typing updates the preview in real time. */}
          <CaptionTemplatePreview
            defaults={Object.fromEntries(
              ALL_FIELDS.map((f) => [
                `caption.${f.bare}`,
                values[f.bare] || placeholders[f.bare],
              ]),
            )}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg border border-accent bg-accent px-4 py-2 text-[14px] font-semibold text-bg transition-colors hover:bg-accent/90"
          >
            Save {scope === "global" ? "global" : scope === "cat" ? `${cat} overrides` : "story overrides"}
          </button>
          {scope !== "global" && (
            <p className="text-[12px] text-muted">
              Empty fields will inherit from the parent tier.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

function ScopeSwitcher({
  current,
  cat,
  story,
  stories,
}: {
  current: string;
  cat?: string;
  story?: string;
  stories: { id: string; title: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
      <ScopeTab href="/admin/templates" active={current === "global"} label="Global" />
      <span className="text-line">|</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">Category:</span>
        {CATEGORIES.map((c) => (
          <ScopeTab
            key={c}
            href={`/admin/templates?scope=cat&cat=${encodeURIComponent(c)}`}
            active={current === "cat" && cat === c}
            label={c}
          />
        ))}
      </div>
      <span className="text-line">|</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">Story:</span>
        <form method="GET" action="/admin/templates" className="flex items-center gap-2">
          <input type="hidden" name="scope" value="story" />
          <select
            name="story"
            defaultValue={current === "story" ? story : ""}
            className="rounded-lg border border-line bg-bg px-2 py-1 text-[13px] text-ink"
          >
            <option value="">— select story —</option>
            {stories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-line px-2 py-1 text-[12px] text-ink hover:border-accent"
          >
            Edit
          </button>
        </form>
      </div>
    </div>
  );
}

function ScopeTab({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active ? "bg-accent text-bg" : "text-muted hover:text-ink hover:bg-surface2"
      }`}
    >
      {label}
    </Link>
  );
}

function FieldGroup({
  title,
  fields,
  values,
  placeholders,
}: {
  title: string;
  fields: FieldDef[];
  values: Record<string, string>;
  placeholders: Record<string, string>;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
        {title}
      </legend>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {fields.map((f) => (
          <FieldInput
            key={f.bare}
            field={f}
            value={values[f.bare]}
            placeholder={placeholders[f.bare]}
          />
        ))}
      </div>
    </fieldset>
  );
}

function FieldInput({
  field,
  value,
  placeholder,
}: {
  field: FieldDef;
  value: string;
  placeholder: string;
}) {
  const baseClass =
    "min-w-[120px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent placeholder:text-muted/50";
  const inputName = `caption.${field.bare}`;
  let control;
  switch (field.kind) {
    case "number":
      control = (
        <input
          name={inputName}
          type="number"
          defaultValue={value}
          placeholder={placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
          className={baseClass}
        />
      );
      break;
    case "color":
      // Color picker can't show "inherit" — when override is empty, use a
      // text input so the user can see/edit hex AND inherit by clearing.
      control = value ? (
        <input
          name={inputName}
          type="color"
          defaultValue={normalizeHex(value)}
          className="h-10 w-20 rounded-lg border border-line bg-bg p-1"
        />
      ) : (
        <input
          name={inputName}
          type="text"
          defaultValue=""
          placeholder={placeholder}
          className={baseClass}
        />
      );
      break;
    case "select":
      control = (
        <select name={inputName} defaultValue={value} className={baseClass}>
          <option value="">— inherit ({placeholder}) —</option>
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
        <input
          name={inputName}
          type="text"
          defaultValue={value}
          placeholder={placeholder}
          className={baseClass}
        />
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

function normalizeHex(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return "#000000";
}
