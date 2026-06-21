// Public Terms of Service.
//
// Required by Google OAuth verification, YouTube Data API quota expansion,
// Meta App Review, and TikTok app audit (Phase 0 of
// _plans/2026-06-16-multi-platform-shorts-publisher.md). Reviewers visit
// this URL alongside /privacy. Keep it specific to LoreWire and short
// enough for a human to read; reviewers actively look for boilerplate and
// reject it.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The rules of using LoreWire to create, render, and publish content to your connected social accounts.",
  alternates: { canonical: "/terms" },
};

const EFFECTIVE_DATE = "2026-06-16";
// TODO Yoav: confirm or replace these before filing review applications.
const LEGAL_ENTITY = "Flexelent (operator of LoreWire)";
const CONTACT_EMAIL = "info@lorewire.com";
const GOVERNING_LAW =
  "the State of Israel" /* TODO Yoav: confirm — Israel courts, or somewhere else */;

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Terms of Service</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="1. The service">
        <p>
          LoreWire is a publishing tool operated by {LEGAL_ENTITY}. It lets
          you write, render, and post videos and articles to your own
          connected social accounts. By using the service you agree to
          these terms and to the{" "}
          <Link href="/privacy" className="text-accent underline">
            Privacy Policy
          </Link>
          .
        </p>
      </Section>

      <Section title="2. Your account">
        <ul className="ml-5 list-disc">
          <li>
            You are responsible for what happens under your account.
            Pick a strong password and keep it private.
          </li>
          <li>
            You must be at least 13 years old, and the age of digital
            consent in your country if higher.
          </li>
          <li>
            One account per person. Sharing an account with another
            individual is not permitted.
          </li>
        </ul>
      </Section>

      <Section title="3. Acceptable use">
        <p>You agree not to use LoreWire to:</p>
        <ul className="ml-5 list-disc">
          <li>
            Post content that is illegal where it will be published, that
            harasses or threatens people, or that infringes someone
            else&apos;s intellectual property or privacy rights.
          </li>
          <li>
            Generate content that impersonates a real person or
            organization without consent.
          </li>
          <li>
            Bypass platform rules (YouTube Community Guidelines, Meta
            Community Standards, TikTok Community Guidelines). Anything
            that would get you banned on the destination platform is also
            banned here.
          </li>
          <li>
            Reverse-engineer the service, probe its security without
            permission, or run automated traffic that disrupts other users.
          </li>
          <li>
            Resell access to the service or its outputs as your own
            product without a separate written agreement.
          </li>
        </ul>
      </Section>

      <Section title="4. Connected social accounts">
        <p>
          When you connect a YouTube channel, a Meta-managed Facebook Page
          or Instagram Business account, or a TikTok account, you authorize
          LoreWire to publish on your behalf only when you explicitly ask
          us to (by clicking Publish or scheduling a publish). LoreWire
          never publishes on your behalf unprompted.
        </p>
        <p className="mt-3">
          The destination platforms have their own rules and may remove
          content, suspend accounts, or strike against your account. We
          surface these signals when the platforms report them, but you
          remain responsible for what is published under your account.
        </p>
      </Section>

      <Section title="5. Your content">
        <p>
          You keep ownership of the content you write, the media you
          upload, and the videos LoreWire renders from your inputs. By
          using the service you grant LoreWire a limited license to store
          and process that content so we can render it, publish it on your
          behalf when you ask, and provide the service to you.
        </p>
      </Section>

      <Section title="6. AI-generated content">
        <p>
          Some content (scripts, captions, images, voiceover) is generated
          by AI models. AI output can be wrong, biased, or infringing
          without your knowing it. You are responsible for reviewing what
          you publish. LoreWire does not warrant that AI-generated content
          is accurate, original, or fit for any purpose.
        </p>
      </Section>

      <Section title="7. Third-party services">
        <p>
          LoreWire depends on third-party services (Google&apos;s YouTube
          API, Meta&apos;s Graph API, TikTok&apos;s Content Posting API,
          AI model providers, hosting, storage). Their terms apply to
          their portions of the service. We are not responsible for
          outages or policy changes on those services, though we will work
          to keep LoreWire usable when they happen.
        </p>
      </Section>

      <Section title="8. Suspension and termination">
        <p>
          You can close your account at any time from the settings page.
          We may suspend or terminate access if you breach these terms,
          create legal risk for LoreWire or other users, or use the
          service in a way that violates the destination platforms&apos;
          rules. Where the breach is fixable we will tell you what to
          change first.
        </p>
      </Section>

      <Section title="9. Disclaimer">
        <p>
          The service is provided on an &quot;as is&quot; and &quot;as
          available&quot; basis. To the extent permitted by law, LoreWire
          disclaims warranties of merchantability, fitness for a
          particular purpose, and non-infringement.
        </p>
      </Section>

      <Section title="10. Limitation of liability">
        <p>
          To the maximum extent permitted by law, {LEGAL_ENTITY} is not
          liable for any indirect, incidental, special, or consequential
          damages, or for lost profits, lost revenue, or lost data,
          arising out of your use of the service. Our total liability for
          any claim is limited to the greater of the amount you paid us in
          the twelve months before the claim, or one hundred US dollars.
        </p>
      </Section>

      <Section title="11. Governing law">
        <p>
          These terms are governed by the laws of {GOVERNING_LAW}. Any
          dispute that cannot be resolved by good-faith discussion will be
          brought before the courts located there.
        </p>
      </Section>

      <Section title="12. Changes">
        <p>
          We may update these terms. Material changes are posted here with
          a new effective date and announced by email to existing users at
          least 30 days before they take effect.
        </p>
      </Section>

      <Section title="13. Contact">
        <p>
          Questions about these terms:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/privacy" className="hover:text-accent hover:underline">
          Privacy Policy
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
