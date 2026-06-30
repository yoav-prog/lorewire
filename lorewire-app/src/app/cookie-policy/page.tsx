import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description:
    "Every cookie LoreWire sets, what it does, and how to control it.",
  alternates: { canonical: "/cookie-policy" },
};

const EFFECTIVE_DATE = "2026-06-30";
const CONTACT_EMAIL = "contact@lorewire.com";

export default function CookiePolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Cookie Policy</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="What this is">
        <p>
          This page lists every cookie LoreWire sets, every third party that
          may set a cookie via LoreWire, what each cookie does, and how to
          turn it off. The relevant data flows are in the{" "}
          <Link href="/privacy" className="text-accent underline">
            Privacy Policy
          </Link>
          ; this page is the cookie-level detail.
        </p>
      </Section>

      <Section title="The cookie banner">
        <p>
          On your first visit, LoreWire shows a banner with two equal
          buttons: Accept and Reject. Until you choose, no analytics cookies
          load. Functional cookies (signing in, remembering you have voted)
          still set when you do the action that triggers them.
        </p>
        <p className="mt-3">
          You can change your mind any time. The footer has a &quot;Manage
          cookies&quot; link that re-opens the banner.
        </p>
      </Section>

      <Section title="Cookies LoreWire sets directly">
        <Table>
          <Row
            name="lw_consent"
            purpose="Remembers your Accept / Reject choice on the cookie banner. Required for the banner to know it has already asked you."
            lifetime="1 year"
            httpOnly={false}
          />
          <Row
            name="lw_anon"
            purpose="Ties this device's saved stories, likes, and reading position together before you sign in. Cleared on Reject."
            lifetime="1 year"
            httpOnly
          />
          <Row
            name="lw_vote"
            purpose="Stops this browser from voting twice on the same poll."
            lifetime="1 year"
            httpOnly
          />
          <Row
            name="Sign-in session cookies"
            purpose="Keep you signed in. One cookie for reader accounts, a separate one for staff accounts. Opaque session identifiers; no personal data inside."
            lifetime="Session, refreshed on activity"
            httpOnly
          />
          <Row
            name="Sign-in flow cookies"
            purpose="Protect the OAuth or magic-link exchange while you sign in. Set when you start a sign-in, cleared as soon as it finishes."
            lifetime="A few minutes"
            httpOnly
          />
        </Table>
      </Section>

      <Section title="Cookies set by third parties (only after you Accept)">
        <Table>
          <Row
            name="_ga, _ga_*"
            purpose="Google Analytics 4 — count unique visitors, remember the start of a session, attribute the source of a visit. Aggregated; IP anonymization is on; no remarketing, no Google Signals."
            lifetime="Up to 2 years (Google&apos;s default; reset on each visit)"
            httpOnly={false}
          />
        </Table>
        <p className="mt-3">
          Vercel Analytics and Vercel Speed Insights use an in-page beacon,
          not a cookie. Sentry (error tracking) does not set a cookie.
          Rejecting the banner stops all of these from loading.
        </p>
      </Section>

      <Section title="Browser-side controls">
        <p>
          You can also control cookies from your browser settings — delete
          them, block them, or set the site as an exception. Doing so
          overrides whatever you chose in the LoreWire banner, but may also
          break parts of the site (you may be signed out, or your saved
          list may not stick).
        </p>
        <ul className="ml-5 list-disc">
          <li>
            Chrome:{" "}
            <a
              href="https://support.google.com/chrome/answer/95647"
              className="text-accent underline"
            >
              support.google.com/chrome/answer/95647
            </a>
          </li>
          <li>
            Firefox:{" "}
            <a
              href="https://support.mozilla.org/kb/cookies-information-websites-store-on-your-computer"
              className="text-accent underline"
            >
              support.mozilla.org/kb/cookies-information-websites-store-on-your-computer
            </a>
          </li>
          <li>
            Safari:{" "}
            <a
              href="https://support.apple.com/guide/safari/manage-cookies-sfri11471/mac"
              className="text-accent underline"
            >
              support.apple.com/guide/safari/manage-cookies-sfri11471/mac
            </a>
          </li>
        </ul>
      </Section>

      <Section title="Changes to this policy">
        <p>
          When a cookie is added or removed, this page is updated and the
          effective date at the top changes.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions:{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-accent underline"
          >
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

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-muted">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Purpose</th>
            <th className="py-2 pr-4">Lifetime</th>
            <th className="py-2">HttpOnly</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({
  name,
  purpose,
  lifetime,
  httpOnly,
}: {
  name: string;
  purpose: string;
  lifetime: string;
  httpOnly: boolean;
}) {
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-2 pr-4 font-mono text-[12px]">{name}</td>
      <td className="py-2 pr-4">{purpose}</td>
      <td className="py-2 pr-4 text-muted">{lifetime}</td>
      <td className="py-2 text-muted">{httpOnly ? "Yes" : "No"}</td>
    </tr>
  );
}
