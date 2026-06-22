"use client";

// Shared OAuth provider buttons. Rendered on BOTH the sign-in and sign-up
// pages so the two surfaces stay identical — a user who lands on "Create
// account" can sign up with Facebook/Google/etc. just like on sign-in (for
// OAuth there is no separate sign-up vs sign-in: the first round-trip creates
// the account, later ones log in).
//
// Each block is gated by the parent (server-resolved) so a disabled provider
// never renders a button that would 503. Icons are inline SVGs — no network
// hop, recolor cleanly under data-theme="light", and paint correctly on first
// frame.
//
// Extracted from SignInForm (2026-06-22, Facebook login). Visual contract
// unchanged: single 44px .auth-btn shape, icon + label.

const BUTTON_CLASS =
  "flex w-full items-center justify-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-[14px] font-medium text-ink transition-colors hover:border-ink hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

type Provider = "google" | "microsoft" | "reddit" | "facebook";

function buildStartUrl(provider: Provider, next?: string): string {
  const url = new URL(`/auth/${provider}/start`, window.location.origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

export interface OAuthButtonsProps {
  next: string | undefined;
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  redditEnabled: boolean;
  facebookEnabled: boolean;
}

export default function OAuthButtons({
  next,
  googleEnabled,
  microsoftEnabled,
  redditEnabled,
  facebookEnabled,
}: OAuthButtonsProps) {
  return (
    <>
      {googleEnabled ? (
        <a href={buildStartUrl("google", next)} className={BUTTON_CLASS}>
          <GoogleIcon />
          <span>Continue with Google</span>
        </a>
      ) : null}

      {microsoftEnabled ? (
        <a href={buildStartUrl("microsoft", next)} className={BUTTON_CLASS}>
          <MicrosoftIcon />
          <span>Continue with Microsoft</span>
        </a>
      ) : null}

      {redditEnabled ? (
        <a href={buildStartUrl("reddit", next)} className={BUTTON_CLASS}>
          <RedditIcon />
          <span>Continue with Reddit</span>
        </a>
      ) : null}

      {facebookEnabled ? (
        <a href={buildStartUrl("facebook", next)} className={BUTTON_CLASS}>
          <FacebookIcon />
          <span>Continue with Facebook</span>
        </a>
      ) : null}
    </>
  );
}

// ─── icons ──────────────────────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022" />
      <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00" />
      <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF" />
      <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900" />
    </svg>
  );
}

function RedditIcon() {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="10" cy="10" r="10" fill="#FF4500" />
      <path
        d="M16.6 10c0-.78-.64-1.42-1.42-1.42-.37 0-.72.14-.98.38-.96-.66-2.26-1.08-3.7-1.14l.7-2.96 2.06.44a1.02 1.02 0 1 0 .1-.62l-2.32-.5a.32.32 0 0 0-.38.24l-.78 3.4c-1.46.05-2.78.48-3.76 1.14a1.42 1.42 0 1 0-1.56 2.32 2.62 2.62 0 0 0-.04.46c0 2.34 2.72 4.24 6.08 4.24s6.08-1.9 6.08-4.24c0-.16-.02-.32-.04-.46.4-.25.66-.7.66-1.18zm-9.92 1.02a1 1 0 1 1 1 1 1 1 0 0 1-1-1zm5.58 2.7c-.68.68-1.98.74-2.36.74s-1.68-.06-2.36-.74a.26.26 0 0 1 .36-.36c.42.42 1.34.58 2 .58s1.58-.16 2-.58a.26.26 0 0 1 .36.36zm-.18-1.7a1 1 0 1 1 1-1 1 1 0 0 1-1 1z"
        fill="#fff"
      />
    </svg>
  );
}

function FacebookIcon() {
  // Canonical Facebook "f" badge (simpleicons path). The blue mark forms the
  // rounded badge; the f is negative space, so it reads correctly on both the
  // dark and light surfaces this button sits on.
  return (
    <svg
      aria-hidden
      width="19"
      height="19"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#1877F2"
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
      />
    </svg>
  );
}
