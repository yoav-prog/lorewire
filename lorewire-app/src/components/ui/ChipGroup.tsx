"use client";

// Visual selectable chip group for enumerated fields. Each chip shows
// a custom preview (a sample word at the given weight, a 4-word
// karaoke demo, a tiny animation, an icon) plus a short label.
// Selected chip gets the accent-orange border + raised background.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A). The big
// upgrade over a dropdown: the user picks by what the value LOOKS
// like, not by reading "karaoke" and hoping.
//
// Accessibility: outer wrapper is role="radiogroup"; each chip is a
// button with `aria-checked`. Arrow keys move focus between chips
// (handled by the browser tab order — no custom keyboard logic
// needed for v1).

import type { ReactNode } from "react";

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** Custom JSX rendered above the label inside the chip. Could be a
   *  word styled with the value, an animation, an icon — whatever
   *  visualises what this option DOES. */
  preview?: ReactNode;
  /** Extra title text for the chip's tooltip. */
  hint?: string;
}

export interface ChipGroupProps<T extends string> {
  value: T;
  options: ChipOption<T>[];
  onChange: (next: T) => void;
  label?: string;
  /** Forces the chips to wrap to multiple rows on narrow screens.
   *  Default true. */
  wrap?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
}

export function ChipGroup<T extends string>({
  value,
  options,
  onChange,
  label,
  wrap = true,
  ariaLabel,
  disabled = false,
}: ChipGroupProps<T>) {
  return (
    <div data-testid="chip-group">
      {label && (
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </p>
      )}
      <div
        role="radiogroup"
        aria-label={ariaLabel ?? label}
        className={`flex gap-2 ${wrap ? "flex-wrap" : "overflow-x-auto"}`}
      >
        {options.map((opt) => {
          const isSelected = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              title={opt.hint}
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              data-chip-id={opt.id}
              className={`flex shrink-0 flex-col items-center gap-1 rounded-lg border px-3 py-2 transition-colors disabled:opacity-50 ${
                isSelected
                  ? "border-accent bg-accent/15 text-ink"
                  : "border-line bg-bg text-muted hover:border-ink hover:text-ink"
              }`}
            >
              {opt.preview && (
                <span
                  className="flex h-8 min-w-[2rem] items-center justify-center"
                  aria-hidden
                >
                  {opt.preview}
                </span>
              )}
              <span className="font-mono text-[10px] uppercase tracking-wider">
                {opt.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
