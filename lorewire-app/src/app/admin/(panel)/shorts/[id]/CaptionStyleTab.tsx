"use client";

// Caption style tab. Mirrors a slim slice of the long-form video editor's
// caption style surface — preset chip row + the 6 controls most users
// touch (text + active-word + outline color, word highlight mode,
// entry animation, vertical position). Patches into
// short_config.caption_style.<field>; values are strings (matches the
// caption-style resolver chain). Live preview reflects edits via the
// ShortPreviewPlayer's captionStyle prop derivation.
//
// 14 fields exist in the renderer's CaptionStyleProps schema; the tab
// covers the ones the editor's research showed admins reach for most.
// The other 8 fields (size_scale, padding_x, text_transform,
// font_weight, letter_spacing, line_height, spoken_word_color,
// outline_width) remain accessible by directly patching the column
// for power users; a follow-up can surface them when there's demand.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (caption styles
// slice).

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  BUILT_IN_CAPTION_PRESETS,
  type CaptionStyleValues,
} from "@/lib/caption-presets";
import type { ShortConfig } from "@/lib/short-config";
import { saveShortConfigPatch } from "./actions";

const WORD_HIGHLIGHT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "none", label: "None" },
  { id: "karaoke", label: "Karaoke" },
  { id: "color", label: "Color" },
  { id: "scale", label: "Scale" },
  { id: "background", label: "Background" },
];

const ENTRY_EFFECT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "pop", label: "Pop" },
  { id: "slide-up", label: "Slide up" },
];

// Resolver-chain defaults so the tab can show what the renderer is
// CURRENTLY using even when the field has no override. Mirrors
// CAPTION_DEFAULTS in lib/caption-style.ts (which is server-only so we
// can't import it directly).
const DEFAULTS = {
  color: "#facc15",
  active_word_color: "#ffffff",
  outline_color: "#0f172a",
  word_highlight: "karaoke",
  entry_effect: "fade",
  position_y: "0.68",
} as const;

function effective(
  config: ShortConfig,
  field: keyof typeof DEFAULTS,
): string {
  return config.caption_style?.[field] ?? DEFAULTS[field];
}

export function CaptionStyleTab({
  storyId,
  config,
  onConfigChange,
}: {
  storyId: string;
  config: ShortConfig;
  onConfigChange: (next: ShortConfig) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function patch(fields: Record<string, string | null>) {
    const built: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fields)) {
      built[`caption_style.${field}`] = value;
    }
    startTransition(async () => {
      const result = await saveShortConfigPatch(storyId, built);
      if (result.ok && result.config) {
        onConfigChange(result.config);
      }
      router.refresh();
    });
  }

  function applyPreset(values: CaptionStyleValues) {
    const built: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
      built[`caption_style.${field}`] = value;
    }
    startTransition(async () => {
      const result = await saveShortConfigPatch(storyId, built);
      if (result.ok && result.config) {
        onConfigChange(result.config);
      }
      router.refresh();
    });
  }

  function clearAll() {
    const built: Record<string, unknown> = {};
    for (const field of [
      "color",
      "active_word_color",
      "spoken_word_color",
      "outline_color",
      "outline_width",
      "size_scale",
      "padding_x",
      "text_transform",
      "font_weight",
      "letter_spacing",
      "line_height",
      "word_highlight",
      "entry_effect",
      "position_y",
    ]) {
      built[`caption_style.${field}`] = null;
    }
    startTransition(async () => {
      const result = await saveShortConfigPatch(storyId, built);
      if (result.ok && result.config) {
        onConfigChange(result.config);
      }
      router.refresh();
    });
  }

  const positionPct = Math.round(Number(effective(config, "position_y")) * 100);

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Caption style
        </h2>
        <button
          type="button"
          onClick={clearAll}
          disabled={pending}
          className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-40"
        >
          Reset to defaults
        </button>
      </div>

      {/* ── Preset chips ──────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Preset
        </span>
        <div className="flex flex-wrap gap-2">
          {BUILT_IN_CAPTION_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.values)}
              disabled={pending}
              title={p.tagline}
              className="rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-40"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* ── Colors ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ColorField
          label="Text color"
          value={effective(config, "color")}
          onChange={(v) => patch({ color: v })}
          disabled={pending}
        />
        <ColorField
          label="Active word"
          value={effective(config, "active_word_color")}
          onChange={(v) => patch({ active_word_color: v })}
          disabled={pending}
        />
        <ColorField
          label="Outline"
          value={effective(config, "outline_color")}
          onChange={(v) => patch({ outline_color: v })}
          disabled={pending}
        />
      </div>

      {/* ── Highlight mode ──────────────────────────────────────── */}
      <div className="space-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Word highlight
        </span>
        <div className="flex flex-wrap gap-1.5">
          {WORD_HIGHLIGHT_OPTIONS.map((opt) => {
            const active = effective(config, "word_highlight") === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => patch({ word_highlight: opt.id })}
                disabled={pending}
                className={
                  active
                    ? "rounded-md border border-accent bg-accent/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-accent"
                    : "rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-40"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Entry effect ────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Entry animation
        </span>
        <div className="flex flex-wrap gap-1.5">
          {ENTRY_EFFECT_OPTIONS.map((opt) => {
            const active = effective(config, "entry_effect") === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => patch({ entry_effect: opt.id })}
                disabled={pending}
                className={
                  active
                    ? "rounded-md border border-accent bg-accent/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-accent"
                    : "rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-40"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Position Y ──────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Vertical position
          </span>
          <span className="font-mono text-[10px] text-muted">
            {positionPct}% from top
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={positionPct}
          onChange={(e) =>
            patch({ position_y: (Number(e.target.value) / 100).toFixed(2) })
          }
          disabled={pending}
          className="w-full accent-accent"
        />
      </div>

      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
        Edits show live in the preview and roll into the next render.
      </p>
    </section>
  );
}

function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-2 py-1">
        <input
          type="color"
          value={normalizeHex(value)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-6 w-8 cursor-pointer border-0 bg-transparent p-0 disabled:cursor-wait"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 bg-transparent font-mono text-[11px] text-ink outline-none disabled:cursor-wait"
        />
      </div>
    </label>
  );
}

// <input type=color> demands exactly #rrggbb. The presets include rgba()
// (for transparency) — that's valid in the text input but not in the
// color picker, so normalize for the picker swatch and let the text
// field carry the canonical value.
function normalizeHex(v: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const [, r, g, b] = /^#(.)(.)(.)$/.exec(v) ?? [];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#000000";
}
