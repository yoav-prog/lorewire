// Public reader chrome. Lightweight on purpose: the editorial layer wants
// to be read, not interacted with, so we keep the header thin and let the
// article body dominate. Reader pages inherit the root layout (fonts +
// service-worker hook) and slot through this layout for the masthead +
// footer + max-width container.

import Link from "next/link";

export default function ArticlesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line bg-bg/85 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[920px] items-center justify-between gap-4">
          <Link href="/" className="font-display text-[18px] font-extrabold tracking-tightest">
            LORE<span className="text-accent">WIRE</span>
          </Link>
          <nav className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-wider text-muted">
            <Link href="/articles" className="hover:text-ink">
              Articles
            </Link>
            <Link
              href="/articles?language=he"
              className="hover:text-ink"
              hrefLang="he"
            >
              עברית
            </Link>
            <Link
              href="/articles?language=en"
              className="hover:text-ink"
              hrefLang="en"
            >
              English
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[920px] px-5 py-8">{children}</main>
      <footer className="border-t border-line px-5 py-6 text-center font-mono text-[11px] uppercase tracking-wider text-muted">
        © LoreWire
      </footer>
    </div>
  );
}
