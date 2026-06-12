"use client";

// "Save current as preset" modal for the Caption Style panel.
// Phase B of the admin UI overhaul. Single-input flow:
//
//   1. User types a name (max 60 chars, no control chars).
//   2. Submits.
//   3. Action is awaited inside the modal so the user sees the error
//      inline if the server rejects (e.g. name-too-long).
//   4. On success, the parent panel closes the modal and refreshes.

import { useState, useTransition } from "react";
import type { SaveUserCaptionPresetResult } from "@/app/admin/actions";

const MAX_NAME_LEN = 60;

export function SavePresetModal({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  /** Returns the action result so the modal can show server errors
   *  inline. The parent owns "close on success" behavior. */
  onSave: (name: string) => Promise<SaveUserCaptionPresetResult>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name can't be empty.");
      return;
    }
    if (trimmed.length > MAX_NAME_LEN) {
      setError(`Name is too long (max ${MAX_NAME_LEN} chars).`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await onSave(trimmed);
      if (!r.ok) setError(explainError(r.error));
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-preset-title"
      data-testid="save-preset-modal"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(15, 23, 42, 0.6)",
        padding: 24,
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-bg p-5 shadow-2xl">
        <h2
          id="save-preset-title"
          className="font-mono text-[11px] uppercase tracking-wider text-muted"
        >
          Save current style as preset
        </h2>
        <p className="mt-2 text-[12px] text-muted">
          Saves the current effective style (whatever the live preview is
          showing) as a named preset you can apply to other videos.
        </p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_NAME_LEN + 10}
          placeholder="e.g. Sunday spec, brand v2"
          className="mt-3 w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <p className="mt-1 font-mono text-[10px] text-muted">
          {name.length}/{MAX_NAME_LEN}
        </p>
        {error && <p className="mt-2 text-[11px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save preset"}
          </button>
        </div>
      </div>
    </div>
  );
}

function explainError(code: string | undefined): string {
  switch (code) {
    case "name-empty":
      return "Name can't be empty.";
    case "name-too-long":
      return `Name is too long (max ${MAX_NAME_LEN} chars).`;
    case "name-control-chars":
      return "Name has illegal characters.";
    default:
      if (code?.startsWith("unknown-field:")) {
        return "Internal: an unknown field tried to land in the preset.";
      }
      return code ?? "Save failed.";
  }
}
