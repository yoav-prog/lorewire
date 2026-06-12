"use client";

// Per-story caption style editor. Phase B of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md): rebuilt end-to-end on the
// Phase A component library — sliders for every numeric, ColorPicker
// for every color, ChipGroup for every enumerated value, AutoSave
// indicator at the top of the panel, presets row with 6 built-ins +
// "Save current as preset", and zero per-field Save buttons.
//
// Inheritance chain (unchanged from the old panel): story → category →
// global → defaults. Clearing an override falls back to the parent.
// The Reset link on each FieldRow clears just that one field.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  applyCaptionStylePresetAction,
  clearStoryCaptionOverridesAction,
  saveStoryCaptionStyleAction,
  saveUserCaptionPresetAction,
} from "@/app/admin/actions";
import type {
  CaptionStyleField,
  ResolvedCaptionStyle,
} from "@/lib/caption-style";
import {
  BUILT_IN_CAPTION_PRESETS,
  type CaptionPreset,
  type CaptionStyleValues,
} from "@/lib/caption-presets";
import {
  AutoSaveStatus,
  ChipGroup,
  ColorPicker,
  FieldRow,
  Slider,
  useDebouncedSave,
  type AutoSaveState,
} from "@/components/ui";
import { SavePresetModal } from "./SavePresetModal";

// ─── Field schema (numeric ranges, chip options) ────────────────────────────

interface SliderSpec {
  kind: "slider";
  min: number;
  max: number;
  step: number;
  unit?: string;
  endpoints?: [string, string];
  tickValue?: number;
}
interface ChipSpec {
  kind: "chip";
  options: ChipOptionSpec[];
}
interface ChipOptionSpec {
  id: string;
  label: string;
  /** Optional text rendered inside the chip styled to demo the choice
   *  (e.g. the word "Aa" at the chip's font weight). */
  preview?: { text: string; style?: React.CSSProperties };
}
interface ColorSpec {
  kind: "color";
}
interface FontWeightSpec {
  kind: "fontWeight";
}
interface TextSpec {
  kind: "text";
}

type FieldSpec = SliderSpec | ChipSpec | ColorSpec | FontWeightSpec | TextSpec;

const FIELD_SPECS: Record<CaptionStyleField, FieldSpec> = {
  position_y: {
    kind: "slider",
    min: 0,
    max: 1,
    step: 0.01,
    endpoints: ["TOP", "BOTTOM"],
    tickValue: 0.55,
  },
  size_scale: {
    kind: "slider",
    min: 0.5,
    max: 2,
    step: 0.05,
    endpoints: ["S", "L"],
    tickValue: 1,
  },
  padding_x: {
    kind: "slider",
    min: 0,
    max: 200,
    step: 4,
    unit: "px",
  },
  text_transform: {
    kind: "chip",
    options: [
      { id: "uppercase", label: "Aa", preview: { text: "AA", style: { textTransform: "uppercase" } } },
      { id: "none", label: "As-is", preview: { text: "Aa", style: { textTransform: "none" } } },
      { id: "lowercase", label: "aa", preview: { text: "aa", style: { textTransform: "lowercase" } } },
    ],
  },
  font_weight: { kind: "fontWeight" },
  letter_spacing: {
    kind: "slider",
    min: -5,
    max: 5,
    step: 0.1,
    unit: "px",
    tickValue: 0,
  },
  line_height: {
    kind: "slider",
    min: 0.8,
    max: 2,
    step: 0.05,
    tickValue: 1,
  },
  color: { kind: "color" },
  active_word_color: { kind: "color" },
  spoken_word_color: { kind: "text" },
  outline_color: { kind: "color" },
  outline_width: {
    kind: "slider",
    min: 0,
    max: 12,
    step: 1,
    unit: "px",
  },
  entry_effect: {
    kind: "chip",
    options: [
      { id: "none", label: "None" },
      { id: "fade", label: "Fade" },
      { id: "pop", label: "Pop" },
      { id: "slide-up", label: "Slide up" },
    ],
  },
  word_highlight: {
    kind: "chip",
    options: [
      { id: "none", label: "None" },
      { id: "karaoke", label: "Karaoke" },
      { id: "color", label: "Color" },
      { id: "scale", label: "Scale" },
      { id: "background", label: "Background" },
    ],
  },
};

const FIELD_LABELS: Record<CaptionStyleField, string> = {
  position_y: "Position Y",
  size_scale: "Size scale",
  padding_x: "Side padding",
  text_transform: "Text transform",
  font_weight: "Font weight",
  letter_spacing: "Letter spacing",
  line_height: "Line height",
  color: "Word color (default)",
  active_word_color: "Active word color",
  spoken_word_color: "Spoken word color (rgba ok)",
  outline_color: "Outline color",
  outline_width: "Outline width",
  entry_effect: "Entry effect",
  word_highlight: "Word highlight",
};

interface SectionDef {
  title: string;
  description: string;
  fields: CaptionStyleField[];
}

const SECTIONS: SectionDef[] = [
  {
    title: "Position & size",
    description: "Where the caption sits inside the 1920px-tall frame.",
    fields: ["position_y", "size_scale", "padding_x"],
  },
  {
    title: "Typography",
    description: "Letterforms — weight, transform, spacing.",
    fields: ["text_transform", "font_weight", "letter_spacing", "line_height"],
  },
  {
    title: "Color",
    description: "Word colors, outline, and the karaoke active/spoken pair.",
    fields: [
      "color",
      "active_word_color",
      "spoken_word_color",
      "outline_color",
      "outline_width",
    ],
  },
  {
    title: "Animation",
    description: "How chunks enter and how words highlight in time with the audio.",
    fields: ["entry_effect", "word_highlight"],
  },
];

const FONT_WEIGHT_CHIPS: ChipOptionSpec[] = [
  { id: "300", label: "Light", preview: { text: "Aa", style: { fontWeight: 300 } } },
  { id: "400", label: "Regular", preview: { text: "Aa", style: { fontWeight: 400 } } },
  { id: "500", label: "Medium", preview: { text: "Aa", style: { fontWeight: 500 } } },
  { id: "600", label: "Semibold", preview: { text: "Aa", style: { fontWeight: 600 } } },
  { id: "700", label: "Bold", preview: { text: "Aa", style: { fontWeight: 700 } } },
  { id: "800", label: "Heavy", preview: { text: "Aa", style: { fontWeight: 800 } } },
  { id: "900", label: "Black", preview: { text: "Aa", style: { fontWeight: 900 } } },
];

// ─── Panel ──────────────────────────────────────────────────────────────────

export default function CaptionStylePanel({
  storyId,
  resolved,
  userPresets,
}: {
  storyId: string;
  resolved: ResolvedCaptionStyle;
  userPresets: CaptionPreset[];
}) {
  const router = useRouter();
  const allPresets = useMemo(
    () => [...BUILT_IN_CAPTION_PRESETS, ...userPresets],
    [userPresets],
  );
  const [saveModalOpen, setSaveModalOpen] = useState(false);

  // Worst state across every field-level save indicator. Surfaces a
  // single panel-level status without each field needing its own pill.
  const [fieldStates, setFieldStates] = useState<
    Record<CaptionStyleField, AutoSaveState>
  >({} as Record<CaptionStyleField, AutoSaveState>);
  const aggregateState: AutoSaveState = useMemo(() => {
    const vals = Object.values(fieldStates);
    if (vals.some((s) => s === "error")) return "error";
    if (vals.some((s) => s === "saving")) return "saving";
    if (vals.some((s) => s === "saved")) return "saved";
    return "idle";
  }, [fieldStates]);

  function reportState(field: CaptionStyleField, state: AutoSaveState) {
    setFieldStates((prev) => {
      if (prev[field] === state) return prev;
      return { ...prev, [field]: state };
    });
  }

  async function handleApplyPreset(presetId: string) {
    const r = await applyCaptionStylePresetAction(storyId, presetId);
    if (r.ok) router.refresh();
  }

  async function handleClearAll() {
    if (!confirm("Clear all per-story caption overrides? Fields fall back to category → global → defaults.")) {
      return;
    }
    const r = await clearStoryCaptionOverridesAction(storyId);
    if (r.ok) router.refresh();
  }

  async function handleSaveAsPreset(name: string) {
    const values: CaptionStyleValues = {} as CaptionStyleValues;
    for (const f of Object.keys(resolved.fields) as CaptionStyleField[]) {
      values[f] = resolved.fields[f].effective;
    }
    const r = await saveUserCaptionPresetAction({ name, values });
    if (r.ok) {
      setSaveModalOpen(false);
      router.refresh();
    }
    return r;
  }

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Caption style · per video
          </p>
          <p className="text-[12px] leading-relaxed text-muted">
            Overrides for this video only. Each control auto-saves 500ms after
            you stop dragging.
          </p>
        </div>
        <AutoSaveStatus state={aggregateState} hideIdle={false} />
      </header>

      <PresetsRow
        presets={allPresets}
        currentEffective={resolved}
        onApply={handleApplyPreset}
        onSaveCurrent={() => setSaveModalOpen(true)}
        onClearAll={handleClearAll}
      />

      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-2">
          <div>
            <h3 className="text-[12px] font-semibold text-ink">
              {section.title}
            </h3>
            <p className="text-[11px] text-muted">{section.description}</p>
          </div>
          <div className="space-y-2">
            {section.fields.map((field) => (
              <CaptionField
                key={field}
                storyId={storyId}
                field={field}
                resolved={resolved}
                onReportState={(s) => reportState(field, s)}
              />
            ))}
          </div>
        </section>
      ))}

      {saveModalOpen && (
        <SavePresetModal
          onCancel={() => setSaveModalOpen(false)}
          onSave={handleSaveAsPreset}
        />
      )}
    </div>
  );
}

// ─── PresetsRow ─────────────────────────────────────────────────────────────

function PresetsRow({
  presets,
  currentEffective,
  onApply,
  onSaveCurrent,
  onClearAll,
}: {
  presets: CaptionPreset[];
  currentEffective: ResolvedCaptionStyle;
  onApply: (id: string) => void;
  onSaveCurrent: () => void;
  onClearAll: () => void;
}) {
  // A preset is the "current match" iff every one of its 14 fields'
  // values equals the resolved effective value. Strict equality keeps
  // the UI honest — a slight drift shows the user that they've
  // diverged from any built-in.
  const currentMatchId = useMemo(() => {
    return presets.find((p) =>
      (Object.keys(p.values) as CaptionStyleField[]).every(
        (k) => p.values[k] === currentEffective.fields[k].effective,
      ),
    )?.id;
  }, [presets, currentEffective]);

  return (
    <section className="space-y-2 rounded-xl border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Presets
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveCurrent}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Save current
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-danger hover:text-danger"
          >
            Clear all
          </button>
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {presets.map((p) => {
          const selected = p.id === currentMatchId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onApply(p.id)}
              title={p.tagline}
              data-preset-id={p.id}
              aria-pressed={selected}
              className={`flex shrink-0 flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-accent bg-accent/15"
                  : "border-line bg-bg hover:border-ink"
              }`}
            >
              <PresetSwatch values={p.values} />
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink">
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PresetSwatch({ values }: { values: CaptionStyleValues }) {
  // Tiny rendered preview: one word styled with the preset's color,
  // weight, outline, and transform. Not Remotion-accurate — just
  // signals the style.
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 10px",
        background: "#0f172a",
        color: values.color,
        fontWeight: Number(values.font_weight),
        textTransform: values.text_transform as React.CSSProperties["textTransform"],
        letterSpacing: `${values.letter_spacing}px`,
        WebkitTextStroke: `${Math.max(0, Math.min(3, Number(values.outline_width) / 2))}px ${values.outline_color}`,
        borderRadius: 4,
        fontFamily: "Arial Black, Arial, sans-serif",
        fontSize: 14,
        whiteSpace: "nowrap",
      }}
    >
      Aa
    </span>
  );
}

// ─── CaptionField — one row per CaptionStyleField ────────────────────────────

function CaptionField({
  storyId,
  field,
  resolved,
  onReportState,
}: {
  storyId: string;
  field: CaptionStyleField;
  resolved: ResolvedCaptionStyle;
  onReportState: (s: AutoSaveState) => void;
}) {
  const fieldState = resolved.fields[field];
  const [value, setValue] = useState(fieldState.effective);
  const router = useRouter();
  const spec = FIELD_SPECS[field];
  const hasOverride = fieldState.source === "story";

  const save = useDebouncedSave(
    async (next: string) => {
      const r = await saveStoryCaptionStyleAction(storyId, field, next);
      if (r.ok) router.refresh();
      return r;
    },
    { debounceMs: 500 },
  );

  // Forward the save state up so the panel header can show the
  // aggregate status without each field needing its own pill.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to state, not the setter
  useEffect(() => onReportState(save.state), [save.state]);

  function update(next: string) {
    setValue(next);
    save.request(next);
  }

  function reset() {
    setValue(fieldState.inheritedFromParent);
    save.request("");
  }

  return (
    <FieldRow
      label={FIELD_LABELS[field]}
      inheritance={hasOverride ? "story" : fieldState.source}
      effective={fieldState.effective}
      canReset={hasOverride}
      onReset={reset}
    >
      <FieldControl spec={spec} value={value} onChange={update} field={field} />
    </FieldRow>
  );
}

function FieldControl({
  spec,
  value,
  onChange,
  field,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (next: string) => void;
  field: CaptionStyleField;
}) {
  if (spec.kind === "slider") {
    const numericValue = parseFloat(value);
    const safe = Number.isFinite(numericValue) ? numericValue : spec.min;
    return (
      <Slider
        value={safe}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        unit={spec.unit}
        endpoints={spec.endpoints}
        tickValue={spec.tickValue}
        onChange={(n) => onChange(String(n))}
        ariaLabel={FIELD_LABELS[field]}
      />
    );
  }
  if (spec.kind === "chip") {
    return (
      <ChipGroup
        value={value}
        options={spec.options.map((o) => ({
          id: o.id,
          label: o.label,
          preview: o.preview ? (
            <span style={o.preview.style}>{o.preview.text}</span>
          ) : undefined,
        }))}
        onChange={onChange}
        ariaLabel={FIELD_LABELS[field]}
      />
    );
  }
  if (spec.kind === "fontWeight") {
    return (
      <ChipGroup
        value={value}
        options={FONT_WEIGHT_CHIPS.map((o) => ({
          id: o.id,
          label: o.label,
          preview: o.preview ? (
            <span style={o.preview.style}>{o.preview.text}</span>
          ) : undefined,
        }))}
        onChange={onChange}
        ariaLabel={FIELD_LABELS[field]}
      />
    );
  }
  if (spec.kind === "color") {
    return (
      <ColorPicker
        value={value || "#000000"}
        onChange={onChange}
        ariaLabel={FIELD_LABELS[field]}
      />
    );
  }
  // text
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink focus:border-accent focus:outline-none"
      aria-label={FIELD_LABELS[field]}
    />
  );
}
