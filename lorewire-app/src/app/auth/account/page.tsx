// Public-user account page. Edit name + picture. Email is read-only
// (it's the identity anchor for sign-in; changing it would orphan the
// OAuth + magic-link paths and needs a verify-the-new-address flow that
// is out of scope for v1).
//
// Server component: resolves the session, redirects to /auth/signin
// when the visitor is anonymous so the URL of this page isn't a way
// to reach the form without authenticating first.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { redirect } from "next/navigation";

import { getUserById } from "@/lib/users";
import { readUserSession } from "@/lib/user-session";
import AccountForm from "./AccountForm";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await readUserSession();
  if (!session) {
    redirect("/auth/signin?next=%2Fauth%2Faccount");
  }
  const user = await getUserById(session.userId);
  if (!user) {
    // Session points at a row that no longer exists — clearest path is
    // re-sign-in. The signout route would clear the cookie too but the
    // redirect alone leaves the stale cookie around; that's harmless
    // because the next callback re-creates the row.
    redirect("/auth/signin?next=%2Fauth%2Faccount");
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-10">
      <a
        href="/"
        className="inline-flex items-center gap-1 text-[12px] font-mono uppercase tracking-[.2em] text-muted hover:text-ink"
      >
        ← Back
      </a>
      <h1 className="mt-4 font-display text-2xl font-bold uppercase tracking-tight text-ink">
        Account &amp; preferences
      </h1>
      <p className="mt-2 text-sm text-muted">
        Edit how your account appears across LoreWire. Your email stays
        tied to how you sign in and isn&apos;t editable here.
      </p>

      <AccountForm
        email={user.email}
        initialName={user.name}
        initialPictureUrl={user.picture_url}
      />
    </div>
  );
}
