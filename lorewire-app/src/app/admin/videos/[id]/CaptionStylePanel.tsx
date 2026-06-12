"use client";

// Per-story caption style editor. Mounted inside /admin/videos/[id] as the
// "Caption style" tab. Edits write to the per-story scope of the existing
// caption template chain (lib/caption-style.ts), so every field cleanly
// inherits from category → global → defaults until the admin sets an
// explicit per-story override. Clearing the input clears the override and
// the field falls back to the inherited value.
//
// Optimistic UI: each field writes via useTransition so the page stays
// interactive; we don't auto-save on every keystroke — the user hits Save
// per field or Save all. Per-field Save keeps the rollback story simple:
// one bad value doesn't poison a batch.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveStoryCaptionStyleAction,
  type SaveStoryCaptionStyleResult,
} from "@/app/admin/actions";
import type {
  CaptionStyleField,
  ResolvedCaptionStyle,
} from "@/lib/caption-style";

interface FieldGroup {
  title: string;
  description: string;
  fields: CaptionStyleField[];
}

const GROUPS: FieldGroup[] = [
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

const LABELS: Record<CaptionStyleField, string> = {
  position_y: "Position Y (0 = top, 1 = bottom)",
  size_scale: "Size scale",
  padding_x: "Side padding (px)",
  text_transform: "Text transform",
  font_weight: "Font weight",
  letter_spacing: "Letter spacing (px)",
  line_height: "Line height",
  color: "Word color (default)",
  active_word_color: "Active word color",
  spoken_word_color: "Spoken word color (supports rgba)",
  outline_color: "Outline color",
  outline_width: "Outline width (px)",
  entry_effect: "Entry effect",
  word_highlight: "Word highlight style",
};

type FieldKind = "number" | "color" | "select" | "text";

interface FieldDef {
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

const FIELDS: Record<CaptionStyleField, FieldDef> = {
  position_y: { kind: "number", min: 0, max: 1, step: 0.01 },
  size_scale: { kind: "number", min: 0.5, max: 2, step: 0.05 },
  padding_x: { kind: "number", min: 0, max: 200, step: 4 },
  text_transform: {
    kind: "select",
    options: ["uppercase", "none", "lowercase"],
  },
  font_weight: { kind: "number", min: 100, max: 900, step: 100 },
  letter_spacing: { kind: "number", min: -5, max: 5, step: 0.1 },
  line_height: { kind: "number", min: 0.8, max: 2, step: 0.05 },
  color: { kind: "color" },
  active_word_color: { kind: "color" },
  spoken_word_color: { kind: "text" },
  outline_color: { kind: "color" },
  outline_width: { kind: "number", min: 0, max: 12, step: 1 },
  entry_effect: {
    kind: "select",
    options: ["none", "fade", "pop", "slide-up"],
  },
  word_highlight: {
    kind: "select",
    options: ["none", "karaoke", "color", "scale", "background"],
  },
};

export default function CaptionStylePanel({
  storyId,
  resolved,
}: {
  storyId: string;
  resolved: ResolvedCaptionStyle;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Caption style · per video
        </p>
        <p className="text-[12px] leading-relaxed text-muted">
          Overrides for this video only. Leave a field empty to inherit from
          category → global → defaults. The live preview reflects each save.
        </p>
      </div>

      {GROUPS.map((g) => (
        <FieldGroupView
          key={g.title}
          storyId={storyId}
          group={g}
          resolved={resolved}
        />
      ))}
    </div>
  );
}

function FieldGroupView({
  storyId,
  group,
  resolved,
}: {
  storyId: string;
  group: FieldGroup;
  resolved: ResolvedCaptionStyle;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-semibold text-ink">
        {group.title}
      </legend>
      <p className="-mt-1 text-[11px] text-muted">{group.description}</p>
      <div className="space-y-2">
        {group.fields.map((bare) => (
          <FieldRow
            key={bare}
            storyId={storyId}
            bare={bare}
            field={FIELDS[bare]}
            label={LABELS[bare]}
            resolved={resolved}
          />
        ))}
      </div>
    </fieldset>
  );
}

function FieldRow({
  storyId,
  bare,
  field,
  label,
  resolved,
}: {
  storyId: string;
  bare: CaptionStyleField;
  field: FieldDef;
  label: string;
  resolved: ResolvedCaptionStyle;
}) {
  const fieldState = resolved.fields[bare];
  const initial = fieldState.storyOverride ?? "";
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const hasOverride = fieldState.source === "story";
  const dirty = value !== initial;

  function save(next: string) {
    setError(null);
    startTransition(async () => {
      const result: SaveStoryCaptionStyleResult =
        await saveStoryCaptionStyleAction(storyId, bare, next);
      if (!result.ok) {
        setError(result.error ?? "Save failed");
        return;
      }
      router.refresh();
    });
  }

  function handleClear() {
    setValue("");
    save("");
  }

  return (
    <div className="rounded-lg border border-line bg-bg p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </label>
        <SourceBadge source={fieldState.source} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Control
          bare={bare}
          field={field}
          value={value}
          onChange={setValue}
          placeholder={fieldState.inheritedFromParent}
        />
        <button
          type="button"
          onClick={() => save(value)}
          disabled={pending || !dirty}
          className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {hasOverride && (
          <button
            type="button"
            onClick={handleClear}
            disabled={pending}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-40"
          >
            Clear override
          </button>
        )}
      </div>
      {error && (
        <p className="mt-1.5 text-[11px] text-danger">{error}</p>
      )}
      <p className="mt-1.5 font-mono text-[10px] text-muted">
        Effective: <span className="text-ink">{fieldState.effective}</span>
        {fieldState.source !== "story" && (
          <>
            {" · inherits from "}
            <span className="text-ink">{fieldState.source}</span>
          </>
        )}
      </p>
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const label = source === "default" ? "default" : source;
  const cls =
    source === "story"
      ? "border-accent/40 bg-accent/15 text-accent"
      : "border-line bg-surface2 text-muted";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

function Control({
  bare,
  field,
  value,
  onChange,
  placeholder,
}: {
  bare: CaptionStyleField;
  field: FieldDef;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  const baseClass =
    "min-w-[120px] flex-1 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent placeholder:text-muted/50";

  if (field.kind === "number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        className={baseClass}
        name={`caption.${bare}`}
      />
    );
  }
  if (field.kind === "color") {
    // Color picker can't represent the "inherit" state — when the override
    // is empty we render a text input that takes a hex string. When set,
    // we show both a native picker AND a synced text input so the user
    // sees the value.
    return value ? (
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={normalizeHex(value)}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-12 rounded border border-line bg-bg p-0.5"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={baseClass}
          name={`caption.${bare}`}
        />
      </div>
    ) : (
      <input
        type="text"
        value=""
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={baseClass}
        name={`caption.${bare}`}
      />
    );
  }
  if (field.kind === "select" && field.options) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={baseClass}
        name={`caption.${bare}`}
      >
        <option value="">— inherit ({placeholder}) —</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={baseClass}
      name={`caption.${bare}`}
    />
  );
}

function normalizeHex(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return "#000000";
}
