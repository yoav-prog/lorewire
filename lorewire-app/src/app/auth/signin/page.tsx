// Public sign-in page. Three options — Google, Microsoft, magic link.
// This is the v1 surface; Phase 5 lands the polished slide-up nudge
// that triggers at value moments. This page stays as the dedicated
// route the nudge links to ("Use another method"), and as the
// direct-link destination for the future Settings → Sign in entry.
//
// Server component: reads the optional `next` query param + the current
// session. If the user is already signed in, redirect home; no point
// showing them sign-in.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import { redirect } from "next/navigation";

import { readGoogleConfig } from "@/lib/oauth-google";
import { readMicrosoftConfig } from "@/lib/oauth-microsoft";
import { readUserSession } from "@/lib/user-session";
import SignInForm from "./SignInForm";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { next, error } = await searchParams;
  const session = await readUserSession();
  if (session) {
    redirect(next && next.startsWith("/") ? next : "/");
  }

  // We resolve provider availability server-side so the buttons render
  // only for providers that are actually configured. Avoids the "click
  // button, get 503" experience.
  const googleEnabled = Boolean(readGoogleConfig());
  const microsoftEnabled = Boolean(readMicrosoftConfig());
  const magicLinkEnabled = Boolean(process.env.BREVO_API_KEY?.trim());

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="font-display text-2xl font-bold uppercase tracking-tight text-ink">
        Sign in
      </h1>
      <p className="mt-2 text-sm text-muted">
        Keep your saved stories and progress across devices.
      </p>

      {error ? (
        <p
          className="mt-4 rounded-md border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-300"
          role="alert"
        >
          Sign-in failed. Try again or use a different method.
        </p>
      ) : null}

      <SignInForm
        next={next}
        googleEnabled={googleEnabled}
        microsoftEnabled={microsoftEnabled}
        magicLinkEnabled={magicLinkEnabled}
      />
    </div>
  );
}
