import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import { listStoriesSlim } from "@/lib/repo";
import { statusClass, STATUSES } from "@/app/admin/ui";

// Soft cap on the table; over this and we render a hint instead of trying to
// paint thousands of rows in one server pass. Pagination is a follow-up.
const LIST_LIMIT = 200;

export default async function StoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireCapability("content.manage");
  const { status } = await searchParams;
  const stories = await listStoriesSlim({ status, limit: LIST_LIMIT });

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
      <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
        Stories
      </h1>

      <div className="flex flex-wrap gap-2">
        {chip("/admin/stories", "All", !status)}
        {STATUSES.map((s) =>
          chip(`/admin/stories?status=${s}`, s, status === s),
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        {stories.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            Nothing here{status ? ` with status "${status}"` : ""}.
          </p>
        ) : (
          stories.map((s) => (
            <Link
              key={s.id}
              href={`/admin/stories/${s.id}`}
              className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
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
          ))
        )}
      </div>

      {stories.length >= LIST_LIMIT && (
        <p className="font-mono text-[11px] text-muted">
          Showing the {LIST_LIMIT} most recently updated. Filter by status to
          narrow the list.
        </p>
      )}
    </div>
  );
}
