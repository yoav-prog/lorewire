"use client";

// "Publish to Instagram" admin action on the short editor.
//
// Mirror of PublishToFacebookButton — same inline panel pattern, same
// caption-override + delete-previous knobs. One UI difference: IG can
// return a `pending` outcome (container created but still IN_PROGRESS
// on IG's side after our inline 30s budget). The retry cron will
// publish it within ~5 minutes; we surface that as "queued" rather
// than a failure.
//
// Plan: _plans/2026-06-24-instagram-auto-publish.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  publishToInstagramAction,
  type ManualInstagramPublishResult,
} from "./actions";
import type { InstagramPostRow } from "@/lib/publish-to-instagram";

export function PublishToInstagramButton({
  storyId,
  disabled,
  initialPost,
}: {
  storyId: string;
  disabled: boolean;
  initialPost: InstagramPostRow | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deletePrevious, setDeletePrevious] = useState(false);
  const [captionOverride, setCaptionOverride] = useState("");
  const [result, setResult] = useState<ManualInstagramPublishResult | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const hasPosted =
    initialPost !== null &&
    initialPost.status === "posted" &&
    Boolean(initialPost.external_post_id);

  function submit() {
    setResult(null);
    startTransition(async () => {
      const r = await publishToInstagramAction(storyId, {
        deletePrevious,
        captionOverride: captionOverride.trim() || undefined,
      });
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor ig-publish-button result]", {
        story_id: storyId,
        ok: r.ok,
        pending: r.pending ?? false,
        error: r.error ?? null,
        external_post_id: r.externalPostId ?? null,
        deleted_post_id: r.deletedPostId ?? null,
        delete_previous: deletePrevious,
      });
      setResult(r);
      if (r.ok) {
        router.refresh();
        setCaptionOverride("");
        setDeletePrevious(false);
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 text-[12px] text-ink">
          <p className="font-medium">Publish this short to Instagram (Reel)</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Posts the latest finished short as a Reel to the LoreWire IG
            account. Bypasses the global auto-publish toggle and the
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
              ? "Re-publish to Instagram"
              : "Publish to Instagram"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 text-[12px]">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink">
              Caption (optional override)
            </span>
            <textarea
              value={captionOverride}
              onChange={(e) => setCaptionOverride(e.target.value)}
              rows={3}
              placeholder="Leave empty to use the template-rendered caption from settings. Instagram caps captions at 2200 characters — anything longer gets truncated."
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] text-muted">
              Tokens like {"{{hook}}"} are NOT substituted here — type the
              final caption verbatim if you fill this in.
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
                  Delete the previous Instagram post first
                </span>
                <span className="block text-[11px] text-muted">
                  Removes the prior Reel from the LoreWire IG account
                  (DELETE on the Graph API) before publishing the new one.
                  If the delete fails, the new publish is aborted so you
                  can investigate without ending up with two Reels.
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
                ? "Publishing…"
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
            result.pending ? (
              <>
                ⏳ Queued on Instagram. The video is still processing on
                IG's side; the retry cron will publish it within the next
                5 minutes.
                {result.deletedPostId && (
                  <span className="text-muted">
                    {" "}
                    (previous {result.deletedPostId} deleted)
                  </span>
                )}
              </>
            ) : (
              <>
                ✓ Posted{" "}
                {result.deletedPostId && (
                  <span className="text-muted">
                    (previous {result.deletedPostId} deleted)
                  </span>
                )}
                {result.externalPostId && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.instagram.com/p/${result.externalPostId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      open on Instagram ↗
                    </a>
                  </>
                )}
              </>
            )
          ) : (
            <>✗ {result.error}</>
          )}
        </div>
      )}
    </div>
  );
}

function CurrentState({ post }: { post: InstagramPostRow | null }) {
  if (!post) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        No Instagram post for this story yet.
      </p>
    );
  }
  if (post.status === "posted" && post.external_post_id) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Posted {formatWhen(post.posted_at)} ·{" "}
        <a
          href={`https://www.instagram.com/reel/${post.external_post_id}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-accent"
        >
          view Reel ↗
        </a>
      </p>
    );
  }
  if (post.status === "failed") {
    return (
      <p className="mt-1 font-mono text-[10px] text-warn">
        Last attempt failed ({post.attempts ?? 0}×):{" "}
        {post.error_message ?? "unknown error"}
        <span className="text-muted">
          {" "}
          — retry cron will pick it up; you can also force a fresh attempt above.
        </span>
      </p>
    );
  }
  if (post.status === "pending") {
    if (post.container_id) {
      return (
        <p className="mt-1 font-mono text-[10px] text-muted">
          Container {post.container_id.slice(0, 12)}… created on IG, still
          processing. Retry cron will finish publishing it within ~5 minutes.
        </p>
      );
    }
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Pending — the retry cron will pick it up shortly.
      </p>
    );
  }
  if (post.status === "deleted") {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Previous Reel {post.external_post_id} was removed from IG.
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
