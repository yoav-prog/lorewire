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
  setArticleNoindexAction,
  deleteArticleAction,
} from "@/app/admin/actions";
import {
  ARTICLE_TYPE_LABELS,
  ARTICLE_LANGUAGE_LABELS,
  articleDirection,
} from "@/lib/articles";
import { parseArticlePayload } from "@/lib/article-payload";
import { buildArticleJsonLd } from "@/lib/article-seo";
import { statusClass } from "@/app/admin/ui";
import Breadcrumb from "@/app/admin/Breadcrumb";
import { countArticleImages, listArticleImages } from "@/lib/tiptap-article-image";
import { countGalleryImages, listGalleryItems } from "@/lib/tiptap-gallery";
import {
  MediaRegenPanel,
  type MediaAssetSpec,
} from "@/app/admin/(panel)/_components/MediaRegenPanel";
import {
  GranularRegenGrid,
  type GranularItem,
} from "@/app/admin/(panel)/_components/GranularRegenGrid";
import { ArticleEditor } from "./ArticleEditor";
import { ArticlePayloadSidebar } from "./ArticlePayloadSidebar";
import { ArticleSeoPanel } from "./ArticleSeoPanel";
import { SeoSuggestPanel } from "./SeoSuggestPanel";

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
    seo?: string;
    restored?: string;
  }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const {
    saved,
    error,
    payload: payloadSaved,
    seo: seoSaved,
    restored,
  } = await searchParams;
  const article = await getArticle(id);
  if (!article) notFound();

  // Parse the type-specific payload once; if the row's type is missing or
  // unknown we skip the sidebar entirely rather than render a broken form.
  const articleType = (article.type ?? null) as ArticleType | null;
  const parsedPayload =
    articleType && ["news", "feature", "listicle", "review"].includes(articleType)
      ? parseArticlePayload(articleType, article.payload)
      : null;

  // JSON-LD preview for the SEO panel. We render here so the panel stays
  // client-side and lightweight — buildArticleJsonLd reads the same parsed
  // payload that drives the reader, so the preview never drifts.
  const jsonLdPreview = articleType
    ? JSON.stringify(buildArticleJsonLd({ article, siteName: "LoreWire" }), null, 2)
    : "";

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

  // Re-render asset list for this article. Hero + OG are top-level columns.
  // Body images and gallery items live in the Tiptap document — count them
  // from the doc so the cost preview reflects what's actually there. The
  // bulk slugs disappear from the panel when their count is zero so the
  // admin doesn't see a "Regenerate 0 images" button.
  let parsedDoc: unknown = null;
  try {
    parsedDoc = article.document ? JSON.parse(article.document) : null;
  } catch {
    parsedDoc = null;
  }
  const bodyImageCount = countArticleImages(parsedDoc);
  const galleryImageCount = countGalleryImages(parsedDoc);
  const articleAssets: MediaAssetSpec[] = [
    {
      asset: "hero",
      label: "Hero image",
      hint: "Main image at the top of the article and on social cards.",
    },
    {
      asset: "og",
      label: "OG image",
      hint: "Dedicated social-card image when you want something different from the hero. Falls back to the hero when blank.",
    },
  ];
  if (bodyImageCount > 0) {
    articleAssets.push({
      asset: "body_images",
      label: `All body images (${bodyImageCount})`,
      hint: "Every articleImage node in the document. Regenerated in one batch.",
      imageCountOverride: bodyImageCount,
    });
  }
  if (galleryImageCount > 0) {
    articleAssets.push({
      asset: "gallery_images",
      label: `All gallery items (${galleryImageCount})`,
      hint: "Every image across every gallery node. Regenerated in one batch.",
      imageCountOverride: galleryImageCount,
    });
  }

  // Per-image granular regen grids — one thumbnail per articleImage and
  // per gallery item. Empty when the doc has none of that kind.
  const bodyImageItems = listArticleImages(parsedDoc).map((b): GranularItem => ({
    asset: `body:${b.index}`,
    src: b.src,
    label: b.alt || `Body image ${b.index + 1}`,
    meta: b.caption || undefined,
  }));
  const galleryItemSpecs = listGalleryItems(parsedDoc).map((g): GranularItem => ({
    asset: `gallery:${g.index}`,
    src: g.src,
    label: g.alt || `Gallery ${g.index + 1}`,
    meta: g.caption || undefined,
  }));

  const dir = articleDirection(article.language);
  const lang = (article.language ?? "en") as keyof typeof ARTICLE_LANGUAGE_LABELS;
  const type = (article.type ?? "feature") as keyof typeof ARTICLE_TYPE_LABELS;

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />
      <div className="flex items-center justify-end gap-3">
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
      {seoSaved === "saved" && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          SEO saved.
        </p>
      )}
      {restored === "1" && (
        <p className="rounded-lg border border-cat-wholesome/40 bg-cat-wholesome/15 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-cat-wholesome">
          Snapshot restored. A marker version was added to history so this is undoable.
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
          <ArticleSeoPanel
            articleId={article.id}
            language={article.language ?? "en"}
            direction={dir}
            slug={article.slug ?? ""}
            metaTitle={article.meta_title ?? ""}
            metaDescription={article.meta_description ?? ""}
            ogImage={article.og_image ?? ""}
            jsonLdPreview={jsonLdPreview}
          />
          <SeoSuggestPanel articleId={article.id} />

          <MediaRegenPanel
            ownerKind="article"
            ownerId={article.id}
            assets={articleAssets}
          />

          {bodyImageItems.length > 0 && (
            <GranularRegenGrid
              ownerKind="article"
              ownerId={article.id}
              title="Body images (per-image)"
              description="Redo a single body image. Its alt and caption drive the prompt."
              items={bodyImageItems}
            />
          )}

          {galleryItemSpecs.length > 0 && (
            <GranularRegenGrid
              ownerKind="article"
              ownerId={article.id}
              title="Gallery items (per-image)"
              description="Redo a single gallery item without touching the others."
              items={galleryItemSpecs}
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

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Search visibility</div>
            <p className="mb-2 text-[12px] text-muted">
              {article.noindex
                ? "Hidden from search engines. The public page emits noindex,nofollow."
                : "Indexable. Search engines can crawl and rank this page."}
            </p>
            <form action={setArticleNoindexAction}>
              <input type="hidden" name="id" value={article.id} />
              <input
                type="hidden"
                name="noindex"
                value={article.noindex ? "0" : "1"}
              />
              <button className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                {article.noindex
                  ? "Show in search engines"
                  : "Hide from search engines"}
              </button>
            </form>
          </div>

          <Link
            href={`/admin/articles/${article.id}/history`}
            className="block rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
          >
            <div className={LABEL}>History</div>
            <p className="font-mono text-[12px] text-ink">
              Revisions, named versions, restore →
            </p>
          </Link>

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
