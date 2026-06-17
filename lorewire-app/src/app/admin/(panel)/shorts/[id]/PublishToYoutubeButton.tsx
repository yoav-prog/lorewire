"use client";

// "Publish to YouTube" footer button on the short editor. POSTs to
// /api/social/youtube/publish, which uploads the story's latest finished short
// to the connected channel as a YouTube Short and writes back a public URL.
// Disabled until a finished short exists; a confirm() gates the quota spend
// (plan F3); error codes map to plain operator guidance. Plan section 9.

import { useState } from "react";

type Phase = "idle" | "publishing" | "done" | "error";

const ERROR_TEXT: Record<string, string> = {
  "not-connected": "Connect a YouTube account in Settings → Social accounts.",
  "needs-reauth": "YouTube needs reconnecting in Settings → Social accounts.",
  "in-progress": "A publish for this short is already running.",
  "short-not-ready": "Finish rendering the short before publishing.",
  "audio-blocked": "This short's audio is not cleared for publishing.",
  "invalid-metadata": "The short's title or description is not valid for YouTube.",
  "upload-failed": "YouTube rejected the upload. Check the logs and try again.",
  "bad-json": "The publish request was malformed.",
  "missing-storyId": "The publish request was missing the story id.",
};

export function PublishToYoutubeButton({
  storyId,
  disabled,
}: {
  storyId: string;
  /** True when no finished short exists yet — render the button but disable so
   *  the affordance is discoverable and the tooltip explains why. */
  disabled: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  async function publish() {
    if (
      !window.confirm(
        "Publish this short to YouTube? This uses about 1,600 quota units (roughly 6 publishes/day on the default quota).",
      )
    ) {
      return;
    }
    setPhase("publishing");
    setError(null);
    setUrl(null);
    try {
      const res = await fetch("/api/social/youtube/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        publicUrl?: string;
        error?: string;
        reason?: string;
        detail?: string;
      };
      // eslint-disable-next-line no-console -- rule 14
      console.info("[social publish click]", {
        storyId,
        ok: res.ok,
        status: data.status ?? null,
        error: data.error ?? null,
      });
      if (res.ok && data.publicUrl) {
        setUrl(data.publicUrl);
        setPhase("done");
        return;
      }
      const msg =
        data.reason ||
        data.detail ||
        (data.error ? (ERROR_TEXT[data.error] ?? data.error) : null) ||
        "Publish failed.";
      setError(msg);
      setPhase("error");
    } catch {
      setError("Network error reaching the publish endpoint.");
      setPhase("error");
    }
  }

  const pending = phase === "publishing";
  const done = phase === "done" && url !== null;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex-1 text-[12px] text-ink">
        <p className="font-medium">Publish this short to YouTube</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Uploads the latest finished short to the connected channel as a YouTube
          Short. Uses ~1,600 quota units (about 6/day on the default quota).
        </p>
        {done && (
          <p className="mt-1 break-all font-mono text-[10px] text-muted">
            published → <span className="text-ink">{url}</span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {done && url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:bg-accent/10"
          >
            View on YouTube ↗
          </a>
        )}
        <button
          type="button"
          onClick={publish}
          disabled={pending || disabled || done}
          title={disabled ? "Finish rendering the short first" : undefined}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Publishing…" : done ? "Published ✓" : "Publish to YouTube"}
        </button>
      </div>
      {error && (
        <span className="basis-full font-mono text-[10px] text-warn">{error}</span>
      )}
    </div>
  );
}
