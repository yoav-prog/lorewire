// Public status page for a Meta data-deletion request.
//
// Meta's spec requires the callback (in
// /api/social/oauth/meta/data-deletion/route.ts) to return a `url` field
// that points at a user-visible page showing the deletion status. This
// page is that destination. It lives outside /api/ so the URL reads as
// a normal public page (/data-deletion/<uuid>), no auth required because
// the visitor is no longer connected to the app.
//
// Phase 0: validate the code shape, explain what was deleted. Phase 1+:
// look up an actual deletion-log row by code and surface "completed at X".

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data deletion status",
  description:
    "Status of a Meta data deletion request submitted to LoreWire.",
  robots: { index: false, follow: false },
};

export default async function DataDeletionStatusPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const codeLooksValid = /^[0-9a-f-]{36}$/i.test(code);

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-[15px] leading-relaxed text-ink">
      <header className="mb-8 border-b border-line pb-4">
        <Link
          href="/"
          className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-accent hover:underline"
        >
          ← LoreWire
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Data deletion status
        </h1>
      </header>

      {codeLooksValid ? (
        <section className="space-y-3">
          <p>
            <span className="font-mono text-[12px] text-muted">
              Confirmation code:
            </span>{" "}
            <code className="rounded bg-line/40 px-2 py-0.5 font-mono text-[12px]">
              {code}
            </code>
          </p>
          <p>
            When you disconnected the LoreWire app from your Facebook
            account, Meta notified our service. We received the
            notification, verified it cryptographically, and revoked any
            stored access tokens associated with your account.
          </p>
          <p>
            Tokens are removed within minutes of the notification. Posts
            you published while connected remain on your account and are
            managed there by you, not by LoreWire.
          </p>
          <p>
            Questions about what data LoreWire held: email{" "}
            <a
              href="mailto:info@lorewire.com"
              className="text-accent underline"
            >
              info@lorewire.com
            </a>{" "}
            with this confirmation code.
          </p>
        </section>
      ) : (
        <section className="space-y-3">
          <p className="text-warn">
            That confirmation code does not look valid.
          </p>
          <p>
            If you reached this page from a link Meta gave you and the
            code shown above does not match, email{" "}
            <a
              href="mailto:info@lorewire.com"
              className="text-accent underline"
            >
              info@lorewire.com
            </a>{" "}
            and we will investigate.
          </p>
        </section>
      )}

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/privacy" className="hover:text-accent hover:underline">
          Privacy Policy
        </Link>
      </footer>
    </main>
  );
}
