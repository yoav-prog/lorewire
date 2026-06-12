// Layout primitive for one editable field in the admin UI. Combines:
//   - the uppercase mono label
//   - an optional inheritance badge ("default" / "global" / etc.) and
//     hint line ("Effective: 0.55 · inherits from default")
//   - the control itself (slider, color picker, chip group, ...)
//   - an optional inline Reset link that appears only when the value
//     differs from the inherited default
//
// Used by every Phase B–E surface so the editor's per-field chrome is
// visually identical across panels, settings, and templates. Pure
// presentational — no save logic here, the caller owns that.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A).

import type { ReactNode } from "react";

export interface FieldRowProps {
  label: string;
  /** Short description rendered above the control. Optional. */
  hint?: string;
  /** Where the effective value came from. "default" / "global" /
   *  "category" / "story" / null for "this field is custom and isn't
   *  inheriting from anywhere". */
  inheritance?: string | null;
  /** The current effective value, rendered as text in the "Effective:"
   *  hint line below the control. */
  effective?: string;
  /** When true (i.e. effective !== inherited), the Reset link appears.
   *  Caller wires onReset to clear the override. */
  canReset?: boolean;
  onReset?: () => void;
  children: ReactNode;
}

export function FieldRow({
  label,
  hint,
  inheritance,
  effective,
  canReset,
  onReset,
  children,
}: FieldRowProps) {
  return (
    <div
      className="rounded-lg border border-line bg-surface p-3"
      data-testid="field-row"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {label}
        </span>
        <div className="flex items-center gap-2">
          {inheritance && (
            <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted">
              {inheritance}
            </span>
          )}
          {canReset && onReset && (
            <button
              type="button"
              onClick={onReset}
              className="font-mono text-[10px] uppercase tracking-wider text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Reset
            </button>
          )}
        </div>
      </div>
      {hint && (
        <p className="mb-2 text-[11px] leading-snug text-muted">{hint}</p>
      )}
      {children}
      {effective !== undefined && (
        <p className="mt-2 font-mono text-[10px] text-muted">
          Effective: <span className="text-ink">{effective}</span>
          {inheritance && (
            <>
              {" · "}inherits from <span className="text-ink">{inheritance}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
