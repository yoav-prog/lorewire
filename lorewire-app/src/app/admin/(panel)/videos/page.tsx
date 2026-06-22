// Videos list. In LoreWire every story is a video — this page lists them
// with status filter chips identical in shape to the Stories page. Each row
// click goes to the full-bleed visual editor at /admin/videos/[id]; a small
// secondary "Edit metadata" affordance points at /admin/stories/[id] for the
// title/category/status form. Both URLs were already alive — this page just
// gives the user a clear destination from the sidebar.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import { listStoriesSlim } from "@/lib/repo";
import { statusClass, STATUSES } from "@/app/admin/ui";

const LIST_LIMIT = 200;

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireCapability("content.manage");
  const { status } = await searchParams;
  const rows = await listStoriesSlim({ status, limit: LIST_LIMIT });

  console.info("[admin videos list] render", {
    status_filter: status ?? null,
    row_count: rows.length,
  });

  const chip = (href: string, label: string, active: boolean) => (
    <Link
      key={label}
      href={href}
      className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
        active
          ? "border-ink/30 bg-surface2 text-ink"
          : "border-line text-muted hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Videos
        </h1>
      </div>

      <p className="text-[14px] text-muted">
        Video stories arrive from the Reddit pipeline. Click a row to open the
        visual editor; use the Metadata button to change title, category, or
        status.
      </p>

      <div className="flex flex-wrap gap-2">
        {chip("/admin/videos", "All", !status)}
        {STATUSES.map((s) =>
          chip(`/admin/videos?status=${s}`, s, status === s),
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {rows.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            Nothing here{status ? ` with status "${status}"` : ""}.
          </p>
        ) : (
          rows.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
            >
              <Link
                href={`/admin/videos/${s.id}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] text-ink">
                    {s.title || s.id}
                  </span>
                  <span className="font-mono text-[11px] text-muted">
                    {s.category || "uncategorized"}
                    {s.updated_at ? ` · ${s.updated_at.slice(0, 10)}` : ""}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
                    s.status,
                  )}`}
                >
                  {s.status ?? "draft"}
                </span>
              </Link>
              <Link
                href={`/admin/stories/${s.id}`}
                className="shrink-0 rounded-md border border-line px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
                title="Edit metadata (title, category, status)"
              >
                Metadata
              </Link>
            </div>
          ))
        )}
      </div>

      {rows.length >= LIST_LIMIT && (
        <p className="font-mono text-[11px] text-muted">
          Showing the {LIST_LIMIT} most recently updated. Filter by status to
          narrow the list.
        </p>
      )}
    </div>
  );
}
