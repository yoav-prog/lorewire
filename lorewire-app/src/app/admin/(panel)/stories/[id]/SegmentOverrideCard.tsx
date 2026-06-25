// Intro/outro segment override picker. The dropdown lets the admin pin
// a specific segment for THIS story, skip the segment entirely, or
// inherit the per-aspect global active. The select's current value
// reflects the resolution chain the renderer will walk so the UI shows
// exactly what the next render will splice.
//
// Extracted from page.tsx in cut 6 so the per-tab rail dispatcher can
// import it without pulling the whole page module.

import { setStoryOverrideAction } from "@/app/admin/actions";
import type { SegmentKind, SegmentRow } from "@/lib/repo";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export function SegmentOverrideCard({
  kind,
  label,
  rows,
  storyId,
  pinnedId,
  skip,
  globalActiveId,
}: {
  kind: SegmentKind;
  label: string;
  rows: SegmentRow[];
  storyId: string;
  pinnedId: string | null;
  skip: boolean;
  globalActiveId: string | null;
}) {
  const enabledRows = rows.filter((r) => r.enabled !== 0);
  // A skip flag wins over a pinned id, and a pinned id wins over the
  // global active — same precedence the renderer walks.
  const currentValue = skip ? "skip" : pinnedId || "inherit";
  const globalRow = rows.find((r) => r.id === globalActiveId);
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={LABEL}>{label}</div>
      <form action={setStoryOverrideAction} className="space-y-2">
        <input type="hidden" name="story_id" value={storyId} />
        <input type="hidden" name="kind" value={kind} />
        <select
          name="pick"
          defaultValue={currentValue}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        >
          <option value="inherit">
            Use global active
            {globalRow
              ? ` (${globalRow.label ?? globalRow.id.slice(0, 8)})`
              : " (none set)"}
          </option>
          <option value="skip">Skip — no {kind} for this story</option>
          {enabledRows.length > 0 && (
            <optgroup label="Pin a specific one">
              {enabledRows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? r.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button className="w-full rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save {label.toLowerCase()} choice
        </button>
      </form>
    </div>
  );
}
