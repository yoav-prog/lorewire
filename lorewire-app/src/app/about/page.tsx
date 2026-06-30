import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About LoreWire",
  description:
    "What LoreWire is, why it exists, and how it is made.",
  alternates: { canonical: "/about" },
};

const CONTACT_EMAIL = "contact@lorewire.com";

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">About LoreWire</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          True internet stories, hand-drawn.
        </p>
      </header>

      <Section title="What it is">
        <p>
          LoreWire is a publishing site for short illustrated stories
          inspired by the strange, funny, and uncomfortable situations
          people post about online. Every story is paired with a yes/no
          poll so the audience can weigh in — was that fair, was that
          right, would you have done the same?
        </p>
      </Section>

      <Section title="Why it exists">
        <p>
          Most of these stories live as walls of text inside niche
          subreddits, where the people who would enjoy them most never
          see them. LoreWire pulls the good ones out, rewrites them so a
          stranger can follow them in under a minute, illustrates them so
          they look like a story instead of a forum post, and gives them
          a place where the question they raise can be answered by more
          than one community.
        </p>
      </Section>

      <Section title="How it is made">
        <p>
          Stories are sourced from public posts, rewritten, narrated, and
          illustrated. LoreWire uses a mix of human editing and AI
          assistance — the AI helps with first drafts of narration,
          illustration, and captions; a human reviews everything before
          it ships. Identifying details are removed or changed. We do
          not publish content that names a specific real person without
          a clear public-figure context.
        </p>
        <p className="mt-3">
          See{" "}
          <Link
            href="/community-guidelines"
            className="text-accent underline"
          >
            Community Guidelines
          </Link>{" "}
          for what we will and won&apos;t publish.
        </p>
      </Section>

      <Section title="Who runs it">
        <p>
          LoreWire is an independent project. There is no investor, no
          parent company, no advertising partner. The site is built and
          run by a small team focused on the product.
        </p>
      </Section>

      <Section title="How to reach us">
        <p>
          One inbox for everything:{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>
          . More detail on the{" "}
          <Link href="/contact" className="text-accent underline">
            Contact
          </Link>{" "}
          page.
        </p>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/faq" className="hover:text-accent hover:underline">
          FAQ
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
