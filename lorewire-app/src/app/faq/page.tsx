import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    "Quick answers to the most common questions about LoreWire — what it is, how it works, and how your data is handled.",
  alternates: { canonical: "/faq" },
};

const CONTACT_EMAIL = "contact@lorewire.com";

export default function FaqPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
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

      <Section title="What is LoreWire?">
        <p>
          LoreWire is a publishing tool for short illustrated stories and the
          poll debates around them. Stories are written, narrated, and rendered
          inside LoreWire and published on the site and on connected social
          accounts.
        </p>
      </Section>

      <Section title="Is LoreWire free?">
        <p>
          Reading LoreWire is free. There are no ads on the site and no
          paywall. We may introduce paid creator features later, but everything
          on the public reader side stays free.
        </p>
      </Section>

      <Section title="Do I need an account to read?">
        <p>
          No. You can read every story, watch every short, and vote in every
          poll without signing in. Saving stories and remembering your
          reading position works on your device without an account too.
          Signing in is only required if you want your library to follow you
          across devices.
        </p>
      </Section>

      <Section title="Are the stories real?">
        <p>
          The stories are inspired by real situations posted on public
          internet forums. They are rewritten, narrated, and illustrated
          before publishing. Identifying details are changed. Treat them as
          stories, not as journalism.
        </p>
      </Section>

      <Section title="Who writes them?">
        <p>
          LoreWire uses a mix of human editing and AI generation for
          narration, illustration, and captions. Every published piece is
          reviewed before it goes out. See our{" "}
          <Link
            href="/community-guidelines"
            className="text-accent underline"
          >
            Community Guidelines
          </Link>{" "}
          for what we allow and what we won&apos;t publish.
        </p>
      </Section>

      <Section title="How do polls work?">
        <p>
          Each story comes with a yes/no question. You can vote without an
          account; the site uses a small cookie to remember that this browser
          has voted, so it won&apos;t count you twice. Your individual vote
          is not shown to other readers — only the running totals are.
        </p>
      </Section>

      <Section title="Why do I see a cookie banner?">
        <p>
          To ask your permission before we save your activity on this device.
          If you accept, we remember your saved stories, your reading
          position, and we load analytics so we can see how the site is being
          used. If you reject, none of that runs and we clear anything we had
          saved on this device. You can change your mind anytime from the
          &quot;Manage cookies&quot; link in the footer.
        </p>
        <p className="mt-3">
          See the{" "}
          <Link href="/cookie-policy" className="text-accent underline">
            Cookie Policy
          </Link>{" "}
          for the full list.
        </p>
      </Section>

      <Section title="How do I delete my data?">
        <p>
          Signed-in users can delete their account from the account page;
          everything tied to it is removed. Anonymous users can press Reject
          on the cookie banner to clear local data on this device. Full
          details are in the{" "}
          <Link
            href="/privacy#data-deletion"
            className="text-accent underline"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section title="Is LoreWire accessible?">
        <p>
          We aim for WCAG 2.1 AA. See our{" "}
          <Link href="/accessibility" className="text-accent underline">
            Accessibility statement
          </Link>{" "}
          for the current state and how to report a problem.
        </p>
      </Section>

      <Section title="I have a question that isn't here.">
        <p>
          Email{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>{" "}
          or use the{" "}
          <Link href="/contact" className="text-accent underline">
            Contact
          </Link>{" "}
          page.
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
