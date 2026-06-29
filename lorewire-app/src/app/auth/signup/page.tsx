// Dedicated email + password signup page. Same editorial poster shell as
// /auth/signin so visiting either feels like one continuous surface.
// "Already have an account? Sign in" link wires the loop closed.

import Link from "next/link";
import { redirect } from "next/navigation";

import { readFacebookConfig } from "@/lib/oauth-facebook";
import { readGoogleConfig } from "@/lib/oauth-google";
import { readMicrosoftConfig } from "@/lib/oauth-microsoft";
import { readRedditConfig } from "@/lib/oauth-reddit";
import { readUserSession } from "@/lib/user-session";
import OAuthButtons from "../_components/OAuthButtons";
import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function SignupPage({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const session = await readUserSession();
  if (session) {
    redirect(next && next.startsWith("/") ? next : "/");
  }

  const backHref = next && next.startsWith("/") ? next : "/";
  const signInHref = next
    ? `/auth/signin?next=${encodeURIComponent(next)}`
    : "/auth/signin";

  // OAuth signup is the same round-trip as OAuth sign-in (first time creates
  // the account), so the same provider buttons belong here. Gate each on its
  // config so a lazy user landing on "Create account" gets every option that
  // sign-in offers, not just email + password.
  const googleEnabled = Boolean(readGoogleConfig());
  const microsoftEnabled = Boolean(readMicrosoftConfig());
  const redditEnabled = Boolean(readRedditConfig());
  const facebookEnabled = Boolean(readFacebookConfig());
  const anyOAuth =
    googleEnabled || microsoftEnabled || redditEnabled || facebookEnabled;

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 50% -10%, rgba(232,70,43,.18) 0%, rgba(232,70,43,0) 55%), radial-gradient(120% 90% at 50% 110%, rgba(91,59,138,.18) 0%, rgba(91,59,138,0) 55%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grain opacity-40"
      />

      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-5 pt-5 sm:px-8 sm:pt-6">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.22em] text-muted backdrop-blur-sm transition-colors hover:border-ink hover:text-ink"
          >
            <svg
              aria-hidden
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
            <span>{next ? "Cancel" : "Back to stories"}</span>
          </Link>
          <span className="font-mono text-[10px] uppercase tracking-[.28em] text-muted">
            Create account
          </span>
        </header>

        <main className="flex flex-1 items-center justify-center px-5 pb-10 pt-6 sm:pt-10">
          <div className="w-full max-w-sm">
            <div className="mb-8 text-center">
              <p className="font-display text-[28px] font-black uppercase tracking-tightest leading-none text-ink ink-shadow sm:text-[32px]">
                LoreWire
              </p>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[.32em] text-accent">
                True internet stories, retold daily
              </p>
            </div>

            <div className="rounded-2xl border border-line bg-surface/80 p-5 shadow-2xl backdrop-blur-sm sm:p-6">
              <h1 className="font-display text-[20px] font-extrabold uppercase tracking-tightest text-ink">
                Create your account
              </h1>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                Pick a provider, or create an account with email. Either way
                your saves carry across devices the moment you sign in.
              </p>

              {anyOAuth ? (
                <div className="mt-5 space-y-4">
                  <OAuthButtons
                    next={next}
                    googleEnabled={googleEnabled}
                    microsoftEnabled={microsoftEnabled}
                    redditEnabled={redditEnabled}
                    facebookEnabled={facebookEnabled}
                  />
                  <div
                    className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[.22em] text-muted"
                    aria-hidden
                  >
                    <span className="h-px flex-1 bg-line" />
                    <span>or use email</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                </div>
              ) : null}

              <SignupForm next={next} />

              <p className="mt-4 text-center text-[12px] text-muted">
                Already have an account?{" "}
                <Link
                  href={signInHref}
                  className="text-ink underline-offset-2 hover:text-accent hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </div>

            <p className="mt-6 text-center text-[11px] text-muted">
              By creating an account you agree to our{" "}
              <Link
                href="/terms"
                className="text-ink underline-offset-2 hover:text-accent hover:underline"
              >
                Terms
              </Link>{" "}
              and{" "}
              <Link
                href="/privacy"
                className="text-ink underline-offset-2 hover:text-accent hover:underline"
              >
                Privacy
              </Link>
              .
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
