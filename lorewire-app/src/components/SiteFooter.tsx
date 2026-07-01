"use client";

import Link from "next/link";
import { dispatchReopenBanner } from "@/lib/consent-client";

// Global site footer: the wordmark, tagline, the four trust columns, and a
// bottom row with the Manage cookies reopener and copyright. Mounted at the
// bottom of the desktop shell (under every view) and at the end of the
// mobile Home feed. Styling mirrors the shell chrome — LOREWIRE wordmark,
// mono-cap section labels in muted ink, mono-cap links that warm to the
// accent on hover.
//
// The four columns expand the previous Privacy + Terms only footer to the
// full trust surface (FAQ, Contact, Cookie Policy, Accessibility,
// Community Guidelines, About, DMCA). On phones the columns stack
// vertically; on the desktop shell up to 1600px wide they sit on a single
// row with equal weight.
//
// The Manage cookies button is a real button rather than a link so screen
// readers know it triggers an action (re-opens the consent banner) instead
// of navigating somewhere. It uses `dispatchReopenBanner()` from
// consent-client to fire the `lw:consent:reopen` custom event the
// CookieConsent component listens for.
export default function SiteFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-line mt-10">
      <div className="mx-auto max-w-[1600px] px-6 py-10 lg:px-10">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            {/* Wordmark locked to Archivo regardless of the --font-display swap. */}
            <span
              className="font-black text-[22px] tracking-tightest text-ink"
              style={{
                fontFamily: "var(--font-archivo), Arial, sans-serif",
              }}
            >
              LORE<span className="text-accent">WIRE</span>
            </span>
            <p className="mt-2 max-w-[28ch] font-mono text-[11px] uppercase tracking-[.2em] text-muted">
              True internet stories, hand-drawn.
            </p>
          </div>

          <FooterColumn title="Help">
            <FooterLink href="/faq">FAQ</FooterLink>
            <FooterLink href="/contact">Contact</FooterLink>
            <FooterLink href="/accessibility">Accessibility</FooterLink>
          </FooterColumn>

          <FooterColumn title="Legal">
            <FooterLink href="/privacy">Privacy</FooterLink>
            <FooterLink href="/terms">Terms</FooterLink>
            <FooterLink href="/cookie-policy">Cookie Policy</FooterLink>
            <FooterLink href="/dmca">DMCA</FooterLink>
            <FooterLink href="/imprint">Imprint</FooterLink>
          </FooterColumn>

          <FooterColumn title="LoreWire">
            <FooterLink href="/about">About</FooterLink>
            <FooterLink href="/community-guidelines">
              Community Guidelines
            </FooterLink>
          </FooterColumn>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line pt-6 font-mono text-[10px] uppercase tracking-[.2em] text-muted">
          <span>© {year} LoreWire</span>
          <button
            type="button"
            onClick={() => {
              console.info("[footer manage-cookies] reopen-dispatch", {
                source: "footer",
              });
              dispatchReopenBanner();
            }}
            className="cursor-pointer text-muted transition-colors hover:text-accent"
          >
            Manage cookies
          </button>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="font-mono text-[10px] uppercase tracking-[.2em] text-ink">
        {title}
      </h3>
      <ul className="mt-3 space-y-2">
        {Array.isArray(children)
          ? children.map((child, i) => <li key={i}>{child}</li>)
          : <li>{children}</li>}
      </ul>
    </div>
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
