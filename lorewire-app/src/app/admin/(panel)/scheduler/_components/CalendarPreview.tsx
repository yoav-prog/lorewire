// Read-only next-7-days preview, one row per enabled platform. Real
// queued posts render solid; projected open slots render dashed, so a
// glance separates "will happen" from "could happen". Server component:
// everything is computed in publish-scheduler.ts and passed down.

import type { PlatformCalendar } from "@/lib/publish-scheduler";

const WEEKDAY_LABELS: Record<string, string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

export function CalendarPreview({
  calendars,
  platformLabels,
}: {
  calendars: PlatformCalendar[];
  platformLabels: Record<string, string>;
}) {
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
                      <div
                        key={e.scheduledForIso}
                        className="rounded border border-dashed border-line px-1 py-0.5 text-center font-mono text-[10px] tabular-nums text-muted/70"
                      >
                        {e.timeLocal}
                      </div>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-muted">
        Solid entries are queued posts. Dashed times are open slots the
        scheduler can still fill.
      </p>
    </div>
  );
}
