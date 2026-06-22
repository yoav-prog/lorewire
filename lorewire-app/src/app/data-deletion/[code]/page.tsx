// Public status page for a Meta data-deletion request.
//
// Meta's spec requires the callback (in
// /api/social/oauth/meta/data-deletion/route.ts) to return a `url` field
// that points at a user-visible page showing the deletion status. This
// page is that destination. It lives outside /api/ so the URL reads as
// a normal public page (/data-deletion/<uuid>), no auth required because
// the visitor is no longer connected to the app.
//
// Looks the confirmation code up in the data_deletion_requests audit log and
// surfaces the real outcome ("completed", or "verified but nothing was
// connected"). Falls back to a generic explanation when the code isn't on
// file. Copy is deliberately plain — no "access tokens" jargon, which means
// nothing to a normal person and is wrong for login users anyway (we store no
// token). Plan: _plans/2026-06-22-facebook-login-and-data-deletion.md §B.

import type { Metadata } from "next";
import Link from "next/link";

import { getDeletionRequest } from "@/lib/account-deletion";

export const dynamic = "force-dynamic";

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
  const record = codeLooksValid ? await getDeletionRequest(code) : null;

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

      {!codeLooksValid ? (
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
      ) : (
        <section className="space-y-3">
          <p>
            <span className="font-mono text-[12px] text-muted">
              Confirmation code:
            </span>{" "}
            <code className="rounded bg-line/40 px-2 py-0.5 font-mono text-[12px]">
              {code}
            </code>
          </p>

          {record && record.deleted ? (
            <>
              <p>
                Done. Your LoreWire account and the data tied to it have
                been deleted: your saved stories, likes, reading and
                watching history, and your profile. Any votes you cast were
                kept as part of anonymous poll totals but are no longer
                linked to you.
              </p>
              <p className="text-[13px] text-muted">
                Recorded {new Date(record.created_at).toUTCString()}.
              </p>
            </>
          ) : record && !record.deleted ? (
            <p>
              We received and cryptographically verified this request, but
              no LoreWire account was connected to it — there was nothing to
              delete. If you believe that is wrong, email us with this code.
            </p>
          ) : (
            <p>
              We received and cryptographically verified this deletion
              request and removed the account data associated with it: saved
              stories, likes, reading and watching history, and profile.
              Votes are retained only as anonymous poll totals, no longer
              linked to anyone.
            </p>
          )}

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
      )}

      <footer className="mt-10 border-t border-line pt-4 text-[12px] text-muted">
        <Link href="/privacy" className="hover:text-accent hover:underline">
          Privacy Policy
        </Link>
      </footer>
    </main>
  );
}
