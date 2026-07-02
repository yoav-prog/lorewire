"use client";

// Autopilot mode picker: three explicit choices instead of a toggle,
// because "shadow" is the whole point of the trust ramp. Calls the
// dedicated action (not the generic setting save) so a deliberate mode
// change also resets the circuit breaker. Optimistic with rollback.

import { useState, useTransition } from "react";
import { setAutopilotModeAction } from "@/app/admin/scheduler-actions";
import type { AutopilotMode } from "@/lib/autopilot";

const MODES: { id: AutopilotMode; label: string; hint: string }[] = [
  {
    id: "off",
    label: "Off",
    hint: "Autopilot does nothing.",
  },
  {
    id: "shadow",
    label: "Shadow",
    hint: "Pulls and renders strong sources, but every story waits for you in the review queue. Run this for a week first.",
  },
  {
    id: "live",
    label: "Live",
    hint: "Publishes end-to-end with no click from you. A safety check screens every story; doubtful ones still wait for you.",
  },
];

export function AutopilotModeSelect({ initialMode }: { initialMode: AutopilotMode }) {
  const [mode, setMode] = useState<AutopilotMode>(initialMode);
  const [isPending, startTransition] = useTransition();

  function pick(next: AutopilotMode) {
    if (next === mode) return;
    const prev = mode;
    setMode(next);
    startTransition(async () => {
      const r = await setAutopilotModeAction(next);
      if (!r.ok) setMode(prev);
    });
  }

  const active = MODES.find((m) => m.id === mode);

  return (
    <div className={isPending ? "opacity-70" : ""}>
      <div className="inline-flex overflow-hidden rounded-lg border border-line">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => pick(m.id)}
            aria-pressed={mode === m.id}
            className={`px-4 py-1.5 text-[13px] transition-colors ${
              mode === m.id
                ? "bg-accent text-bg"
                : "bg-surface text-muted hover:text-ink"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {active && <p className="mt-1.5 text-[12px] text-muted">{active.hint}</p>}
    </div>
  );
}
