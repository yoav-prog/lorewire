"use client";

// Self-service two-factor enrollment for the signed-in staff member. Steps:
// idle -> setup (show secret + otpauth URI, enter a code to confirm) ->
// done (show one-time backup codes). When already enabled, offers a
// password-gated turn-off. No QR library — the authenticator app takes the
// base32 setup key (or the otpauth URI) by manual entry.
//
// Phase 8 of _plans/2026-06-22-admin-user-management.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  confirmMfaSetupAction,
  disableMfaAction,
  startMfaSetupAction,
} from "./actions";

export default function MfaSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"idle" | "setup" | "done">("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disarming, setDisarming] = useState(false);
  const [password, setPassword] = useState("");

  function begin() {
    setError(null);
    startTransition(async () => {
      const res = await startMfaSetupAction();
      if (res.ok && res.secret) {
        setSecret(res.secret);
        setUri(res.otpauthUri ?? "");
        setCode("");
        setMode("setup");
      } else {
        setError(res.error ?? "Couldn't start setup.");
      }
    });
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await confirmMfaSetupAction(code);
      if (res.ok) {
        setBackupCodes(res.backupCodes ?? []);
        setMode("done");
      } else {
        setError(res.error ?? "Couldn't enable two-factor.");
      }
    });
  }

  function finish() {
    setMode("idle");
    setSecret("");
    setUri("");
    setCode("");
    setBackupCodes([]);
    router.refresh();
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const res = await disableMfaAction(password);
      if (res.ok) {
        setDisarming(false);
        setPassword("");
        router.refresh();
      } else {
        setError(res.error ?? "Couldn't turn off two-factor.");
      }
    });
  }

  // Backup codes just generated — show once.
  if (mode === "done") {
    return (
      <div>
        <p className="text-[13px] text-ink">
          Two-factor is on. Save these backup codes somewhere safe — each works
          once if you lose your authenticator. They won&apos;t be shown again.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-[13px] text-ink">
          {backupCodes.map((c) => (
            <li key={c} className="rounded bg-bg px-2 py-1">
              {c}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={finish}
          className="mt-3 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
        >
          Done
        </button>
      </div>
    );
  }

  // Already enrolled.
  if (enabled) {
    return (
      <div>
        <p className="text-[13px] text-muted">
          Two-factor authentication is <span className="text-ink">on</span>.
          You enter a code from your authenticator (or a backup code) at sign-in.
        </p>
        {!disarming ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPassword("");
              setDisarming(true);
            }}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink transition-colors hover:border-danger hover:text-danger"
          >
            Turn off
          </button>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={disable}
              disabled={pending || !password}
              className="rounded-md border border-danger bg-danger/15 px-3 py-1.5 text-[13px] font-semibold text-danger transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Confirm turn off
            </button>
            <button
              type="button"
              onClick={() => {
                setDisarming(false);
                setError(null);
              }}
              className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>
    );
  }

  // Mid-enrollment: show the secret + confirm with a code.
  if (mode === "setup") {
    return (
      <div>
        <p className="text-[13px] text-muted">
          Add this key to your authenticator app (Google Authenticator,
          1Password, etc.), then enter the 6-digit code it shows.
        </p>
        <div className="mt-3 rounded-md border border-line bg-bg p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
            Setup key
          </div>
          <code className="mt-1 block break-all font-mono text-[14px] tracking-wider text-ink">
            {secret}
          </code>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            otpauth URI
          </div>
          <code className="mt-1 block break-all font-mono text-[11px] text-muted">
            {uri}
          </code>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={confirm}
            disabled={pending || !code}
            className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            Verify &amp; enable
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
            className="font-mono text-[10px] uppercase tracking-wider text-muted hover:text-ink"
          >
            Cancel
          </button>
        </div>
        {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      </div>
    );
  }

  // Not enrolled.
  return (
    <div>
      <p className="text-[13px] text-muted">
        Add a second factor (an authenticator app) for sign-in. Optional — you
        can turn it off anytime.
      </p>
      <button
        type="button"
        onClick={begin}
        disabled={pending}
        className="mt-3 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        Enable two-factor
      </button>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
