"use client";

// Per-platform publish on/off. Unlike the generic SettingToggle this calls
// setPlatformSchedulerEnabledAction, which also switches off the platform's
// legacy render-time auto_publish so the two can't both fire and double-post.
// Optimistic: the switch flips immediately and rolls back if the action fails.

import { useState, useTransition } from "react";
import { setPlatformSchedulerEnabledAction } from "@/app/admin/scheduler-actions";
import type { PublishPlatform } from "@/lib/publish-scheduler";

export function PlatformEnableToggle({
  platform,
  label,
  initialOn,
}: {
  platform: PublishPlatform;
  label: string;
  initialOn: boolean;
}) {
  const [on, setOn] = useState(initialOn);
  const [isPending, startTransition] = useTransition();

  function flip(next: boolean) {
    setOn(next);
    startTransition(async () => {
      const r = await setPlatformSchedulerEnabledAction(platform, next);
      if (!r.ok) setOn(!next);
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
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
    </button>
  );
}
