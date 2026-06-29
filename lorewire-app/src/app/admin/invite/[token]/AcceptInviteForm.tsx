"use client";

// Set-password form for accepting a staff invite. Calls the token-gated
// acceptInviteAction, which creates the account + signs in; on success we go to
// the studio. Client-side checks (length, match) are courtesy — the server
// validates the password and the token again.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { acceptInviteAction } from "@/app/admin/(panel)/users/actions";

export default function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (pw.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setError("Passwords don't match.");
      return;
    }
    startTransition(async () => {
      const res = await acceptInviteAction(token, pw);
      if (res.ok) {
        router.push("/admin");
      } else {
        setError(res.error ?? "Couldn't set up your account.");
      }
    });
  }

  return (
    <div className="mt-4 grid gap-3">
      <label className="grid gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Password
        </span>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="new-password"
          className="rounded-md border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
      </label>
      <label className="grid gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Confirm password
        </span>
        <input
          type="password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          autoComplete="new-password"
          className="rounded-md border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
      </label>
      {error && <p className="text-[12px] text-danger">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={pending || !pw || !pw2}
        className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Setting up…" : "Create account"}
      </button>
    </div>
  );
}
