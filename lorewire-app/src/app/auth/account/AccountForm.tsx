"use client";

// Client island for the Account page:
//   - name (text, optional)
//   - profile picture: UPLOAD a photo (validated + re-encoded to WebP
//     server-side, stored on the usercontent CDN) OR paste a link to a hosted
//     image
// Email is rendered read-only with a "why can't I edit this?" explanation.
//
// The avatar upload POSTs multipart to /api/user/avatar, which persists the
// new picture immediately and on its own. The name + pasted-URL fields still
// batch through /api/user/profile on "Save changes".

import { useRef, useState } from "react";

interface AccountFormProps {
  email: string;
  initialName: string | null;
  initialPictureUrl: string | null;
}

// Mirror the server's allowlist + size cap so the user gets instant feedback
// before a wasted round trip. The route in /api/user/avatar re-validates and
// re-encodes regardless — this is convenience, not the security boundary.
const ACCEPT = "image/jpeg,image/png,image/webp";
const MAX_BYTES = 4 * 1024 * 1024;

export default function AccountForm({
  email,
  initialName,
  initialPictureUrl,
}: AccountFormProps) {
  const [name, setName] = useState(initialName ?? "");
  const [pictureUrl, setPictureUrl] = useState(initialPictureUrl ?? "");
  // Baselines track what's persisted, so `dirty` stays correct after an avatar
  // upload (which saves picture_url server-side outside this form).
  const [baseName, setBaseName] = useState(initialName ?? "");
  const [basePicture, setBasePicture] = useState(initialPictureUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const dirty = name !== baseName || pictureUrl !== basePicture;

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
      setBaseName(name.trim());
      setBasePicture(pictureUrl.trim());
      setSavedAt(Date.now());
      setBusy(false);
    } catch (err) {
      console.warn("[auth account ui network-error]", { err: String(err) });
      setError("Couldn't reach the server. Check your connection.");
      setBusy(false);
    }
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    // Reset the input so re-selecting the SAME file fires change again.
    e.target.value = "";
    if (!file) return;
    setUploadMsg(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setUploadMsg({ kind: "err", text: "Choose a JPG, PNG, or WebP image." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadMsg({ kind: "err", text: "That image is too large. Max 4 MB." });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/user/avatar", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; pictureUrl?: string; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.pictureUrl) {
        setUploadMsg({
          kind: "err",
          text: data?.error ?? "Upload failed. Try again.",
        });
        setUploading(false);
        return;
      }
      // The route already persisted picture_url, so advance the baseline too —
      // the form must not now read as "unsaved".
      setPictureUrl(data.pictureUrl);
      setBasePicture(data.pictureUrl);
      setUploadMsg({ kind: "ok", text: "Photo updated." });
      setUploading(false);
    } catch (err) {
      console.warn("[auth account avatar network-error]", { err: String(err) });
      setUploadMsg({ kind: "err", text: "Couldn't reach the server." });
      setUploading(false);
    }
  }

  const initial = (name.trim() || email).charAt(0).toUpperCase();

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

      {/* Profile photo — upload is the primary path. One tap opens the camera
          roll (or camera) on mobile; the preview updates the moment the upload
          lands, which the route has already saved. */}
      <div>
        <label className="block text-[12px] font-mono uppercase tracking-[.2em] text-muted">
          Profile photo
        </label>
        <div className="mt-2 flex items-center gap-4">
          <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-bg/60 text-lg font-semibold text-muted">
            {pictureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={pictureUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span aria-hidden>{initial}</span>
            )}
          </div>
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || busy}
              className="rounded-md border border-ink px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink hover:text-bg disabled:opacity-60"
            >
              {uploading ? "Uploading…" : "Upload photo"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={onPickFile}
            />
            <p className="mt-1 text-[12px] text-muted">
              JPG, PNG, or WebP. Max 4 MB. Saved instantly.
            </p>
            {uploadMsg ? (
              <span
                role={uploadMsg.kind === "err" ? "alert" : "status"}
                className={
                  uploadMsg.kind === "err"
                    ? "text-[12px] text-red-300"
                    : "text-[12px] text-muted"
                }
              >
                {uploadMsg.text}
              </span>
            ) : null}
          </div>
        </div>
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
          Or paste a link to a hosted image (e.g. Gravatar).
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
