"use client";

// Render-scheduler auto-publish switch. Calls the dedicated action (not the
// generic setting save) so re-enabling after a breaker trip also clears the
// trip banner + failure counter, exactly like AutopilotModeSelect resets the
// autopilot breaker. Optimistic with rollback.

import { useState, useTransition } from "react";
import { setRenderAutoPublishEnabledAction } from "@/app/admin/scheduler-actions";

export function RenderAutoPublishToggle({ initialOn }: { initialOn: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [isPending, startTransition] = useTransition();

  function flip(next: boolean) {
    if (next === on) return;
    const prev = on;
    setOn(next);
    startTransition(async () => {
      const r = await setRenderAutoPublishEnabledAction(next);
      if (!r.ok) setOn(prev);
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={isPending}
      onClick={() => flip(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        on ? "border-accent bg-accent" : "border-line bg-surface2"
      } ${isPending ? "opacity-50" : ""}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-bg transition-transform ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
      <span className="sr-only">
        {on ? "On" : "Off"} render-scheduler auto-publish
      </span>
    </button>
  );
}
