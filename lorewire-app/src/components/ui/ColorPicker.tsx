"use client";

// Hand-rolled color picker for the admin UI. Hex-first because every
// color in this codebase is stored as hex; the popover adds preset
// swatches (16 video-editor classics), recent-colors memory (last 8
// in localStorage, per-browser), and an optional EyeDropper API
// button so power users can pick any pixel on screen.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A). No library
// dep — matches the dark / mono / accent-orange aesthetic exactly.
//
// Closed state: a swatch button (28×28) + hex input rendered inline.
// Open state: the same swatch + a small popover below it.
//
// Pure presentational for the controlled value; popover open state is
// internal. Validation: hex pattern enforced in the input and in
// commit (Enter or blur). Invalid input is ignored.

import { useCallback, useEffect, useId, useRef, useState } from "react";

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RECENT_STORAGE_KEY = "lorewire.ui.color_picker.recents";
const MAX_RECENT = 8;

// Curated palette covering the common video-editor needs without
// looking like a kid's crayon box: a few black/white anchors, a few
// caption-yellow / orange / red shades for highlights, a few muted
// gray + slate stops, plus a couple of brand accents.
const PRESET_PALETTE = [
  "#ffffff",
  "#f8fafc",
  "#cbd5e1",
  "#94a3b8",
  "#475569",
  "#1e293b",
  "#0f172a",
  "#000000",
  "#facc15",
  "#f59e0b",
  "#ea580c",
  "#dc2626",
  "#e8462b",
  "#22c55e",
  "#0ea5e9",
  "#8b5cf6",
];

declare global {
  // EyeDropper is shipped in Chromium 95+ but isn't in the standard
  // lib.dom typings yet. Declare a minimal shape so TypeScript stops
  // complaining when we feature-detect it.
  interface Window {
    EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> };
  }
}

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => typeof v === "string" && HEX_RE.test(v),
    );
  } catch {
    return [];
  }
}

function saveRecents(list: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota or private mode — just skip */
  }
}

export interface ColorPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Optional label rendered above the swatch row. */
  label?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function ColorPicker({
  value,
  onChange,
  label,
  disabled = false,
  ariaLabel,
}: ColorPickerProps) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [recents, setRecents] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Sync the draft input to the controlled value when the caller
  // changes it externally (e.g. presets row applied). React 19 forbids
  // both setState-in-useEffect and ref reads during render, but the
  // sibling-state "adjust state during render" pattern is blessed for
  // exactly this case — comparing the cached prop to the live prop and
  // resetting derived state before commit:
  //   https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(value);
  }

  // Lazy-load recents on first open so SSR/render is deterministic.
  // Loaded synchronously in the open toggle instead of from an effect
  // (avoids the React 19 setState-in-effect lint and one render cycle).

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const commit = useCallback(
    (hex: string) => {
      if (!HEX_RE.test(hex)) return;
      onChange(hex);
      const next = [hex, ...recents.filter((c) => c !== hex)].slice(
        0,
        MAX_RECENT,
      );
      setRecents(next);
      saveRecents(next);
    },
    [onChange, recents],
  );

  const onEyedropper = async () => {
    if (typeof window === "undefined" || !window.EyeDropper) return;
    try {
      const ed = new window.EyeDropper();
      const result = await ed.open();
      commit(result.sRGBHex);
      setDraft(result.sRGBHex);
    } catch {
      /* user cancelled */
    }
  };

  const hasEyeDropper =
    typeof window !== "undefined" && Boolean(window.EyeDropper);

  return (
    <div
      ref={containerRef}
      data-testid="color-picker"
      className="relative inline-flex flex-col gap-1"
    >
      {label && (
        <label
          htmlFor={inputId}
          className="font-mono text-[10px] uppercase tracking-wider text-muted"
        >
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (disabled) return;
            setOpen((o) => {
              if (!o) setRecents(loadRecents());
              return !o;
            });
          }}
          aria-label={ariaLabel ?? "Pick color"}
          aria-expanded={open}
          disabled={disabled}
          data-testid="color-picker-swatch"
          className="h-7 w-7 shrink-0 rounded border border-line transition-colors hover:border-ink disabled:opacity-50"
          style={{ background: value }}
        />
        <input
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value.trim())}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            }
          }}
          disabled={disabled}
          spellCheck={false}
          className="w-24 rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] uppercase text-ink focus:border-accent focus:outline-none disabled:opacity-50"
          placeholder="#000000"
          aria-invalid={!HEX_RE.test(draft)}
        />
      </div>
      {open && (
        <div
          role="dialog"
          aria-label="Color picker"
          data-testid="color-picker-popover"
          className="absolute left-0 top-[calc(100%+4px)] z-30 w-56 rounded-lg border border-line bg-surface p-3 shadow-2xl"
        >
          <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted">
            Palette
          </p>
          <div className="mb-3 grid grid-cols-8 gap-1.5">
            {PRESET_PALETTE.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => {
                  commit(hex);
                  setDraft(hex);
                }}
                title={hex}
                aria-label={`Apply ${hex}`}
                className={`h-5 w-5 rounded border transition-transform hover:scale-110 ${
                  value.toLowerCase() === hex.toLowerCase()
                    ? "border-accent"
                    : "border-line"
                }`}
                style={{ background: hex }}
              />
            ))}
          </div>
          {recents.length > 0 && (
            <>
              <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted">
                Recent
              </p>
              <div className="mb-3 flex gap-1.5">
                {recents.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => {
                      commit(hex);
                      setDraft(hex);
                    }}
                    title={hex}
                    aria-label={`Apply ${hex}`}
                    className="h-5 w-5 rounded border border-line transition-transform hover:scale-110"
                    style={{ background: hex }}
                  />
                ))}
              </div>
            </>
          )}
          {hasEyeDropper && (
            <button
              type="button"
              onClick={onEyedropper}
              className="w-full rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
            >
              Pick from screen
            </button>
          )}
        </div>
      )}
    </div>
  );
}
