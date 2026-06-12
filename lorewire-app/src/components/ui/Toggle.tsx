"use client";

// Toggle switch — a labeled on/off control with the standard
// sliding-circle visual. Replaces `<input type="checkbox">` for
// boolean fields where the tactile feedback of a switch reads
// better.
//
// Phase C of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md). Reusable beyond the
// editor; the Settings page has a server-action-bound SettingToggle
// that we keep for its specific use case, but this one is for any
// client-state boolean.
//
// Pure presentational: caller owns the boolean state. Accessibility:
// role=switch with aria-checked, keyboard activatable (Space/Enter).

import type { ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Mono uppercase label rendered to the left of the switch. */
  label?: string;
  /** Optional helper text under the label. */
  hint?: ReactNode;
  /** Custom text rendered on the right side ("on" / "off" by default). */
  rightLabel?: ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  rightLabel,
  disabled = false,
  ariaLabel,
}: ToggleProps) {
  const display = rightLabel ?? (checked ? "on" : "off");
  return (
    <div
      data-testid="toggle"
      data-checked={checked ? "true" : "false"}
      className={`flex items-start justify-between gap-3 rounded-md border border-line bg-surface px-3 py-2 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <div className="min-w-0">
        {label && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {label}
          </p>
        )}
        {hint && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-ink">
          {display}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={ariaLabel ?? label}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          data-testid="toggle-switch"
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed ${
            checked
              ? "border-accent bg-accent"
              : "border-line bg-surface2"
          }`}
        >
          <span
            aria-hidden
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg shadow-md transition-transform ${
              checked ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
