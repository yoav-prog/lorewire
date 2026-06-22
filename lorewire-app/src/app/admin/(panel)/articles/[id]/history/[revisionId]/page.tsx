// /admin/articles/[id]/history/[revisionId]
//
// Side-by-side diff between the article's current state and the chosen
// revision. Built on the LCS-based block diff in src/lib/article-diff.ts
// plus the same server-side Tiptap renderer the public reader uses, so
// the diff shows blocks formatted exactly the way they appear in the
// finished article.
//
// Two writer actions on this page: name the revision (so it survives
// retention pruning) and restore the revision (writes its document onto
// the article AND appends a marker revision so the restore is itself
// undo-able).

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import { getArticle, getRevision } from "@/lib/repo";
import { renderArticleHtml } from "@/lib/article-html";
import {
  diffDocuments,
  type DiffRow,
  type TiptapBlock,
} from "@/lib/article-diff";
import { articleDirection } from "@/lib/articles";
import {
  nameRevisionAction,
  unnameRevisionAction,
  restoreRevisionAction,
} from "@/app/admin/actions";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";
const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

// Render a single block by wrapping it in a one-block doc and feeding the
// existing renderer. Slightly wasteful (one generateHTML call per cell)
// but lets the diff reuse every node spec the editor already speaks; the
// alternative is duplicating block-render logic into the diff module,
// which would drift the moment a block changes.
function renderBlock(block: TiptapBlock | null): string {
  if (!block) return "";
  return renderArticleHtml(
    JSON.stringify({ type: "doc", content: [block] }),
  );
}

function rowClass(kind: DiffRow["kind"], side: "prev" | "curr"): string {
  if (kind === "same") return "bg-surface";
  if (kind === "added" && side === "curr") {
    return "bg-cat-wholesome/10 border-l-2 border-cat-wholesome";
  }
  if (kind === "removed" && side === "prev") {
    return "bg-cat-entitled/10 border-l-2 border-cat-entitled";
  }
  // Empty cell in the column the row doesn't appear on.
  return "bg-bg";
}

export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; revisionId: string }>;
  searchParams: Promise<{
    named?: string;
    unnamed?: string;
    error?: string;
  }>;
}) {
  await requireCapability("content.manage");
  const { id, revisionId } = await params;
  const { named, unnamed, error } = await searchParams;
  const [article, revision] = await Promise.all([
    getArticle(id),
    getRevision(revisionId),
  ]);
  if (!article) notFound();
  if (!revision || revision.article_id !== id) notFound();

  const dir = articleDirection(article.language);
  const { rows, summary } = diffDocuments(revision.document, article.document);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={`/admin/articles/${article.id}/history`}
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; History
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          {revision.is_named === 1 && revision.name
            ? revision.name
            : "Snapshot"}
        </h1>
        <p className="font-mono text-[11px] text-muted">
          {fmtClock(revision.created_at)}
        </p>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
          <span className="text-cat-wholesome">+{summary.added}</span> /
          <span className="text-cat-entitled"> -{summary.removed}</span> /
          <span> {summary.unchanged} unchanged</span>
        </p>
      </header>

      {named === "1" && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Named.
        </p>
      )}
      {unnamed === "1" && (
        <p className="rounded-lg border border-line bg-surface px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted">
          Label removed.
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-danger">
          {error.replace(/-/g, " ")}
        </p>
      )}

      {/* Naming + restore actions live above the diff so they're visible
          without scrolling. Restore lands a confirm step in the writer's
          journey (the action itself appends a marker revision, which is
          its own undo path). */}
      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        {revision.is_named === 1 ? (
          <form action={unnameRevisionAction} className="flex items-end gap-2">
            <input type="hidden" name="article_id" value={article.id} />
            <input type="hidden" name="revision_id" value={revision.id} />
            <div className="flex-1">
              <span className={LABEL}>Named</span>
              <p className="text-[13px] text-ink">
                {revision.name || "Named version"}
              </p>
            </div>
            <button
              type="submit"
              className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
            >
              Remove label
            </button>
          </form>
        ) : (
          <form
            action={nameRevisionAction}
            className="flex items-end gap-2"
          >
            <input type="hidden" name="article_id" value={article.id} />
            <input type="hidden" name="revision_id" value={revision.id} />
            <label className="flex-1">
              <span className={LABEL}>Name this version</span>
              <input
                name="name"
                placeholder="e.g. Before publishing"
                className={FIELD}
                required
                maxLength={120}
              />
            </label>
            <button
              type="submit"
              className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-accent hover:text-accent"
            >
              Save name
            </button>
          </form>
        )}

        <form action={restoreRevisionAction}>
          <input type="hidden" name="article_id" value={article.id} />
          <input type="hidden" name="revision_id" value={revision.id} />
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Restore this snapshot
          </button>
        </form>
      </div>

      {/* The diff itself. Two columns; each row shows the matching block on
          one or both sides with row-class highlighting. We deliberately do
          not collapse runs of `same` rows here — the writer needs them as
          context for the changes between, and a future "compact view"
          toggle is a tiny addition if the rows ever get unwieldy. */}
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-bg p-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Snapshot
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Current
        </div>
        {rows.length === 0 ? (
          <p className="col-span-2 p-6 text-center text-muted">
            Both documents are empty.
          </p>
        ) : (
          rows.map((row, idx) => (
            <DiffRowCells key={idx} row={row} dir={dir} />
          ))
        )}
      </div>
    </div>
  );
}

function DiffRowCells({
  row,
  dir,
}: {
  row: DiffRow;
  dir: "ltr" | "rtl";
}) {
  return (
    <>
      <div
        dir={dir}
        className={`rounded-md p-2 ${rowClass(row.kind, "prev")}`}
        dangerouslySetInnerHTML={{ __html: renderBlock(row.previous) }}
      />
      <div
        dir={dir}
        className={`rounded-md p-2 ${rowClass(row.kind, "curr")}`}
        dangerouslySetInnerHTML={{ __html: renderBlock(row.current) }}
      />
    </>
  );
}
