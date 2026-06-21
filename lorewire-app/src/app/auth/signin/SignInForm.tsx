"use client";

// Sign-in form (Editorial poster v2 — _plans/2026-06-21-sign-in-redesign).
// Renders the brand-colored OAuth providers and the magic-link inline
// form. Server component (page.tsx) gates each block on whether the
// provider is configured so users never click a button that 503s.
//
// Visual contract:
//   - Buttons share a single .auth-btn shape: 44px tall, rounded-md,
//     icon + label, focus ring uses the brand accent.
//   - Provider icons are inline SVGs (no extra network hop, no font
//     dependency, and they recolor cleanly under data-theme="light").
//   - Magic-link lives in the same column as the OAuth buttons with an
//     "or use email" divider — no nested card boundary, which made the
//     v1 layout feel like two unrelated surfaces.

import Link from "next/link";
import { useState } from "react";

interface SignInFormProps {
  next: string | undefined;
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  redditEnabled: boolean;
  magicLinkEnabled: boolean;
}

function buildStartUrl(
  provider: "google" | "microsoft" | "reddit",
  next?: string,
): string {
  const url = new URL(`/auth/${provider}/start`, window.location.origin);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

const BUTTON_CLASS =
  "flex w-full items-center justify-center gap-3 rounded-md border border-line bg-surface px-4 py-3 text-[14px] font-medium text-ink transition-colors hover:border-ink hover:bg-surface2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export default function SignInForm({
  next,
  googleEnabled,
  microsoftEnabled,
  redditEnabled,
  magicLinkEnabled,
}: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submitMagic(e: React.FormEvent) {
    e.preventDefault();
    if (!email || busy) return;
    setBusy(true);
    setErr(null);
    console.info("[auth signin magic-request]", {
      email_domain: email.split("@")[1] ?? "",
    });
    try {
      const res = await fetch("/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (!res.ok) {
        console.warn("[auth signin magic-request non-ok]", { status: res.status });
        setErr("Couldn't send the link. Check the email and try again.");
        setBusy(false);
        return;
      }
      console.info("[auth signin magic-request ok]");
      setSent(true);
    } catch (e) {
      console.warn("[auth signin magic-request network]", { err: String(e) });
      setErr("Network problem. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const anyOAuth = googleEnabled || microsoftEnabled || redditEnabled;
  const nothingConfigured =
    !googleEnabled && !microsoftEnabled && !redditEnabled && !magicLinkEnabled;

  return (
    <div className="space-y-4">
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

      {anyOAuth && magicLinkEnabled ? (
        <div
          className="flex items-center gap-3 pt-1 font-mono text-[10px] uppercase tracking-[.22em] text-muted"
          aria-hidden
        >
          <span className="h-px flex-1 bg-line" />
          <span>or use email</span>
          <span className="h-px flex-1 bg-line" />
        </div>
      ) : null}

      {magicLinkEnabled ? (
        sent ? (
          <SentConfirmation email={email} />
        ) : (
          <form onSubmit={submitMagic} className="space-y-3" noValidate>
            <label htmlFor="signin-email" className="sr-only">
              Email
            </label>
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted"
              >
                <MailIcon />
              </span>
              <input
                id="signin-email"
                type="email"
                inputMode="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                placeholder="you@example.com"
                aria-invalid={err ? true : undefined}
                className="block w-full rounded-md border border-line bg-surface py-3 pl-10 pr-3 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !email}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Spinner />
                  <span>Sending the link…</span>
                </>
              ) : (
                <>
                  <span>Email me a sign-in link</span>
                  <ArrowRightIcon />
                </>
              )}
            </button>
            {err ? (
              <p
                className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
                role="alert"
              >
                {err}
              </p>
            ) : null}
          </form>
        )
      ) : null}

      {/* Password sign-in — email + password ("old fashion"). Always
          available, doesn't require any provider config. Lives below the
          magic-link form because magic-link is the recommended path
          (no password to remember) but plenty of users prefer the
          familiar pattern. */}
      <PasswordSignIn next={next} />

      <p className="pt-1 text-center text-[12px] text-muted">
        New here?{" "}
        <Link
          href={
            next ? `/auth/signup?next=${encodeURIComponent(next)}` : "/auth/signup"
          }
          className="text-ink underline-offset-2 hover:text-accent hover:underline"
        >
          Create an account
        </Link>
      </p>

      {nothingConfigured ? (
        <p className="rounded-md border border-line bg-surface p-4 text-[13px] text-muted">
          Sign-in is not configured yet. Check back soon.
        </p>
      ) : null}
    </div>
  );
}

// Email + password sign-in panel. Collapsed by default to keep the
// magic-link path as the visual primary; expands on click. Independent
// email state from the magic-link form so toggling between flows
// doesn't drop what the user typed.
function PasswordSignIn({ next }: { next: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email || !password) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password, next }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; next?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setErr(data?.error ?? "Couldn't sign you in. Try again.");
        setBusy(false);
        return;
      }
      window.location.assign(data.next ?? "/");
    } catch (e) {
      console.warn("[auth login network]", { err: String(e) });
      setErr("Network problem. Try again.");
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full rounded-md border border-line bg-transparent px-4 py-2.5 text-center text-[13px] font-medium text-muted hover:border-ink hover:text-ink"
      >
        Sign in with a password
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-line bg-surface p-4" noValidate>
      <label htmlFor="lw-password-email" className="block">
        <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Email
        </span>
        <input
          id="lw-password-email"
          type="email"
          inputMode="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          placeholder="you@example.com"
          className="mt-1 block w-full rounded-md border border-line bg-surface2 px-3 py-2.5 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
      </label>
      <label htmlFor="lw-password-pw" className="block">
        <span className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Password
        </span>
        <input
          id="lw-password-pw"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="mt-1 block w-full rounded-md border border-line bg-surface2 px-3 py-2.5 text-[14px] text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
      </label>
      <button
        type="submit"
        disabled={busy || !email || !password}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {err ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          {err}
        </p>
      ) : null}
      <p className="text-center text-[11px] text-muted">
        Forgot your password? Use the email sign-in link above for now.
      </p>
    </form>
  );
}

// "Check your inbox" panel — replaces the form once the request lands.
// Tone matches the surrounding card: same border, same bg, same type
// scale. The big check icon is the only celebratory element — the rest
// of the copy stays plain so a user with a slow inbox doesn't doubt the
// result. Two affordances: a webmail quick-open when we can detect the
// provider, and a "try a different email" reset.
function SentConfirmation({ email }: { email: string }) {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const webmail =
    domain.includes("gmail")
      ? { label: "Open Gmail", href: "https://mail.google.com" }
      : domain.includes("outlook") ||
          domain.includes("hotmail") ||
          domain.includes("live")
        ? { label: "Open Outlook", href: "https://outlook.live.com/mail/0/inbox" }
        : domain.includes("yahoo")
          ? { label: "Open Yahoo Mail", href: "https://mail.yahoo.com" }
          : null;
  return (
    <div className="rounded-md border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/15 text-accent"
        >
          <CheckIcon />
        </span>
        <div className="min-w-0">
          <p className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
            Check your inbox
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            We sent a sign-in link to{" "}
            <span className="break-all text-ink">{email}</span>. It expires in
            15 minutes.
          </p>
          <p className="mt-2 text-[12px] text-muted">
            Not there? Check spam, or{" "}
            <button
              type="button"
              onClick={() => {
                // Reload to reset the form cleanly without threading
                // setSent/setEmail back up through props.
                window.location.reload();
              }}
              className="text-ink underline-offset-2 hover:text-accent hover:underline"
            >
              try a different email
            </button>
            .
          </p>
        </div>
      </div>
      {webmail ? (
        <a
          href={webmail.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-line bg-bg px-3 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent"
        >
          <ExternalIcon />
          <span>{webmail.label}</span>
        </a>
      ) : null}
    </div>
  );
}

// ─── icons ──────────────────────────────────────────────────────────────────
// Inline SVGs so the buttons render correctly on first paint (no FOIC) and
// keep their brand colors even if the dark theme inverts surrounding chrome.
// Sized to ~18px so they sit comfortably in the 44px button shape.

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

function MailIcon() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m13 5 7 7-7 7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function Spinner() {
  // Tailwind's built-in `animate-spin` (Tailwind ships the keyframes) so
  // we don't have to extend globals.css for a one-off. Honors
  // prefers-reduced-motion automatically when the user opts out.
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}
