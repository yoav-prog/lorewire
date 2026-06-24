"use client";

// "Publish to TikTok" admin action on the short editor.
//
// Two TikTok-specific surfaces on top of the FB/IG button shape:
//   - Post mode chip group (Drafts vs Direct). Drafts is the only mode
//     that works pre-audit; Direct requires the TikTok app audit to
//     have cleared the video.publish scope.
//   - The "delete previous" action only marks the local row as deleted
//     (TikTok's Content Posting API has no delete endpoint). The
//     actual post must be removed in the TikTok app.
//
// Like IG, the publisher can return `pending` (publish_id created but
// TikTok still processing after the inline 30s poll budget). The retry
// cron resumes polling within ~5 minutes; we surface that as "queued"
// rather than a failure.
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  publishToTikTokAction,
  type ManualTikTokPublishResult,
} from "./actions";
import type { TikTokPostRow } from "@/lib/publish-to-tiktok";

type PostMode = "default" | "inbox" | "direct";

export function PublishToTikTokButton({
  storyId,
  disabled,
  initialPost,
}: {
  storyId: string;
  disabled: boolean;
  initialPost: TikTokPostRow | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deletePrevious, setDeletePrevious] = useState(false);
  const [captionOverride, setCaptionOverride] = useState("");
  const [postMode, setPostMode] = useState<PostMode>("default");
  const [result, setResult] = useState<ManualTikTokPublishResult | null>(null);
  const [pending, startTransition] = useTransition();

  const hasPosted =
    initialPost !== null &&
    initialPost.status === "posted" &&
    Boolean(initialPost.external_post_id || initialPost.post_mode === "inbox");

  function submit() {
    setResult(null);
    startTransition(async () => {
      const r = await publishToTikTokAction(storyId, {
        deletePrevious,
        captionOverride: captionOverride.trim() || undefined,
        postModeOverride:
          postMode === "inbox" || postMode === "direct" ? postMode : undefined,
      });
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor tt-publish-button result]", {
        story_id: storyId,
        ok: r.ok,
        pending: r.pending ?? false,
        error: r.error ?? null,
        external_post_id: r.externalPostId ?? null,
        local_row_marked_deleted: r.localRowMarkedDeleted ?? false,
        delete_previous: deletePrevious,
        post_mode: postMode,
      });
      setResult(r);
      if (r.ok) {
        router.refresh();
        setCaptionOverride("");
        setPostMode("default");
        setDeletePrevious(false);
      }
    });
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 text-[12px] text-ink">
          <p className="font-medium">Publish this short to TikTok</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Posts the latest finished short to the LoreWire TikTok account.
            Drafts mode (the default until app audit clears) sends it to the
            TikTok app Inbox; Direct mode posts it live. Bypasses the global
            auto-publish toggle.
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
              ? "Re-publish to TikTok"
              : "Publish to TikTok"}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 text-[12px]">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="font-medium text-ink">
              Post mode (override)
            </legend>
            {(
              [
                { id: "default", label: "Use setting" },
                { id: "inbox", label: "Drafts (inbox)" },
                { id: "direct", label: "Direct (live)" },
              ] as const
            ).map((opt) => (
              <label key={opt.id} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="tt-postmode"
                  checked={postMode === opt.id}
                  onChange={() => setPostMode(opt.id)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </fieldset>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-ink">
              Caption (optional override)
            </span>
            <textarea
              value={captionOverride}
              onChange={(e) => setCaptionOverride(e.target.value)}
              rows={4}
              placeholder="Leave empty to use the template-rendered caption from settings. TikTok caps captions at 2200 characters."
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] text-muted">
              Hashtags inline. Tokens like {"{{hook}}"} are NOT substituted —
              type the final caption verbatim if you fill this in.
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
                  Mark previous TikTok row as deleted first
                </span>
                <span className="block text-[11px] text-muted">
                  TikTok's API has no delete endpoint — this only clears the
                  local row so the new publish can insert cleanly. The
                  actual post stays live on TikTok and must be removed in
                  the app.
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
                  ? "Mark previous deleted + publish"
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
                ⏳ Queued on TikTok. The video is still processing on
                TikTok's side; the retry cron will publish it within the
                next 5 minutes.
              </>
            ) : (
              <>
                ✓{" "}
                {result.externalPostId
                  ? "Posted live"
                  : "Sent to TikTok inbox — open the LoreWire TikTok app to publish from drafts"}
                {result.externalPostId && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.tiktok.com/@LoreWire/video/${result.externalPostId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      open on TikTok ↗
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

function CurrentState({ post }: { post: TikTokPostRow | null }) {
  if (!post) {
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        No TikTok post for this story yet.
      </p>
    );
  }
  if (post.status === "posted") {
    if (post.post_mode === "inbox") {
      return (
        <p className="mt-1 font-mono text-[10px] text-muted">
          Sent to the TikTok inbox {formatWhen(post.posted_at)}. Open the
          LoreWire TikTok app to publish from drafts.
        </p>
      );
    }
    if (post.external_post_id) {
      return (
        <p className="mt-1 font-mono text-[10px] text-muted">
          Posted live {formatWhen(post.posted_at)} ·{" "}
          <a
            href={`https://www.tiktok.com/@LoreWire/video/${post.external_post_id}`}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-accent"
          >
            view on TikTok ↗
          </a>
        </p>
      );
    }
    return (
      <p className="mt-1 font-mono text-[10px] text-muted">
        Posted {formatWhen(post.posted_at)} (no external id available)
      </p>
    );
  }
  if (post.status === "failed") {
    return (
      <p className="mt-1 font-mono text-[10px] text-warn">
        Last attempt failed ({post.attempts ?? 0}×):{" "}
        {post.error_message ?? "unknown error"}
        {post.tt_error_code && (
          <span className="text-muted"> · code: {post.tt_error_code}</span>
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
    if (post.publish_id) {
      return (
        <p className="mt-1 font-mono text-[10px] text-muted">
          TikTok publish_id {post.publish_id.slice(0, 12)}… created, still
          processing. Retry cron will finish polling within ~5 minutes.
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
        Previous TikTok row marked deleted (the post itself, if any, must
        be removed in the TikTok app).
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
