// Public category page. /c/Drama, /c/Entitled, etc.
//
// Phase 3 of _plans/2026-06-15-curation-system.md. Server-rendered so
// the read path is one SQL hop and the response can be statically
// revalidated. Pinned (admin-curated) stories appear first in admin
// order; the rest auto-fills from the published catalog newest-first.
//
// Unknown categories 404 — the slug must match a registered
// CATEGORY_KINDS entry exactly (case-sensitive: /c/Drama works,
// /c/drama doesn't). This keeps the public URL surface small and
// makes typos visible instead of returning an empty grid.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CATEGORY_KINDS,
  resolveCategoryPage,
  type CategoryStoryRow,
} from "@/lib/curation";

// Static-ish: rebuild every 60s so newly-published stories show up
// without a manual revalidate, but we don't re-render on every visit.
export const revalidate = 60;

export async function generateStaticParams() {
  return CATEGORY_KINDS.map((category) => ({ category }));
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!(CATEGORY_KINDS as readonly string[]).includes(category)) {
    notFound();
  }
  const rows = await resolveCategoryPage(category);

  return (
    <main className="min-h-screen bg-bg pb-20 text-ink">
      <header className="border-b border-line px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-[1280px]">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            ← Home
          </Link>
          <h1 className="mt-3 font-display text-[28px] font-extrabold tracking-tightest sm:text-[36px]">
            {category}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            {rows.length.toLocaleString()} story{rows.length === 1 ? "" : "ies"}
          </p>
        </div>
      </header>

      <section className="mx-auto max-w-[1280px] px-4 py-8 sm:px-8">
        {rows.length === 0 ? (
          <p className="text-center font-mono text-[12px] text-muted">
            Nothing published in this category yet.
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {rows.map((r) => (
              <li key={r.id}>
                <CategoryPoster row={r} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function CategoryPoster({ row }: { row: CategoryStoryRow }) {
  return (
    <Link
      href={`/v/${row.id}`}
      className="group block overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-accent"
    >
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-bg">
        {row.hero_image ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={row.hero_image}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 bg-surface2" />
        )}
        {row.pinned && (
          <span
            title="Pinned by editorial"
            className="absolute right-2 top-2 rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-accent"
          >
            pinned
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="line-clamp-2 font-display text-[13px] font-bold uppercase tracking-tight text-ink">
          {row.title ?? row.id}
        </h3>
        {row.summary && (
          <p className="mt-1 line-clamp-2 font-mono text-[10px] text-muted">
            {row.summary}
          </p>
        )}
      </div>
    </Link>
  );
}
