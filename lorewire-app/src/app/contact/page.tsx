import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "How to reach LoreWire. One email for everything: support, privacy, takedown, press, business.",
  alternates: { canonical: "/contact" },
};

const CONTACT_EMAIL = "contact@lorewire.com";

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Contact</h1>
      </header>

      <Section title="One inbox">
        <p>
          Everything reaches us at{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>
          . Whether you have a question, hit a bug, want a story removed,
          have a press request, or want to talk business — the same address
          works. We don&apos;t run a phone line.
        </p>
      </Section>

      <Section title="Reach time">
        <p>
          We read every message and aim to reply within two working days.
          Replies on weekends and holidays are slower. If you don&apos;t hear
          back inside a week, please write again — your first message may
          have been caught by a filter.
        </p>
      </Section>

      <Section title="What to include">
        <p>
          To get to an answer faster:
        </p>
        <ul className="ml-5 list-disc">
          <li>
            For a bug: the page URL, what you did, what you expected, what
            you saw, and the browser you were on.
          </li>
          <li>
            For a content takedown: the URL of the story or short, your
            relationship to the content, and the reason. See the{" "}
            <Link href="/dmca" className="text-accent underline">
              DMCA / takedown
            </Link>{" "}
            page for copyright claims.
          </li>
          <li>
            For a privacy or data request: the email address tied to your
            account, or — if anonymous — enough detail for us to identify
            the activity in question.
          </li>
          <li>
            For press: a line about what you&apos;re writing and a deadline.
          </li>
        </ul>
      </Section>

      <Section title="Postal">
        <p>
          LoreWire does not have a postal address for public correspondence.
          Email is the only channel.
        </p>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/about" className="hover:text-accent hover:underline">
          About LoreWire
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
