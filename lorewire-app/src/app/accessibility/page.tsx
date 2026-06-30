import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Accessibility",
  description:
    "How LoreWire approaches accessibility, what works today, and how to report a problem.",
  alternates: { canonical: "/accessibility" },
};

const EFFECTIVE_DATE = "2026-06-30";
const CONTACT_EMAIL = "contact@lorewire.com";

export default function AccessibilityPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Accessibility</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="Our aim">
        <p>
          LoreWire aims to meet the Web Content Accessibility Guidelines
          (WCAG) 2.1 at level AA. The site is built keyboard-first, with
          semantic HTML, meaningful contrast, scalable type, and clear
          focus styles, so screen readers and keyboard users can read,
          vote, and play videos without a mouse.
        </p>
      </Section>

      <Section title="What works today">
        <ul className="ml-5 list-disc">
          <li>
            Every page renders without JavaScript for reading. The poll
            and video controls require JavaScript, but the underlying
            article and the story can be read without it.
          </li>
          <li>
            Color contrast meets WCAG AA in both light and dark themes.
          </li>
          <li>
            Interactive controls (story cards, poll buttons, navigation)
            have visible focus rings and ARIA labels where the visible
            label is iconographic.
          </li>
          <li>
            Videos support captions on the source platforms (YouTube,
            Instagram, TikTok) where they are published; the in-site
            video player respects the system reduced-motion preference.
          </li>
          <li>
            The site supports the OS-level light, dark, and high-contrast
            preferences, and remembers your manual choice.
          </li>
        </ul>
      </Section>

      <Section title="Known limitations">
        <ul className="ml-5 list-disc">
          <li>
            Some illustrated story panels do not yet carry text
            descriptions. We are adding alt text retroactively to the
            backlog. The narration audio and the story text together
            already cover the substance of every illustration.
          </li>
          <li>
            A small number of admin and editor screens are designed for
            mouse interaction and are not yet fully keyboard-navigable.
            They are not public reader surfaces.
          </li>
        </ul>
      </Section>

      <Section title="Standards we measure against">
        <p>
          Our internal target is WCAG 2.1 AA. We do not currently claim
          formal conformance with any national standard (Section 508,
          EN 301 549, IS 5568). When we ship country-specific compliance,
          we&apos;ll update this page.
        </p>
      </Section>

      <Section title="Report a problem">
        <p>
          If something is hard to use with assistive technology, please
          email{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>
          . Include the page URL, the device and screen reader you were
          using, and what didn&apos;t work. We treat accessibility reports
          as priority bugs.
        </p>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/contact" className="hover:text-accent hover:underline">
          Contact
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
