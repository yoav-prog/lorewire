// Article editor page. Server component that loads the article (notFound on
// miss), then renders the client-side Tiptap editor in the middle column with
// a server-rendered sidebar of status + meta + danger-zone actions. Status
// changes and deletes are their own tiny forms posting to actions — the main
// editor form posts title + subtitle + summary + Tiptap JSON document.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import { getArticle } from "@/lib/repo";
import type { ArticleType } from "@/lib/repo";
import {
  setArticleStatusAction,
  deleteArticleAction,
} from "@/app/admin/actions";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
  articleDirection,
} from "@/lib/articles";
import { parseArticlePayload } from "@/lib/article-payload";
import { statusClass } from "@/app/admin/ui";
import { ArticleEditor } from "./ArticleEditor";
import { ArticlePayloadSidebar } from "./ArticlePayloadSidebar";

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export default async function EditArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
    payload?: string;
  }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { saved, error, payload: payloadSaved } = await searchParams;
  const article = await getArticle(id);
  if (!article) notFound();

  // Parse the type-specific payload once; if the row's type is missing or
  // unknown we skip the sidebar entirely rather than render a broken form.
  const articleType = (article.type ?? null) as ArticleType | null;
  const parsedPayload =
    articleType && ["news", "feature", "listicle", "review"].includes(articleType)
      ? parseArticlePayload(articleType, article.payload)
      : null;

  // Status transitions exposed in the sidebar. Order is the workflow direction:
  // forward toward published, with archive as the exit. "draft" is always the
  // current state for a fresh article; clicking "Mark draft" lets a published
  // piece be pulled back for edits.
  const statusButtons: { status: string; label: string }[] = [
    { status: "draft", label: "Mark draft" },
    { status: "review", label: "Send to review" },
    { status: "published", label: "Publish" },
    { status: "archived", label: "Archive" },
  ];

  const dir = articleDirection(article.language);
  const lang = (article.language ?? "en") as keyof typeof ARTICLE_LANGUAGE_LABELS;
  const type = (article.type ?? "feature") as keyof typeof ARTICLE_TYPE_LABELS;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/articles"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Articles
        </Link>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {ARTICLE_TYPE_LABELS[type] ?? type}
            {" · "}
            {ARTICLE_LANGUAGE_LABELS[lang] ?? lang}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
              article.status,
            )}`}
          >
            {article.status ?? "draft"}
          </span>
        </div>
      </div>

      {saved === "1" && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Saved.
        </p>
      )}
      {payloadSaved === "saved" && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Details saved.
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-cat-entitled/40 bg-cat-entitled/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-entitled">
          {(() => {
            // Friendly rewrite for the publish-blocked case so the writer
            // immediately sees what's wrong; everything else slugifies.
            const m = error.match(/^alt-missing-(\d+)$/);
            if (m) {
              const n = Number(m[1]);
              return `Cannot publish — ${n} image${n === 1 ? "" : "s"} need alt text.`;
            }
            return error.replace(/-/g, " ");
          })()}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <ArticleEditor
          id={article.id}
          title={article.title ?? ""}
          subtitle={article.subtitle ?? ""}
          summary={article.summary ?? ""}
          heroImage={article.hero_image ?? ""}
          document={article.document ?? ""}
          direction={dir}
        />

        <aside className="space-y-4">
          {parsedPayload && (
            <ArticlePayloadSidebar
              articleId={article.id}
              direction={dir}
              {...parsedPayload}
            />
          )}
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Status</div>
            <div className="flex flex-wrap gap-2">
              {statusButtons.map((b) => (
                <form key={b.status} action={setArticleStatusAction}>
                  <input type="hidden" name="id" value={article.id} />
                  <input type="hidden" name="status" value={b.status} />
                  <button className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                    {b.label}
                  </button>
                </form>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4 font-mono text-[11px] text-muted">
            <div className={LABEL}>Meta</div>
            <p>id: {article.id}</p>
            <p>slug: {article.slug ?? "—"}</p>
            <p>direction: {dir}</p>
            {article.created_at && <p>created: {article.created_at.slice(0, 16)}</p>}
            {article.updated_at && <p>updated: {article.updated_at.slice(0, 16)}</p>}
            {article.published_at && (
              <p>published: {article.published_at.slice(0, 16)}</p>
            )}
          </div>

          {article.status === "archived" && (
            <div className="rounded-xl border border-cat-entitled/40 bg-surface p-4">
              <div className={LABEL}>Danger zone</div>
              <p className="mb-2 text-[12px] text-muted">
                This article is archived. Hard delete is permanent — the row and
                its revisions are removed.
              </p>
              <form action={deleteArticleAction}>
                <input type="hidden" name="id" value={article.id} />
                <button className="w-full rounded-md border border-cat-entitled/40 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-cat-entitled transition-colors hover:bg-cat-entitled/15">
                  Delete permanently
                </button>
              </form>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
