// Public sign-in page. Editorial poster v2 (2026-06-21) — wraps the
// SignInForm with the LoreWire brand: wordmark, one-line value prop,
// "back to stories" escape hatch, and a tinted vignette background so
// the page feels intentional instead of an isolated form on black.
//
// Server component: reads the optional `next` query param + the current
// session. If the user is already signed in, redirect home; no point
// showing them sign-in.
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §UI surfaces.

import Link from "next/link";
import { redirect } from "next/navigation";

import { readFacebookConfig } from "@/lib/oauth-facebook";
import { readGoogleConfig } from "@/lib/oauth-google";
import { readMicrosoftConfig } from "@/lib/oauth-microsoft";
import { readRedditConfig } from "@/lib/oauth-reddit";
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

  // Resolve provider availability server-side so the buttons render only
  // for providers that are actually configured. Avoids the "click button,
  // get 503" experience.
  const googleEnabled = Boolean(readGoogleConfig());
  const microsoftEnabled = Boolean(readMicrosoftConfig());
  const redditEnabled = Boolean(readRedditConfig());
  const facebookEnabled = Boolean(readFacebookConfig());
  const magicLinkEnabled = Boolean(process.env.BREVO_API_KEY?.trim());

  const backHref = next && next.startsWith("/") ? next : "/";

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* Cinematic vignette + grain. Mirrors the Billboard treatment on
          the home page so the sign-in surface feels of-the-same-app
          instead of a generic auth form. Pointer-events-none so the
          decoration never intercepts clicks on the card below. */}
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
        {/* Top bar: back-to-stories escape hatch. Lives on the page
            (not inside SignInForm) so the form stays portable for any
            future surface that mounts it without the chrome. */}
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
            Sign in
          </span>
        </header>

        {/* Centered card column. max-w-sm keeps the form a comfortable
            reading width on desktop instead of letting it stretch into
            an awkward wide rectangle. min-h-0 + flex-1 places it
            vertically centered in the remaining viewport regardless of
            header height. */}
        <main className="flex flex-1 items-center justify-center px-5 pb-10 pt-6 sm:pt-10">
          <div className="w-full max-w-sm">
            {/* Wordmark + tagline. The wordmark uses the same
                font-display + tracking-tightest as the home Billboard,
                scaled down here so it anchors the card without
                overwhelming the form. */}
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
                Save stories across devices
              </h1>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
                Sign in so your My List, progress, and votes follow you
                from phone to laptop. Free, no spam, takes 10 seconds.
              </p>

              {error ? (
                <p
                  className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
                  role="alert"
                >
                  Sign-in didn&apos;t complete. Try again or use a different
                  method.
                </p>
              ) : null}

              <div className="mt-5">
                <SignInForm
                  next={next}
                  googleEnabled={googleEnabled}
                  microsoftEnabled={microsoftEnabled}
                  redditEnabled={redditEnabled}
                  facebookEnabled={facebookEnabled}
                  magicLinkEnabled={magicLinkEnabled}
                />
              </div>
            </div>

            {/* Bottom benefits row. Pure typography, no extra chrome,
                so it reads like a footnote rather than a feature list.
                Helps hesitant users see "what do I get?" without
                expanding the form's surface area. justify-center on each
                cell so the dot+label cluster sits centered in its column
                — matches the page's centered alignment instead of
                hugging the left edge of each grid track. */}
            <ul className="mt-5 grid grid-cols-2 gap-y-2 px-1 text-[11px] text-muted">
              <li className="flex items-center justify-center gap-1.5">
                <BenefitDot /> Synced saves
              </li>
              <li className="flex items-center justify-center gap-1.5">
                <BenefitDot /> No passwords
              </li>
              <li className="flex items-center justify-center gap-1.5">
                <BenefitDot /> No inbox spam
              </li>
              <li className="flex items-center justify-center gap-1.5">
                <BenefitDot /> Always free
              </li>
            </ul>

            <p className="mt-6 text-center text-[11px] text-muted">
              By signing in you agree to our{" "}
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

function BenefitDot() {
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
    />
  );
}
