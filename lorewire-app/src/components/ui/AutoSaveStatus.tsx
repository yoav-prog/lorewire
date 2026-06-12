// Inline indicator showing the auto-save state for a panel. Replaces
// per-field "Save" buttons. The four states match the lifecycle of
// `useDebouncedSave`:
//
//   idle    — no pending change. Render nothing (or a faint "Up to date").
//   saving  — request in flight. Render "Saving…" in warn tone.
//   saved   — request just succeeded. Flash "Saved" for ~2s, then return
//             to idle. Color: ink, fades.
//   error   — request failed. Render "Save failed" in danger tone. The
//             caller's tooltip can carry the error class.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A).
//
// Pure presentational — the state machine lives in `useDebouncedSave`.

export type AutoSaveState = "idle" | "saving" | "saved" | "error";

const LABELS: Record<AutoSaveState, string> = {
  idle: "Up to date",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

const TONES: Record<AutoSaveState, string> = {
  idle: "text-muted/60",
  saving: "text-warn",
  saved: "text-ink",
  error: "text-danger",
};

export interface AutoSaveStatusProps {
  state: AutoSaveState;
  /** Title attribute for the saved/failed states. Tooltip carries the
   *  precise error class when state === "error". */
  detail?: string;
  /** When state === "idle", hide the indicator entirely. Defaults to
   *  true so panels don't show "Up to date" all the time. */
  hideIdle?: boolean;
}

export function AutoSaveStatus({
  state,
  detail,
  hideIdle = true,
}: AutoSaveStatusProps) {
  if (state === "idle" && hideIdle) return null;
  return (
    <span
      data-testid="auto-save-status"
      data-state={state}
      title={detail}
      className={`font-mono text-[10px] uppercase tracking-wider ${TONES[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}
