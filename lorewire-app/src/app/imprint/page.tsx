// Public Imprint (Impressum).
//
// Legally required for a German operator under Sec. 5 DDG (the
// Digitale-Dienste-Gesetz, which replaced Sec. 5 TMG in 2024). It names the
// company that operates LoreWire, its registered address, management,
// commercial-register entry, and VAT ID, so a visitor can identify and reach
// the responsible legal entity. The company details are those of the operator
// Traffic.Club IT GmbH and must match the controller named in /privacy and
// the operator named in /terms; if the operating entity changes, update all
// three together.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Imprint",
  description:
    "Legal information about the company that operates LoreWire, provided under Sec. 5 DDG.",
  alternates: { canonical: "/imprint" },
};

export default function ImprintPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Imprint</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Information pursuant to § 5 DDG (formerly § 5 TMG)
        </p>
      </header>

      <Section title="Operator">
        <p>LoreWire is operated by:</p>
        <address className="mt-2 not-italic">
          Traffic.Club IT GmbH
          <br />
          Kaiserstraße 170-174
          <br />
          66386 St. Ingbert
          <br />
          Germany
        </address>
      </Section>

      <Section title="Contact">
        <p>
          eMail:{" "}
          <a
            href="mailto:office@fireball.com"
            className="text-accent underline"
          >
            office@fireball.com
          </a>
        </p>
      </Section>

      <Section title="Represented by">
        <p>Gaëlle Lallement, Rolf Rosskopf</p>
      </Section>

      <Section title="Commercial Register">
        <p>
          Registered at the Amtsgericht Saarbrücken under HRB 19295.
        </p>
      </Section>

      <Section title="VAT identification number">
        <p>
          VAT ID pursuant to § 27a of the German VAT Act (UStG): DE266854381
        </p>
      </Section>

      <footer className="mt-10 flex gap-4 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/privacy" className="hover:text-accent hover:underline">
          Privacy Policy
        </Link>
        <Link href="/terms" className="hover:text-accent hover:underline">
          Terms of Service
        </Link>
      </footer>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}
