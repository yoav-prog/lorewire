"use client";

// Client island for the Account page. Two fields:
//   - name (text, optional)
//   - pictureUrl (URL, optional)
//
// Email is rendered as a read-only field with a "Why can't I edit this?"
// affordance — clearer than just disabling the input. POSTs the patch
// to /api/user/profile and shows inline confirmation / error.

import { useState } from "react";

interface AccountFormProps {
  email: string;
  initialName: string | null;
  initialPictureUrl: string | null;
}

export default function AccountForm({
  email,
  initialName,
  initialPictureUrl,
}: AccountFormProps) {
  const [name, setName] = useState(initialName ?? "");
  const [pictureUrl, setPictureUrl] = useState(initialPictureUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    (name ?? "") !== (initialName ?? "") ||
    (pictureUrl ?? "") !== (initialPictureUrl ?? "");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/user/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: name.trim() || null,
          pictureUrl: pictureUrl.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setError(
          data?.error && res.status === 400
            ? data.error
            : "Couldn't save your changes. Try again.",
        );
        setBusy(false);
        return;
      }
      setSavedAt(Date.now());
      setBusy(false);
    } catch (err) {
      console.warn("[auth account ui network-error]", { err: String(err) });
      setError("Couldn't reach the server. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-6">
      {/* Read-only email row — visible so the user knows which account
          they're editing, with a small explanation under it so the
          immutability isn't mysterious. */}
      <div>
        <label className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Email
        </label>
        <div className="mt-1 rounded-md border border-line bg-bg/60 px-3 py-2 text-sm text-muted">
          {email}
        </div>
        <p className="mt-1 text-[12px] text-muted">
          Email is tied to how you sign in and can&apos;t be changed here.
        </p>
      </div>

      <div>
        <label htmlFor="lw-account-name" className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Display name
        </label>
        <input
          id="lw-account-name"
          type="text"
          inputMode="text"
          autoComplete="name"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="Your name"
          className="mt-1 block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-60"
        />
        <p className="mt-1 text-[12px] text-muted">
          Up to 64 characters. Letters, digits, spaces, apostrophes, hyphens, periods.
        </p>
      </div>

      <div>
        <label htmlFor="lw-account-picture" className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Picture URL
        </label>
        <input
          id="lw-account-picture"
          type="url"
          inputMode="url"
          autoComplete="off"
          maxLength={512}
          value={pictureUrl}
          onChange={(e) => setPictureUrl(e.target.value)}
          disabled={busy}
          placeholder="https://example.com/your-photo.jpg"
          className="mt-1 block w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none disabled:opacity-60"
        />
        <p className="mt-1 text-[12px] text-muted">
          Paste a link to a hosted image (e.g. Gravatar). Upload coming later.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || !dirty}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        {savedAt && !dirty ? (
          <span className="text-[12px] text-muted" role="status">
            Saved.
          </span>
        ) : null}
        {error ? (
          <span className="text-[12px] text-red-300" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
