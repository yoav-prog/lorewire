// Reddit candidate CSV upload page.
//
// One server action, one file input, one "Dry-run preview" checkbox. The
// result panel below shows the diff: new / updated / unchanged / errors,
// plus the first 10 brand-new reddit_ids and any parse warnings.
//
// The page is intentionally minimal: this is a writer-tool surface used a
// few times per week, not a marketing page. Per CLAUDE.md rule 10 (build
// for a lazy user) the bar is "drop the CSV, see what changed, move on."

import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import RedditSourceImportForm from "./RedditSourceImportForm";
import { countRedditSources } from "@/lib/reddit-source";

export const dynamic = "force-dynamic";

export default async function RedditSourceImportPage() {
  await requireAdmin();
  const totalRows = await countRedditSources();

  return (
    <div className="mx-auto max-w-[860px] space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/reddit-sources"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Reddit Sources
        </Link>
      </div>

      <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
        Import RedditDB CSV
      </h1>
      <p className="font-mono text-[11px] text-muted">
        Upload the exported RedditDB sheet as CSV. Rows are upserted by
        Reddit&nbsp;ID — re-uploading the same file is a safe no-op, and
        rows you&apos;ve already marked queued / used / skipped stay in
        their state. Currently in DB: <strong>{totalRows.toLocaleString()}</strong>{" "}
        candidate rows.
      </p>

      <RedditSourceImportForm />

      <details className="rounded-xl border border-line bg-surface p-4">
        <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-wider text-muted">
          Expected CSV shape
        </summary>
        <div className="mt-3 space-y-2 text-[12px] text-ink">
          <p>The header row must contain these 9 columns (any order):</p>
          <ul className="ml-4 list-disc font-mono text-[11px] text-muted">
            <li>Reddit ID</li>
            <li>Subreddit</li>
            <li>Date Written</li>
            <li>Title</li>
            <li>Full Text</li>
            <li>Comments</li>
            <li>URL</li>
            <li>Summary</li>
            <li>How Long it Is</li>
          </ul>
          <p className="text-muted">
            A missing column is a hard error. Empty cells are fine — the
            parser warns on blank titles, missing Reddit IDs, and unparseable
            dates, and skips just those rows.
          </p>
        </div>
      </details>
    </div>
  );
}
