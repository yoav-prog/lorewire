"use client";

// Visual control grid for the Caption Templates page. Phase E of the
// admin UI overhaul (_plans/2026-06-12-admin-ui-overhaul.md): replaces
// the dropdown / number-stepper / native-color-picker mix with the
// Phase A component set (Slider, ColorPicker, ChipGroup) while keeping
// the existing form-submission contract — every visible control writes
// its value into a hidden `<input name="caption.{bare}">` that the
// `saveCaptionTemplateAction` server action picks up on Save.
//
// Inheritance: an empty value means "inherit from parent tier". Each
// field gets an Override / Inherit toggle so the admin can explicitly
// opt back into the parent's value. When inherited, the hidden input
// posts an empty string, matching the prior <input> default-empty
// semantics; the placeholder swatch / chip / slider reflects the
// parent's effective value so the field still looks live.
//
// Preview integration: the existing CaptionTemplatePreview attaches an
// `input` event listener to the form and filters by `target.name`. Our
// hidden inputs don't fire that event naturally, so on every value
// change we dispatch a synthetic bubbling Event on the hidden input
// from a useEffect. The preview's handler then reads `target.value`
// and updates accordingly — same contract, just with React in the
// driver's seat.
//
// Scoped to caption.* keys only. The wrapping form on /admin/templates
// also carries __scope / __cat / __story / __prev__ hidden inputs which
// stay outside this component.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChipGroup,
  ColorPicker,
  Slider,
  type ChipOption,
} from "@/components/ui";

export type FieldKind = "slider" | "color" | "chip" | "text" | "fontWeight";

export interface SliderFieldDef {
  bare: string;
  label: string;
  hint?: string;
  kind: "slider";
  min: number;
  max: number;
  step: number;
  unit?: string;
  endpoints?: [string, string];
  tickValue?: number;
}
export interface ColorFieldDef {
  bare: string;
  label: string;
  hint?: string;
  kind: "color";
}
export interface ChipFieldDef {
  bare: string;
  label: string;
  hint?: string;
  kind: "chip";
  options: { id: string; label: string; preview?: ReactNode }[];
}
export interface FontWeightFieldDef {
  bare: string;
  label: string;
  hint?: string;
  kind: "fontWeight";
}
export interface TextFieldDef {
  bare: string;
  label: string;
  hint?: string;
  kind: "text";
}

export type FieldDef =
  | SliderFieldDef
  | ColorFieldDef
  | ChipFieldDef
  | FontWeightFieldDef
  | TextFieldDef;

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

const FONT_WEIGHT_CHIPS: ChipOption<string>[] = [
  { id: "300", label: "Light", preview: <span style={{ fontWeight: 300 }}>Aa</span> },
  { id: "400", label: "Regular", preview: <span style={{ fontWeight: 400 }}>Aa</span> },
  { id: "500", label: "Medium", preview: <span style={{ fontWeight: 500 }}>Aa</span> },
  { id: "600", label: "Semibold", preview: <span style={{ fontWeight: 600 }}>Aa</span> },
  { id: "700", label: "Bold", preview: <span style={{ fontWeight: 700 }}>Aa</span> },
  { id: "800", label: "Heavy", preview: <span style={{ fontWeight: 800 }}>Aa</span> },
  { id: "900", label: "Black", preview: <span style={{ fontWeight: 900 }}>Aa</span> },
];

export function TemplateFieldGrid({
  sections,
  values,
  placeholders,
  scope,
}: {
  sections: SectionDef[];
  /** Explicit override values for THIS scope. Empty string = inherits
   *  from the parent tier. */
  values: Record<string, string>;
  /** What the field would inherit if left empty — used to populate the
   *  visual control when in "inherit" mode so it still looks live. */
  placeholders: Record<string, string>;
  scope: "global" | "cat" | "story";
}) {
  return (
    <div className="space-y-7">
      {sections.map((section) => (
        <fieldset key={section.title} className="space-y-3">
          <legend className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
            {section.title}
          </legend>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {section.fields.map((f) => (
              <TemplateField
                key={f.bare}
                def={f}
                initialOverride={values[f.bare] ?? ""}
                placeholder={placeholders[f.bare] ?? ""}
                scope={scope}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function TemplateField({
  def,
  initialOverride,
  placeholder,
  scope,
}: {
  def: FieldDef;
  initialOverride: string;
  placeholder: string;
  scope: "global" | "cat" | "story";
}) {
  // At global scope every field is always an explicit value — there's
  // no parent tier to inherit from. At cat/story scope an empty
  // initialOverride means the field currently inherits.
  const canInherit = scope !== "global";
  const startsAsOverride = !canInherit || initialOverride !== "";
  const [override, setOverride] = useState(startsAsOverride);
  const [value, setValue] = useState(
    initialOverride || placeholder || defaultsForKind(def),
  );
  // Hidden input is the source of truth for form submission. When the
  // user toggles to "inherit", we post an empty string so the server
  // action clears the override at this tier.
  const hiddenRef = useRef<HTMLInputElement>(null);
  const postedValue = override ? value : "";

  // Sync the hidden input + fire a synthetic input event so the live
  // preview component (which listens to form `input` events) picks
  // up the change. Without the dispatch, controlled hidden inputs are
  // invisible to the preview. The mount guard skips the first run so
  // we don't clobber the preview's server-supplied defaults — those
  // already include the inherited placeholder values.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    const el = hiddenRef.current;
    if (!el) return;
    const ev = new Event("input", { bubbles: true });
    el.dispatchEvent(ev);
  }, [postedValue]);

  const inputName = `caption.${def.bare}`;

  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-field={def.bare}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted">
          {def.label}
        </div>
        {canInherit && (
          <button
            type="button"
            role="switch"
            aria-checked={override}
            onClick={() => setOverride((o) => !o)}
            className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors ${
              override
                ? "border-accent text-accent hover:bg-accent/10"
                : "border-line text-muted hover:border-ink hover:text-ink"
            }`}
            title={
              override
                ? "Override active. Click to inherit from the parent tier."
                : "Inheriting from parent. Click to override at this tier."
            }
          >
            {override ? "Override" : "Inherit"}
          </button>
        )}
      </div>
      <div className={override ? "" : "opacity-50"}>
        <FieldControl
          def={def}
          value={value}
          onChange={setValue}
          disabled={!override}
        />
      </div>
      <input ref={hiddenRef} type="hidden" name={inputName} value={postedValue} />
      {def.hint && (
        <p className="mt-2 text-[11px] leading-snug text-muted">{def.hint}</p>
      )}
      {canInherit && (
        <p className="mt-1.5 font-mono text-[10px] text-muted">
          {override ? (
            <>Override · effective <span className="text-ink">{value}</span></>
          ) : (
            <>Inherits · effective <span className="text-ink">{placeholder || "—"}</span></>
          )}
        </p>
      )}
    </div>
  );
}

function FieldControl({
  def,
  value,
  onChange,
  disabled,
}: {
  def: FieldDef;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  if (def.kind === "slider") {
    const parsed = parseFloat(value);
    const safe = Number.isFinite(parsed) ? parsed : def.min;
    return (
      <Slider
        value={Math.max(def.min, Math.min(def.max, safe))}
        min={def.min}
        max={def.max}
        step={def.step}
        unit={def.unit}
        endpoints={def.endpoints}
        tickValue={def.tickValue}
        onChange={(n) => onChange(String(n))}
        ariaLabel={def.label}
        disabled={disabled}
      />
    );
  }
  if (def.kind === "color") {
    return (
      <ColorPicker
        value={value || "#000000"}
        onChange={onChange}
        ariaLabel={def.label}
        disabled={disabled}
      />
    );
  }
  if (def.kind === "fontWeight") {
    return (
      <ChipGroup
        value={value}
        options={FONT_WEIGHT_CHIPS}
        onChange={onChange}
        ariaLabel={def.label}
        disabled={disabled}
      />
    );
  }
  if (def.kind === "chip") {
    return (
      <ChipGroup
        value={value}
        options={def.options as ChipOption<string>[]}
        onChange={onChange}
        ariaLabel={def.label}
        disabled={disabled}
      />
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      spellCheck={false}
      className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink focus:border-accent focus:outline-none disabled:opacity-60"
      aria-label={def.label}
    />
  );
}

function defaultsForKind(def: FieldDef): string {
  if (def.kind === "slider") return String(def.min);
  if (def.kind === "color") return "#000000";
  if (def.kind === "chip") return def.options[0]?.id ?? "";
  if (def.kind === "fontWeight") return "400";
  return "";
}
