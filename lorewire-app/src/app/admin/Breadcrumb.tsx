import Link from "next/link";

// Back-trail breadcrumb for admin inner pages. The trail does NOT include the
// current page — the page's own h1 fills that slot. Convention today: editor
// pages get a single-entry trail back to the Inbox; multi-level pages can
// pass a longer trail and the chevron separators chain through.

export type Crumb = {
  href: string;
  label: string;
};

export default function Breadcrumb({ trail }: { trail: Crumb[] }) {
  if (trail.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-3">
      <ol className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-muted">
        <li aria-hidden="true" className="text-muted">
          &larr;
        </li>
        {trail.map((c, i) => (
          <li key={c.href} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden="true" className="text-muted/60">
                /
              </span>
            )}
            <Link href={c.href} className="transition-colors hover:text-ink">
              {c.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
