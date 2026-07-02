"use client";

// Queue a specific story to a specific date/time on one platform. The
// time is entered in the platform's own timezone (shown next to the
// picker so there is no guessing). Success and every failure mode report
// inline.

import { useState, useTransition } from "react";
import { schedulerScheduleAtAction } from "@/app/admin/scheduler-actions";

export interface SchedulePlatformOption {
  id: string;
  label: string;
  timezone: string;
}

export function SchedulePostForm({
  stories,
  platforms,
}: {
  stories: { id: string; title: string }[];
  platforms: SchedulePlatformOption[];
}) {
  const [storyId, setStoryId] = useState(stories[0]?.id ?? "");
  const [platform, setPlatform] = useState(platforms[0]?.id ?? "");
  const [whenLocal, setWhenLocal] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const timezone =
    platforms.find((p) => p.id === platform)?.timezone ?? "";

  function submit() {
    if (!storyId || !platform || !whenLocal) {
      setNote({ tone: "error", text: "Pick a story, a platform, and a time." });
      return;
    }
    startTransition(async () => {
      const r = await schedulerScheduleAtAction({ storyId, platform, whenLocal });
      if (!r.ok) {
        setNote({ tone: "error", text: r.error ?? "could not schedule" });
        return;
      }
      setNote(
        r.capExceeded
          ? {
              tone: "warn",
              text: "Queued — heads up, that day is already at this platform's daily cap.",
            }
          : { tone: "ok", text: "Queued. It will show in the list above." },
      );
      setWhenLocal("");
    });
  }

  if (stories.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        No schedulable stories yet — a story needs a finished short before it
        can be queued by hand.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-[13px] font-semibold text-ink">
        Schedule a specific story
      </div>
      <p className="mt-0.5 text-[12px] text-muted">
        Skips the regular slots and posts exactly when you say.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={storyId}
          onChange={(e) => setStoryId(e.target.value)}
          className="max-w-[260px] rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          {stories.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        >
          {platforms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={whenLocal}
          onChange={(e) => setWhenLocal(e.target.value)}
          className="rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
        />
        <span className="text-[11px] text-muted">{timezone}</span>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isPending ? "Scheduling…" : "Schedule"}
        </button>
      </div>
      {note && (
        <p
          className={`mt-2 text-[12px] ${
            note.tone === "error" || note.tone === "warn"
              ? "text-accent"
              : "text-muted"
          }`}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
