"use client";

// CommentsTab: wraps CommentsSection for client-side mount points where
// the initial thread + count can't be pre-fetched server-side.
//
// The article reader page (/articles/[locale]/[slug]) mounts CommentsSection
// directly because it's a server component — it can call loadCommentThread
// + countPublishedComments + commentsEnabledForArticle in Promise.all and
// pass the results down as props. The homepage TitleSheet is a client
// component opened dynamically from a list view, so the same pre-fetch
// isn't available. This wrapper fetches the initial thread the moment
// the tab mounts and renders the regular CommentsSection with the
// fetched data — same UX, same composer, same load-more / sort / reply.
//
// Story.id is used as articleId. Stories on the homepage and articles in
// the reader are currently distinct rows; using story.id here means the
// homepage thread is independent of the article reader's thread for the
// same content. That tradeoff is noted in the plan; unifying them
// requires a separate story→article join that we don't have today.

import { useEffect, useState } from "react";

import { CommentsSection } from "@/components/CommentsSection";
import type { CommentThreadPage } from "@/lib/comments-read";

interface CommentsTabProps {
  storyId: string;
  /** True when the viewer has an lw_user session. Drives the composer's
   *  identity row ("Posting as @name" vs the guest-name input). Comments
   *  API verifies the actual session cookie server-side regardless. */
  signedIn: boolean;
}

interface InitResponse {
  count: number;
  enabled: boolean;
}

export function CommentsTab({ storyId, signedIn }: CommentsTabProps) {
  const [thread, setThread] = useState<CommentThreadPage | null>(null);
  const [meta, setMeta] = useState<InitResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setMeta(null);
    setErr(null);
    const qs = `articleId=${encodeURIComponent(storyId)}`;
    Promise.all([
      fetch(`/api/comments?${qs}`).then(async (r) =>
        r.ok ? ((await r.json()) as CommentThreadPage) : null,
      ),
      fetch(`/api/comments/count?${qs}`).then(async (r) =>
        r.ok ? ((await r.json()) as InitResponse) : { count: 0, enabled: true },
      ),
    ])
      .then(([page, info]) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.info("[comments tab loaded]", {
          story_id: storyId,
          count: info.count,
          enabled: info.enabled,
          page_nodes: page?.nodes.length ?? 0,
        });
        setThread(page ?? { nodes: [], nextCursor: null });
        setMeta(info);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[comments tab fetch failed]", {
          story_id: storyId,
          err: String(e),
        });
        setErr("Couldn't load comments. Try again in a moment.");
      });
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  if (err) {
    return (
      <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
        {err}
      </p>
    );
  }

  if (!thread || !meta) {
    return (
      <p className="px-1 py-6 text-center font-mono text-[11px] uppercase tracking-[.2em] text-muted">
        Loading comments…
      </p>
    );
  }

  return (
    <CommentsSection
      articleId={storyId}
      initial={thread}
      initialCount={meta.count}
      signedIn={signedIn}
      enabled={meta.enabled}
    />
  );
}
