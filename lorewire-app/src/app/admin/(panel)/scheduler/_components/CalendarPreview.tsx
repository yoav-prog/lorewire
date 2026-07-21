"use client";

// Next-7-days preview, one row per enabled platform — and a scheduling
// surface: real queued posts render solid and link to their story;
// dashed open slots are buttons that open an inline picker to drop a
// story into exactly that slot. All data is computed server-side in
// publish-scheduler.ts and passed down; this component only adds the
// interaction.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { schedulerScheduleAtAction } from "@/app/admin/scheduler-actions";
import type { CalendarEntry, PlatformCalendar } from "@/lib/publish-scheduler";
import { StoryCombobox, type StoryOption } from "./StoryCombobox";

const WEEKDAY_LABELS: Record<string, string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

interface PickedSlot {
  platform: string;
  /** "YYYY-MM-DDTHH:MM" wall clock in the platform's timezone. */
  whenLocal: string;
  label: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function CalendarPreview({
  calendars,
  platformLabels,
  stories,
}: {
  calendars: PlatformCalendar[];
  platformLabels: Record<string, string>;
  stories: StoryOption[];
}) {
  const [picked, setPicked] = useState<PickedSlot | null>(null);

  if (calendars.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-center text-[13px] text-muted">
        Enable a platform above to see its week here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {calendars.map((cal) => (
        <div
          key={cal.platform}
          className="rounded-xl border border-line bg-surface p-4"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[14px] font-semibold text-ink">
              {platformLabels[cal.platform] ?? cal.platform}
            </div>
            <div className="font-mono text-[11px] text-muted">{cal.timezone}</div>
          </div>
          <div className="mt-3 grid grid-cols-7 gap-1.5">
            {cal.days.map((day) => (
              <div
                key={`${day.year}-${day.month}-${day.day}`}
                className={`min-h-[72px] rounded-lg border p-1.5 ${
                  day.isToday
                    ? "border-accent/60 bg-accent/5"
                    : "border-line bg-surface2/40"
                }`}
              >
                <div className="mb-1 text-center font-mono text-[10px] uppercase tracking-wider text-muted">
                  {WEEKDAY_LABELS[day.weekday]} {day.day}
                </div>
                <div className="space-y-1">
                  {day.entries.length === 0 && (
                    <div className="text-center text-[10px] text-muted/60">—</div>
                  )}
                  {day.entries.map((e) =>
                    e.kind === "queued" ? (
                      <a
                        key={e.scheduledForIso}
                        href={`/admin/shorts/${e.storyId}`}
                        title={e.storyTitle ?? e.storyId}
                        className="block truncate rounded border border-line bg-surface px-1 py-0.5 text-[10px] text-ink hover:border-accent"
                      >
                        <span className="font-mono tabular-nums">{e.timeLocal}</span>{" "}
                        {e.storyTitle ?? e.storyId}
                      </a>
                    ) : (
                      <OpenSlotButton
                        key={e.scheduledForIso}
                        entry={e}
                        active={
                          picked?.platform === cal.platform &&
                          picked?.whenLocal ===
                            `${day.year}-${pad(day.month)}-${pad(day.day)}T${e.timeLocal}`
                        }
                        onPick={() =>
                          setPicked({
                            platform: cal.platform,
                            whenLocal: `${day.year}-${pad(day.month)}-${pad(day.day)}T${e.timeLocal}`,
                            label: `${WEEKDAY_LABELS[day.weekday]} ${MONTH_LABELS[day.month - 1]} ${day.day}, ${e.timeLocal}`,
                          })
                        }
                      />
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
          {picked?.platform === cal.platform && (
            <SlotScheduler
              key={picked.whenLocal}
              picked={picked}
              platformLabel={platformLabels[cal.platform] ?? cal.platform}
              stories={stories}
              onClose={() => setPicked(null)}
            />
          )}
        </div>
      ))}
      <p className="text-[11px] text-muted">
        Solid entries are queued posts. Dashed times are open slots — click
        one to schedule a story into it.
      </p>
    </div>
  );
}

function OpenSlotButton({
  entry,
  active,
  onPick,
}: {
  entry: CalendarEntry;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title="Schedule a story into this slot"
      className={`block w-full rounded border border-dashed px-1 py-0.5 text-center font-mono text-[10px] tabular-nums transition-colors ${
        active
          ? "border-accent text-accent"
          : "border-line text-muted/70 hover:border-accent hover:text-accent"
      }`}
    >
      {entry.timeLocal}
    </button>
  );
}

// The inline picker under the platform's grid: pick a story, confirm,
// done. The slot's platform and time are fixed — that is the point.
function SlotScheduler({
  picked,
  platformLabel,
  stories,
  onClose,
}: {
  picked: PickedSlot;
  platformLabel: string;
  stories: StoryOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [story, setStory] = useState<StoryOption | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function schedule() {
    if (!story) {
      setNote("Pick a story first.");
      return;
    }
    startTransition(async () => {
      const r = await schedulerScheduleAtAction({
        storyId: story.id,
        platforms: [picked.platform],
        whenLocal: picked.whenLocal,
      });
      const result = r.results?.[0];
      if (!r.ok || !result) {
        setNote(r.error ?? "could not schedule");
        return;
      }
      if (result.status === "duplicate") {
        setNote("This story is already queued for this platform.");
        return;
      }
      if (result.status === "in_past") {
        setNote("That slot just passed — pick a later one.");
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <span className="text-[12px] text-ink">
        {platformLabel} · {picked.label}:
      </span>
      <StoryCombobox stories={stories} value={story} onChange={setStory} />
      <button
        type="button"
        onClick={schedule}
        disabled={isPending}
        className="rounded-lg border border-accent px-3 py-1.5 text-[13px] text-accent transition-colors hover:bg-accent hover:text-bg disabled:opacity-50"
      >
        {isPending ? "Scheduling…" : "Schedule here"}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted hover:text-ink"
      >
        Cancel
      </button>
      {note && <p className="w-full text-[12px] text-accent">{note}</p>}
    </div>
  );
}
