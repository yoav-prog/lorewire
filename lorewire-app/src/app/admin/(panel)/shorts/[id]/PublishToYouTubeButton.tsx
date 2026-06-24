"use client";

// "Publish to YouTube" admin action on the short editor.
//
// Mirror of PublishToFacebookButton / PublishToInstagramButton with the
// YouTube-specific surface: title override, description override, tags
// override (comma-separated), and the same delete-previous knob.
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  publishToYouTubeAction,
  type ManualYouTubePublishResult,
} from "./actions";
import type { YouTubePostRow } from "@/lib/publish-to-youtube";

export function PublishToYouTubeButton({
  storyId,
  disabled,
  initialPost,
}: {
  storyId: string;
  disabled: boolean;
  initialPost: YouTubePostRow | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deletePrevious, setDeletePrevious] = useState(false);
  const [titleOverride, setTitleOverride] = useState("");
  const [descriptionOverride, setDescriptionOverride] = useState("");
  const [tagsOverride, setTagsOverride] = useState("");
  const [result, setResult] = useState<ManualYouTubePublishResult | null>(null);
  const [pending, startTransition] = useTransition();

  const hasPosted =
    initialPost !== null &&
    initialPost.status === "posted" &&
    Boolean(initialPost.external_video_id);

  function submit() {
    setResult(null);
    startTransition(async () => {
      const r = await publishToYouTubeAction(storyId, {
        deletePrevious,
        titleOverride: titleOverride.trim() || undefined,
        descriptionOverride: descriptionOverride.trim() || undefined,
        // We pass the override even when empty so admin can intentionally
        // clear the tags (rare, but supported). The server treats `null`
        // / `undefined` differently from `""`.
        tagsOverride: tagsOverride.length > 0 ? tagsOverride : undefined,
      });
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor yt-publish-button result]", {
        story_id: storyId,
        ok: r.ok,
        error: r.error ?? null,
        external_video_id: r.externalVideoId ?? null,
        deleted_video_id: r.deletedVideoId ?? null,
        delete_previous: deletePrevious,
      });
      setResult(r);
      if (r.ok) {
        router.refresh();
        setTitleOverride("");
        setDescriptionOverride("");
        setTagsOverride("");
        setDeletePrevious(false);
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 text-[12px] text-ink">
          <p className="font-medium">Publish this short to YouTube</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Uploads the latest finished short to the LoreWire YouTube channel
            (@LoreWireHQ). Bypasses the global auto-publish toggle and the
            story-level dedup — use re-publish with care.
          </p>
          <CurrentState post={initialPost} />
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title={
            disabled ? "Render a short first" : "Open the publish options"
          }
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {open
            ? "Cancel"
            : hasPosted
              ? "Re-publish to YouTube"
              : "Publish to YouTube"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 text-[12px]">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink">Title (optional override)</span>
            <input
              value={titleOverride}
              onChange={(e) => setTitleOverride(e.target.value)}
              placeholder="Leave empty to use the template-rendered title from settings. Capped at 100 chars."
              maxLength={100}
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink">
              Description (optional override)
            </span>
            <textarea
              value={descriptionOverride}
              onChange={(e) => setDescriptionOverride(e.target.value)}
              rows={5}
              placeholder="Leave empty to use the template-rendered description from settings. Capped at 5000 chars."
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] text-muted">
              Tokens like {"{{hook}}"} are NOT substituted here — type the final
              text verbatim if you fill this in.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink">Tags (optional override)</span>
            <input
              value={tagsOverride}
              onChange={(e) => setTagsOverride(e.target.value)}
              placeholder="Comma-separated. Leave empty to use the base + per-category tags from settings."
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] text-muted">
              Capped at 8 tags total, 500 chars combined.
            </span>
          </label>

          {hasPosted && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={deletePrevious}
                onChange={(e) => setDeletePrevious(e.target.checked)}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="font-medium text-ink">
                  Delete the previous YouTube video first
                </span>
                <span className="block text-[11px] text-muted">
                  Removes the prior video from the channel (DELETE on the
                  Data API) before uploading the new one. If the delete
                  fails, the new publish is aborted so you can investigate
                  without ending up with two videos.
                </span>
              </span>
            </label>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending
                ? "Uploading…"
                : deletePrevious
                  ? "Delete previous + publish"
                  : "Publish now"}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div
          className={`mt-2 rounded-md border px-2 py-1.5 font-mono text-[11px] ${
            result.ok
              ? "border-accent/40 bg-accent/5 text-accent"
              : "border-warn/40 bg-warn/5 text-warn"
          }`}
        >
          {result.ok ? (
            <>
              ✓ Posted{" "}
              {result.deletedVideoId && (
                <span className="text-muted">
                  (previous {result.deletedVideoId} deleted)
                </span>
              )}
              {result.externalVideoId && (
                <>
                  {" "}
                  ·{" "}
                  <a
                    href={`https://www.youtube.com/watch?v=${result.externalVideoId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    open on YouTube ↗
                  </a>
                </>
              )}
            </>
          ) : (
            <>✗ {result.error}</>
          )}
        </div>
      )}
    </div>
  );
}

function CurrentState({ post }: { post: YouTubePostRow | null }) {
  if (!post) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        No YouTube video for this story yet.
      </p>
    );
  }
  if (post.status === "posted" && post.external_video_id) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Posted {formatWhen(post.posted_at)} ·{" "}
        <a
          href={`https://www.youtube.com/watch?v=${post.external_video_id}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-accent"
        >
          view on YouTube ↗
        </a>
      </p>
    );
  }
  if (post.status === "failed") {
    return (
      <p className="mt-1 font-mono text-[10px] text-warn">
        Last attempt failed ({post.attempts ?? 0}×):{" "}
        {post.error_message ?? "unknown error"}
        {post.yt_error_reason && (
          <span className="text-muted"> · reason: {post.yt_error_reason}</span>
        )}
        <span className="text-muted">
          {" "}
          — retry cron will pick it up; you can also force a fresh attempt
          above.
        </span>
      </p>
    );
  }
  if (post.status === "pending") {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Pending — the retry cron should drain it within ~5 minutes.
      </p>
    );
  }
  if (post.status === "deleted") {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Previous video {post.external_video_id} was removed from the channel.
      </p>
    );
  }
  return null;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "(unknown time)";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "(unknown time)";
  const now = Date.now();
  const diffMs = now - d.valueOf();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}
