// /admin/articles/[id]/history
//
// Revision history list. Newest-first, with named versions surfaced
// visually and a "Prune" action that drops unnamed snapshots beyond the
// retention cap. Clicking a row opens the diff view against the article's
// current state.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import { getArticle, listRevisions } from "@/lib/repo";
import { articleDirection } from "@/lib/articles";
import { pruneRevisionsAction } from "@/app/admin/actions";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pruned?: string; error?: string }>;
}) {
  await requireCapability("content.manage");
  const { id } = await params;
  const { pruned, error } = await searchParams;
  const article = await getArticle(id);
  if (!article) notFound();
  const revisions = await listRevisions(id);
  const dir = articleDirection(article.language);

  const namedCount = revisions.filter((r) => r.is_named === 1).length;
  const unnamedCount = revisions.length - namedCount;
  const overCap = Math.max(0, unnamedCount - 50);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/admin/articles/${article.id}`}
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; {article.title || "Article"}
        </Link>
      </div>

      <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
        Revision history
      </h1>

      {pruned && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Pruned {pruned} unnamed snapshot{pruned === "1" ? "" : "s"}.
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-danger">
          {error.replace(/-/g, " ")}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3 font-mono text-[11px]">
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className={LABEL}>Total</div>
          <div className="text-[18px] text-ink">{revisions.length}</div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className={LABEL}>Named</div>
          <div className="text-[18px] text-ink">{namedCount}</div>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className={LABEL}>Over retention cap</div>
          <div
            className={`text-[18px] ${overCap > 0 ? "text-cat-entitled" : "text-ink"}`}
          >
            {overCap}
          </div>
        </div>
      </div>

      {overCap > 0 && (
        <form action={pruneRevisionsAction}>
          <input type="hidden" name="article_id" value={article.id} />
          <button
            type="submit"
            className="rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-muted hover:border-accent hover:text-accent"
          >
            Prune {overCap} oldest unnamed
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-line">
        {revisions.length === 0 ? (
          <p className="bg-surface p-6 text-center text-[14px] text-muted">
            No revisions yet. Save the article to start the trail.
          </p>
        ) : (
          revisions.map((r) => (
            <Link
              key={r.id}
              href={`/admin/articles/${article.id}/history/${r.id}`}
              className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 last:border-0 hover:bg-surface2"
            >
              <span className="min-w-0">
                <span dir={dir} className="block truncate text-[14px] text-ink">
                  {r.title || article.title || r.id.slice(0, 8)}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {fmtClock(r.created_at)}
                  {r.status ? ` · ${r.status}` : ""}
                </span>
              </span>
              <span className="shrink-0">
                {r.is_named === 1 ? (
                  <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
                    {r.name || "Named"}
                  </span>
                ) : (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    autosave
                  </span>
                )}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
