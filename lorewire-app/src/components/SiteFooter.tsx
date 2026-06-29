import Link from "next/link";

// Global site footer: the wordmark, tagline, and the legal links. Mounted at
// the bottom of the desktop shell (under every view) and at the end of the
// mobile Home feed. Styling mirrors the shell chrome already in use — the
// LOREWIRE wordmark, a mono-cap tagline in muted ink, and mono-cap links that
// warm to the accent on hover, same treatment as the top nav. flex-wrap keeps
// it intact from the narrow phone shell up to the 1600px desktop max width, and
// the tagline drops on the smallest screens so the links never get crowded.
export default function SiteFooter() {
  return (
    <footer className="border-t border-line mt-10">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-8 lg:px-10 lg:py-9">
        {/* 2026-06-26 slice H follow-up: footer LORE WIRE wordmark
            locked to Archivo (brand identity stays fixed regardless
            of the --font-display Fraunces swap). */}
        <span className="font-black text-[20px] tracking-tightest text-ink" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>
          LORE<span className="text-accent">WIRE</span>
        </span>
        <span className="hidden font-mono text-[11px] uppercase tracking-[.2em] text-muted sm:inline">
          True internet stories, hand-drawn.
        </span>
        <nav className="ml-auto flex items-center gap-6">
          <FooterLink href="/privacy">Privacy</FooterLink>
          <FooterLink href="/terms">Terms</FooterLink>
        </nav>
      </div>
    </footer>
  );
}

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-mono text-[11px] uppercase tracking-[.2em] text-muted transition-colors hover:text-accent"
    >
      {children}
    </Link>
  );
}
