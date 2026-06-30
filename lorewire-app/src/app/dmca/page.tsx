import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "DMCA / Takedown",
  description:
    "How to report content on LoreWire that infringes your copyright, and how counter-notices work.",
  alternates: { canonical: "/dmca" },
};

const EFFECTIVE_DATE = "2026-06-30";
const CONTACT_EMAIL = "contact@lorewire.com";

export default function DmcaPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">DMCA / Takedown</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="What this is">
        <p>
          If something on LoreWire infringes your copyright, you can ask us
          to take it down. This page tells you what to send and what
          happens next. It also explains the counter-notice process if you
          believe a takedown against your content was wrong.
        </p>
      </Section>

      <Section title="How to send a notice">
        <p>
          Email{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>{" "}
          with the subject line &quot;DMCA takedown&quot; and include all of
          the following. We can&apos;t act on an incomplete notice.
        </p>
        <ul className="ml-5 list-disc">
          <li>
            The URL on LoreWire of the content you say is infringing. One
            URL per item. If multiple items, list them all.
          </li>
          <li>
            A description of the original work you own, and how to find it
            (a URL where the original is hosted is best).
          </li>
          <li>
            A statement, in good faith, that you believe the use on
            LoreWire is not authorized by you, your agent, or the law.
          </li>
          <li>
            A statement, under penalty of perjury, that the information in
            your notice is accurate and that you are the rights holder or
            authorized to act on their behalf.
          </li>
          <li>
            Your full legal name, postal address, phone number, and email
            address.
          </li>
          <li>
            Your physical or electronic signature.
          </li>
        </ul>
      </Section>

      <Section title="What happens next">
        <ul className="ml-5 list-disc">
          <li>
            We acknowledge your notice within 2 working days.
          </li>
          <li>
            If the notice is complete and the claim is plausible on its
            face, we remove or disable access to the content while we
            review.
          </li>
          <li>
            We notify the uploader (if any) and forward your notice to
            them, minus your phone number where we can.
          </li>
          <li>
            We tell you when the action is complete.
          </li>
        </ul>
      </Section>

      <Section title="Counter-notice">
        <p>
          If you uploaded content that was removed and you believe the
          takedown was a mistake or misidentification, you can file a
          counter-notice. Email the same address with the subject line
          &quot;DMCA counter-notice&quot; and include:
        </p>
        <ul className="ml-5 list-disc">
          <li>The URL of the removed content.</li>
          <li>
            A statement, under penalty of perjury, that you have a good
            faith belief the content was removed by mistake or
            misidentification.
          </li>
          <li>
            Your consent to the jurisdiction of the relevant court for the
            place where you live (or, if outside that jurisdiction, of a
            court where LoreWire&apos;s designated agent may be found).
          </li>
          <li>
            A statement that you will accept service of process from the
            party that sent the original notice.
          </li>
          <li>
            Your full legal name, postal address, phone number, and email
            address.
          </li>
          <li>Your physical or electronic signature.</li>
        </ul>
        <p className="mt-3">
          If we receive a valid counter-notice we forward it to the party
          that sent the original takedown. If they do not file a court
          action within 10 to 14 business days, we may restore the
          content.
        </p>
      </Section>

      <Section title="Repeat infringers">
        <p>
          Accounts that receive multiple confirmed infringement notices are
          terminated.
        </p>
      </Section>

      <Section title="False notices">
        <p>
          A knowingly false DMCA notice or counter-notice can result in
          legal liability under 17 U.S.C. § 512(f). Please don&apos;t.
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
