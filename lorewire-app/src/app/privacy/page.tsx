// Public privacy policy.
//
// Required by Google OAuth verification, YouTube Data API quota expansion,
// Meta App Review, and TikTok app audit (Phase 0 of
// _plans/2026-06-16-multi-platform-shorts-publisher.md). Reviewers visit
// this URL to confirm the policy exists, matches the requested scopes, and
// names the data flows. Keep it specific to what Lorewire actually does;
// generic boilerplate fails review.
//
// The YouTube section is required verbatim-style by YouTube API Services
// Terms of Service. Do not remove the Google Privacy Policy link or the
// security-settings revocation link without re-reading the current ToS.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How LoreWire collects, uses, and protects your data, including data from connected YouTube, Meta, and TikTok accounts.",
  alternates: { canonical: "/privacy" },
};

const EFFECTIVE_DATE = "2026-06-22";
// TODO Yoav: confirm or replace these before filing review applications.
const LEGAL_ENTITY = "Flexelent (operator of LoreWire)";
const CONTACT_EMAIL = "info@lorewire.com";

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Privacy Policy</h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Effective {EFFECTIVE_DATE}
        </p>
      </header>

      <Section title="1. Who we are">
        <p>
          LoreWire is a publishing tool operated by {LEGAL_ENTITY}. The site
          is reachable at{" "}
          <a href="https://lorewire.com" className="text-accent underline">
            lorewire.com
          </a>
          . This policy explains what data the service collects, why, and
          how to control it. Questions go to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section title="2. Data we collect">
        <p>
          We collect the following categories of data, depending on how you use
          LoreWire.
        </p>
        <h3 className="mt-3 font-semibold">Account data</h3>
        <ul className="ml-5 list-disc">
          <li>
            Your email address, and a salted, hashed password if you set one.
          </li>
          <li>
            How you sign in. You can use an email and password, a one-time
            email sign-in link, or a Google, Microsoft, or Reddit account. When
            you sign in with one of those providers we store the account
            identifier they return and the email tied to it, so we recognize
            you next time. We never receive or store your password for those
            providers.
          </li>
          <li>
            A display name and profile picture, if you set one or a sign-in
            provider supplies it.
          </li>
          <li>
            A session cookie that keeps you signed in. The cookie holds only an
            opaque session identifier, not personal data.
          </li>
        </ul>
        <h3 className="mt-3 font-semibold">Reader activity</h3>
        <ul className="ml-5 list-disc">
          <li>
            Stories you save, like, or mark as favorite categories; the stories
            you have recently viewed; and how far you read or watched, so your
            list and your place are still here next time.
          </li>
          <li>
            Your answers to the optional engagement polls. A signed-in vote is
            linked to your account; an anonymous vote is linked only to a random
            cookie on your device.
          </li>
          <li>
            A random identifier stored on your device (the{" "}
            <code>lw_anon</code> cookie) that ties this device&apos;s activity
            together before you sign in. Choosing Reject in the cookie banner
            clears it.
          </li>
        </ul>
        <h3 className="mt-3 font-semibold">Content you create</h3>
        <ul className="ml-5 list-disc">
          <li>
            Stories, articles, scripts, captions, and rendered video and
            audio files you generate inside LoreWire.
          </li>
          <li>
            Settings you save (preferred voices, default privacy, hashtag
            sets, scheduling defaults).
          </li>
        </ul>
        <h3 className="mt-3 font-semibold">Connected social accounts</h3>
        <ul className="ml-5 list-disc">
          <li>
            When you connect a YouTube channel, a Meta-managed Facebook
            Page or Instagram Business account, or a TikTok account,
            LoreWire stores the OAuth access token, refresh token, and a
            display name returned by the platform.
          </li>
          <li>
            Tokens are encrypted at rest with AES-256-GCM. They never
            appear in our logs or in any response sent back to the browser.
          </li>
          <li>
            We use these tokens only to publish content you explicitly
            asked us to publish, and to read back basic post status (views,
            watch time) when you have that feature turned on.
          </li>
        </ul>
        <h3 className="mt-3 font-semibold">Technical data</h3>
        <ul className="ml-5 list-disc">
          <li>
            Application logs that record what happened during a request
            (e.g. &quot;publish to YouTube succeeded in 9.2 s&quot;). Logs
            do not contain access tokens, refresh tokens, or password
            hashes.
          </li>
          <li>
            IP address at the edge for abuse prevention. We do not retain
            it beyond standard hosting log retention windows.
          </li>
          <li>
            When you vote in a poll, a one-way hash of your IP address and
            browser user-agent, used only to rate-limit voting and stop abuse.
            It cannot be reversed back to your IP address.
          </li>
        </ul>
      </Section>

      <Section title="3. What we do not collect">
        <p>
          LoreWire does not load third-party advertising scripts, ad
          retargeting pixels, or behavioral analytics SDKs on its pages.
          There is no Facebook Pixel, no Google Analytics tracking script,
          no marketing automation tag. Every cookie LoreWire sets is
          first-party and functional, such as keeping you signed in,
          remembering your cookie choice, and stopping duplicate poll votes.
          None of them track you across other websites. The Cookies section
          below lists them.
        </p>
      </Section>

      <Section title="4. How we use your data">
        <ul className="ml-5 list-disc">
          <li>To let you sign in and use LoreWire.</li>
          <li>
            To show you stories, remember the list and reading position you
            save, and run the optional polls you choose to answer.
          </li>
          <li>
            To render and publish the content you create on the platforms
            you have connected.
          </li>
          <li>
            To show you the status of past publishes (succeeded, failed,
            pending) and metrics you opted into.
          </li>
          <li>
            To diagnose failures when something breaks. Engineers read
            logs; logs never contain credentials.
          </li>
        </ul>
      </Section>

      <Section title="5. Sharing with third parties">
        <p>
          LoreWire shares data with a small number of providers, each
          covered by their own privacy policy.
        </p>
        <ul className="ml-5 list-disc">
          <li>
            <b>YouTube (Google LLC)</b>: when you connect a channel, your
            OAuth grant authorizes LoreWire to upload videos under that
            channel. Google&apos;s privacy policy:{" "}
            <a
              href="https://policies.google.com/privacy"
              className="text-accent underline"
            >
              policies.google.com/privacy
            </a>
            .
          </li>
          <li>
            <b>Meta Platforms (Facebook, Instagram)</b>: when you connect a
            Facebook Page and a linked Instagram Business account, your
            OAuth grant authorizes LoreWire to publish Reels and posts.
            Meta&apos;s privacy policy:{" "}
            <a
              href="https://www.facebook.com/policy.php"
              className="text-accent underline"
            >
              facebook.com/policy.php
            </a>
            .
          </li>
          <li>
            <b>TikTok</b>: when you connect a TikTok account, your OAuth
            grant authorizes LoreWire to upload videos. TikTok&apos;s
            privacy policy:{" "}
            <a
              href="https://www.tiktok.com/legal/privacy-policy"
              className="text-accent underline"
            >
              tiktok.com/legal/privacy-policy
            </a>
            .
          </li>
          <li>
            <b>Vercel</b> hosts the application. Privacy policy:{" "}
            <a
              href="https://vercel.com/legal/privacy-policy"
              className="text-accent underline"
            >
              vercel.com/legal/privacy-policy
            </a>
            .
          </li>
          <li>
            <b>Google Cloud Storage</b> stores rendered media files.
            Covered by Google Cloud&apos;s privacy commitments.
          </li>
          <li>
            <b>Neon (Postgres)</b> stores account data and the encrypted
            tokens. Privacy policy:{" "}
            <a
              href="https://neon.com/privacy-policy"
              className="text-accent underline"
            >
              neon.com/privacy-policy
            </a>
            .
          </li>
          <li>
            <b>Sign-in providers (Google, Microsoft, Reddit)</b>: if you choose
            to sign in with one of these, the provider authenticates you and
            returns a basic account identifier and, where available, your
            email. Reddit does not return an email, so we generate a stable
            internal anchor instead. Privacy policies:{" "}
            <a
              href="https://policies.google.com/privacy"
              className="text-accent underline"
            >
              Google
            </a>
            ,{" "}
            <a
              href="https://www.microsoft.com/en-us/privacy/privacystatement"
              className="text-accent underline"
            >
              Microsoft
            </a>
            ,{" "}
            <a
              href="https://www.reddit.com/policies/privacy-policy"
              className="text-accent underline"
            >
              Reddit
            </a>
            .
          </li>
          <li>
            <b>Brevo</b> sends transactional email such as your one-time
            sign-in link, and receives your email address to deliver it.
            Privacy policy:{" "}
            <a
              href="https://www.brevo.com/legal/privacypolicy/"
              className="text-accent underline"
            >
              brevo.com/legal/privacypolicy
            </a>
            .
          </li>
          <li>
            <b>Anthropic and OpenAI</b> run model inference for generated
            scripts and captions. Their privacy policies cover what they
            do with inputs sent for inference.
          </li>
        </ul>
        <p className="mt-3">
          LoreWire does not sell your data and does not share it with any
          party for advertising purposes.
        </p>
      </Section>

      <Section title="6. YouTube API Services">
        <p>
          Features that use the YouTube Data API v3 are governed by the{" "}
          <a
            href="https://www.youtube.com/t/terms"
            className="text-accent underline"
          >
            YouTube Terms of Service
          </a>{" "}
          and the{" "}
          <a
            href="https://policies.google.com/privacy"
            className="text-accent underline"
          >
            Google Privacy Policy
          </a>
          . LoreWire uses these APIs only to upload videos to channels you
          have connected and, when enabled, to read back basic post
          metrics. We do not use YouTube data to build profiles for
          advertising, share it with brokers, or retain it after you
          disconnect.
        </p>
        <p className="mt-3">
          You can revoke LoreWire&apos;s access to your YouTube account at
          any time from your Google security settings at{" "}
          <a
            href="https://security.google.com/settings/security/permissions"
            className="text-accent underline"
          >
            security.google.com/settings/security/permissions
          </a>
          . Revoking on Google&apos;s side and disconnecting from
          LoreWire&apos;s settings page both invalidate the stored token.
        </p>
      </Section>

      <Section title="7. Cookies">
        <p>
          Every cookie LoreWire sets is first-party and functional. There are
          no advertising or analytics cookies, and none are shared with or read
          by another company. Unless noted, they are httpOnly, Secure, and
          SameSite=Lax.
        </p>
        <ul className="ml-5 list-disc">
          <li>
            <b>Sign-in cookies</b> keep you signed in (a session identifier for
            readers, and a separate one for staff).
          </li>
          <li>
            <b>Sign-in flow cookies</b> exist only for the few minutes of an
            OAuth sign-in, to protect the exchange, then expire.
          </li>
          <li>
            <b>Cookie-choice cookie</b> remembers whether you pressed Accept or
            Reject. It is readable by the page so the banner knows your choice;
            it stores nothing else.
          </li>
          <li>
            <b>Anonymous-activity cookie</b> (<code>lw_anon</code>) ties this
            device&apos;s saved stories and progress together before you sign
            in. Reject clears it.
          </li>
          <li>
            <b>Poll cookie</b> (<code>lw_vote</code>) stops the same browser
            voting twice on a poll.
          </li>
          <li>
            Your light/dark <b>theme preference</b> is kept in your browser&apos;s
            local storage, not a cookie.
          </li>
        </ul>
      </Section>

      <Section title="8. Retention">
        <ul className="ml-5 list-disc">
          <li>
            Account data: kept while your account is active. Deleted within
            30 days of account closure.
          </li>
          <li>
            Connected-account tokens: deleted within minutes of you
            disconnecting the account, and within 24 hours of a platform
            telling us the grant was revoked.
          </li>
          <li>
            Content you create: kept while your account is active. You can
            delete individual items at any time from the editor.
          </li>
          <li>
            Application logs: rotated on a 30-day window.
          </li>
        </ul>
      </Section>

      <Section title="9. Your rights">
        <ul className="ml-5 list-disc">
          <li>
            Access: email {CONTACT_EMAIL} and we will provide a copy of the
            data we hold about you.
          </li>
          <li>
            Correction: edit your profile in the editor, or email us.
          </li>
          <li>
            Deletion: email {CONTACT_EMAIL} to close your account and have the
            data we hold about you erased. We honor the request within 30 days.
          </li>
          <li>
            Disconnect a social account: go to the social accounts page in
            settings and click Disconnect. The stored token is revoked at
            the platform and removed from our database immediately.
          </li>
        </ul>
      </Section>

      <Section title="10. Children">
        <p>
          LoreWire is intended for adults and is not directed at anyone under
          16. We do not knowingly collect personal data from anyone under 16.
          If you believe someone under 16 has provided personal data, email{" "}
          {CONTACT_EMAIL} and we will delete it.
        </p>
      </Section>

      <Section title="11. International transfers">
        <p>
          LoreWire&apos;s infrastructure runs in the United States and the
          European Union depending on the provider. By using the service
          you consent to your data being transferred to and processed in
          those regions.
        </p>
      </Section>

      <Section title="12. Changes to this policy">
        <p>
          Material changes are posted here with an updated effective date,
          and existing users receive an email notice 30 days before the
          change takes effect.
        </p>
      </Section>

      <Section title="13. Contact">
        <p>
          Questions, requests, and complaints go to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent underline">
            {CONTACT_EMAIL}
          </a>
          .
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
