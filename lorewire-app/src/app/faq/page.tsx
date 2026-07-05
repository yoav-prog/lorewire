import type { Metadata } from "next";
import Link from "next/link";

import { FAQ_ITEMS, faqJsonLdScript } from "./faq-items";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    "Quick answers to the most common questions about LoreWire — what it is, how it works, and how your data is handled.",
  alternates: { canonical: "/faq" },
};

// Both the visible sections and the FAQPage JSON-LD render from
// FAQ_ITEMS (see faq-items.ts) so the schema and the copy can never
// drift. The answer HTML is hardcoded repo content, not user input —
// dangerouslySetInnerHTML here renders our own strings.

export default function FaqPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: faqJsonLdScript(FAQ_ITEMS) }}
      />

      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Frequently Asked Questions
        </h1>
      </header>

      {FAQ_ITEMS.map((item) => (
        <section key={item.question} className="mt-6">
          <h2 className="text-lg font-semibold">{item.question}</h2>
          <div
            className="mt-2 space-y-2"
            dangerouslySetInnerHTML={{ __html: item.answerHtml }}
          />
        </section>
      ))}

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/contact" className="hover:text-accent hover:underline">
          Contact
        </Link>
      </footer>
    </main>
  );
}
