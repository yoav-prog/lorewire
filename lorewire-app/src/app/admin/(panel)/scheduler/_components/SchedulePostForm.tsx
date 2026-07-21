"use client";

// Queue a story to an exact date/time on one or more platforms. The
// story is picked with a type-ahead search, platforms are multi-select
// chips, and the time is entered as each platform's own wall clock —
// the timezone(s) are shown next to the picker so there is no guessing.
// Every platform reports its own outcome inline.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { schedulerScheduleAtAction } from "@/app/admin/scheduler-actions";
import { StoryCombobox, type StoryOption } from "./StoryCombobox";

export interface SchedulePlatformOption {
  id: string;
  label: string;
  timezone: string;
}

export function SchedulePostForm({
  stories,
  platforms,
}: {
  stories: StoryOption[];
  platforms: SchedulePlatformOption[];
}) {
  const router = useRouter();
  const [story, setStory] = useState<StoryOption | null>(null);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(platforms[0] ? [platforms[0].id] : []),
  );
  const [whenLocal, setWhenLocal] = useState("");
  const [notes, setNotes] = useState<{ tone: "ok" | "warn" | "error"; text: string }[]>([]);
  const [isPending, startTransition] = useTransition();

  const timezones = [
    ...new Set(
      platforms.filter((p) => selected.has(p.id)).map((p) => p.timezone),
    ),
  ];
  const tzLabel =
    timezones.length === 1
      ? timezones[0]
      : timezones.length > 1
        ? "each platform's own timezone"
        : "";

  function togglePlatform(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function submit() {
    if (!story || selected.size === 0 || !whenLocal) {
      setNotes([
        { tone: "error", text: "Pick a story, at least one platform, and a time." },
      ]);
      return;
    }
    startTransition(async () => {
      const r = await schedulerScheduleAtAction({
        storyId: story.id,
        platforms: [...selected],
        whenLocal,
      });
      if (!r.ok || !r.results) {
        setNotes([{ tone: "error", text: r.error ?? "could not schedule" }]);
        return;
      }
      const label = (id: string) =>
        platforms.find((p) => p.id === id)?.label ?? id;
      setNotes(
        r.results.map((res) => {
          if (res.status === "scheduled") {
            return res.capExceeded
              ? {
                  tone: "warn" as const,
                  text: `${label(res.platform)}: queued — heads up, that day is already at its daily cap.`,
                }
              : { tone: "ok" as const, text: `${label(res.platform)}: queued.` };
          }
          if (res.status === "duplicate") {
            return {
              tone: "warn" as const,
              text: `${label(res.platform)}: already queued for this story.`,
            };
          }
          return {
            tone: "error" as const,
            text: `${label(res.platform)}: that time is in the past.`,
          };
        }),
      );
      if (r.results.some((res) => res.status === "scheduled")) {
        setWhenLocal("");
        router.refresh();
      }
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
        <StoryCombobox stories={stories} value={story} onChange={setStory} />
        <span className="flex flex-wrap gap-1.5">
          {platforms.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => togglePlatform(p.id)}
              aria-pressed={selected.has(p.id)}
              className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                selected.has(p.id)
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
        </span>
        <input
          type="datetime-local"
          value={whenLocal}
          onChange={(e) => setWhenLocal(e.target.value)}
          className="rounded-lg border border-line bg-bg px-3 py-1.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
        />
        {tzLabel && <span className="text-[11px] text-muted">{tzLabel}</span>}
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isPending ? "Scheduling…" : "Schedule"}
        </button>
      </div>
      {notes.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {notes.map((n, i) => (
            <p
              key={i}
              className={`text-[12px] ${n.tone === "ok" ? "text-muted" : "text-accent"}`}
            >
              {n.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
