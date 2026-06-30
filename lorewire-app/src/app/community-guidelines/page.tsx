import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Community Guidelines",
  description:
    "What LoreWire will and won't publish, and what we expect from readers in the comments and polls.",
  alternates: { canonical: "/community-guidelines" },
};

const EFFECTIVE_DATE = "2026-06-30";
const CONTACT_EMAIL = "contact@lorewire.com";

export default function CommunityGuidelinesPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Community Guidelines</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="What this is for">
        <p>
          LoreWire publishes short stories, polls, and short videos. The
          stories come from real situations posted online, rewritten and
          illustrated by us. This page lists what we publish, what we
          won&apos;t, and what we expect from readers in the comments and
          polls.
        </p>
      </Section>

      <Section title="What we publish">
        <ul className="ml-5 list-disc">
          <li>
            Everyday-life conflicts, awkward moments, dating and roommate
            stories, family and workplace situations.
          </li>
          <li>
            Stories with a clear question we can put to a vote.
          </li>
          <li>
            Stories where identifying details have been removed or changed
            so the people involved cannot be picked out.
          </li>
        </ul>
      </Section>

      <Section title="What we will not publish">
        <ul className="ml-5 list-disc">
          <li>
            Content that targets a real, named private individual, or
            content that would let a reader pick that person out.
          </li>
          <li>
            Hate speech, slurs, or content that incites violence against a
            person or group based on race, religion, sex, gender,
            orientation, disability, or nationality.
          </li>
          <li>
            Sexual content involving minors, in any form. Sexual content in
            general is out of scope for LoreWire.
          </li>
          <li>
            Graphic gore, content glorifying self-harm or suicide, or
            content promoting eating disorders.
          </li>
          <li>
            Doxxing, threats, or the encouragement of harassment toward any
            person.
          </li>
          <li>
            Content that breaks the platform rules where we publish
            (YouTube Community Guidelines, Meta Community Standards, TikTok
            Community Guidelines). If it would get the post removed on the
            destination platform, we won&apos;t publish it on LoreWire
            either.
          </li>
        </ul>
      </Section>

      <Section title="AI-generated content">
        <p>
          Narration, illustrations, and captions are produced with AI
          assistance. We do not use AI to fabricate quotes or claims that
          are presented as factual reporting. We do not generate
          photorealistic images of real, named people. We do not generate
          political deepfakes.
        </p>
      </Section>

      <Section title="In the polls and comments">
        <ul className="ml-5 list-disc">
          <li>
            Disagree with the story or with other readers freely. Attack the
            argument, not the person.
          </li>
          <li>
            No personal attacks, slurs, or threats against other readers.
          </li>
          <li>
            No spam, no link-bait to external sites, no off-topic posts.
          </li>
          <li>
            Repeat poll voting from the same browser is blocked
            automatically. Trying to bypass the limit (multiple devices,
            scripts) is a reason to be barred from voting.
          </li>
        </ul>
      </Section>

      <Section title="How we enforce">
        <p>
          We review content before it&apos;s published, so most of the rules
          above are about the editorial line. For reader-side content
          (comments, poll behavior) we use automatic checks plus human
          review of flagged items. Removals come with a brief reason where
          we can give one. Repeated breaches end with the account barred
          from posting or voting.
        </p>
      </Section>

      <Section title="Flagging something">
        <p>
          If you see a story or a comment that breaks these guidelines,
          email{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>{" "}
          with the URL and a one-line reason. For copyright-specific
          claims, use the{" "}
          <Link href="/dmca" className="text-accent underline">
            DMCA / takedown
          </Link>{" "}
          page so we can process it correctly.
        </p>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
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
