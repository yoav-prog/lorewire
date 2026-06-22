"use client";

// Public comment thread for the article reader — the "inline editorial thread"
// treatment: lives in the article's reading column, inherits its dir (so Hebrew
// is RTL for free), uses the same type scale. SSR provides the first page; this
// island handles posting, replying, sorting, and load-more.
//
// The write path moderates inline, so a posted comment comes back with its
// FINAL status: published (appears live), held ("pending review", visible only
// to its author), or rejected (with a reason + a one-click appeal). No silent
// disappearance — the author always sees what happened to their words.
//
// Plan: _plans/2026-06-22-article-comments-ai-moderation.md (Step 3).

import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PublicComment } from "@/lib/comments";
import type { CommentThreadPage, PublicCommentNode } from "@/lib/comments-read";

type Sort = "newest" | "top";

const NAME_KEY = "lw_comment_name";

function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return iso.slice(0, 10);
}

export function CommentsSection({
  articleId,
  initial,
  initialCount,
  signedIn,
  enabled,
}: {
  articleId: string;
  initial: CommentThreadPage;
  initialCount: number;
  signedIn: boolean;
  enabled: boolean;
}) {
  const [nodes, setNodes] = useState<PublicCommentNode[]>(initial.nodes);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [sort, setSort] = useState<Sort>("newest");
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  const changeSort = useCallback(
    async (next: Sort) => {
      if (next === sort) return;
      setSort(next);
      setBusy(true);
      try {
        const res = await fetch(
          `/api/comments?articleId=${encodeURIComponent(articleId)}&sort=${next}`,
        );
        if (res.ok) {
          const page = (await res.json()) as CommentThreadPage;
          setNodes(page.nodes);
          setCursor(page.nextCursor);
        }
      } finally {
        setBusy(false);
      }
    },
    [articleId, sort],
  );

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/comments?articleId=${encodeURIComponent(articleId)}&sort=${sort}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (res.ok) {
        const page = (await res.json()) as CommentThreadPage;
        setNodes((prev) => [...prev, ...page.nodes]);
        setCursor(page.nextCursor);
      }
    } finally {
      setBusy(false);
    }
  }, [articleId, sort, cursor]);

  const addTopLevel = useCallback((c: PublicComment) => {
    setNodes((prev) => [{ ...c, replies: [] }, ...prev]);
    if (c.status === "published") setCount((n) => n + 1);
  }, []);

  const addReply = useCallback((parentId: string, c: PublicComment) => {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === parentId ? { ...n, replies: [...n.replies, c] } : n,
      ),
    );
    if (c.status === "published") setCount((n) => n + 1);
  }, []);

  const replaceComment = useCallback((updated: PublicComment) => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.id === updated.id) return { ...n, ...updated };
        const replies = n.replies.map((r) => (r.id === updated.id ? updated : r));
        return { ...n, replies };
      }),
    );
  }, []);

  const removeComment = useCallback((id: string) => {
    setNodes((prev) =>
      prev
        .filter((n) => n.id !== id)
        .map((n) => ({ ...n, replies: n.replies.filter((r) => r.id !== id) })),
    );
  }, []);

  return (
    <section className="mt-10 border-t border-line pt-7">
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[20px] font-extrabold tracking-tightest text-ink">
          Discussion{" "}
          <span className="font-mono text-[13px] font-normal text-muted">
            · {count}
          </span>
        </h2>
        <div className="flex gap-1 font-mono text-[11px] uppercase tracking-wider">
          {(["newest", "top"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeSort(s)}
              className={`rounded-md px-2 py-1 transition-colors ${
                sort === s
                  ? "bg-surface2 text-ink"
                  : "text-muted hover:text-ink"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {enabled ? (
        <Composer articleId={articleId} signedIn={signedIn} onPosted={addTopLevel} />
      ) : (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-muted">
          Comments are closed for this article.
        </p>
      )}

      <ol className="mt-6 space-y-5">
        {nodes.map((node) => (
          <li key={node.id}>
            <CommentItem
              comment={node}
              articleId={articleId}
              signedIn={signedIn}
              enabled={enabled}
              onReply={(c) => addReply(node.id, c)}
              onChanged={replaceComment}
              onDeleted={removeComment}
            />
            {node.replies.length > 0 && (
              <ol className="mt-4 space-y-4 border-s border-line ps-4">
                {node.replies.map((r) => (
                  <li key={r.id}>
                    <CommentItem
                      comment={r}
                      articleId={articleId}
                      signedIn={signedIn}
                      enabled={enabled}
                      onChanged={onChangedReply(setNodes, node.id)}
                      onDeleted={removeComment}
                    />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>

      {nodes.length === 0 && (
        <p className="mt-6 text-[14px] text-muted">
          No comments yet. Be the first to weigh in.
        </p>
      )}

      {cursor && (
        <button
          type="button"
          onClick={loadMore}
          disabled={busy}
          className="mt-6 rounded-md border border-line px-4 py-1.5 font-mono text-[12px] uppercase tracking-wider text-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

// Reply edits route back into the right parent's reply list.
function onChangedReply(
  setNodes: Dispatch<SetStateAction<PublicCommentNode[]>>,
  parentId: string,
) {
  return (updated: PublicComment) =>
    setNodes((prev) =>
      prev.map((n) =>
        n.id === parentId
          ? { ...n, replies: n.replies.map((r) => (r.id === updated.id ? updated : r)) }
          : n,
      ),
    );
}

function CommentItem({
  comment,
  articleId,
  signedIn,
  enabled,
  onReply,
  onChanged,
  onDeleted,
}: {
  comment: PublicComment;
  articleId: string;
  signedIn: boolean;
  enabled: boolean;
  onReply?: (c: PublicComment) => void;
  onChanged: (c: PublicComment) => void;
  onDeleted: (id: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reported, setReported] = useState(false);
  // Liked state is client-side for v1: the count is authoritative from the
  // server, but on first load hearts show un-filled (we don't yet join the
  // viewer's likes into the thread query).
  const [like, setLike] = useState({ liked: false, count: comment.likeCount });
  const isReply = !!comment.parentId;

  async function toggleLike(): Promise<void> {
    setLike((s) => ({ liked: !s.liked, count: s.count + (s.liked ? -1 : 1) }));
    try {
      const res = await fetch("/api/comments/like", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId: comment.id }),
      });
      if (res.ok) {
        const d = (await res.json()) as { liked: boolean; likeCount: number };
        setLike({ liked: d.liked, count: d.likeCount });
      }
    } catch {
      // keep the optimistic state; a reload reconciles
    }
  }

  async function del(): Promise<void> {
    if (!window.confirm("Delete this comment?")) return;
    const res = await fetch(`/api/comments/${comment.id}`, { method: "DELETE" });
    if (res.ok) onDeleted(comment.id);
  }

  async function report(): Promise<void> {
    if (reported) return;
    if (!window.confirm("Report this comment to the moderators?")) return;
    const res = await fetch("/api/comments/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentId: comment.id }),
    });
    if (res.ok) setReported(true);
  }

  if (editing) {
    return (
      <EditBox
        comment={comment}
        onCancel={() => setEditing(false)}
        onSaved={(c) => {
          onChanged(c);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">
          {comment.authorName || "Reader"}
        </span>
        <span className="font-mono text-[11px] text-muted">
          {relTime(comment.createdAt)}
          {comment.editedAt ? " · edited" : ""}
        </span>
      </div>

      <p dir="auto" className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-ink">
        {comment.body}
      </p>

      {comment.status === "published" ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-4 font-mono text-[11px] text-muted">
          <button
            type="button"
            onClick={toggleLike}
            aria-pressed={like.liked}
            aria-label={like.liked ? "Unlike" : "Like"}
            className={`tabular-nums transition-colors hover:text-ink ${like.liked ? "text-accent" : ""}`}
          >
            {like.liked ? "♥" : "♡"} {like.count}
          </button>
          {enabled && !isReply && onReply && (
            <button
              type="button"
              onClick={() => setReplying((v) => !v)}
              className="uppercase tracking-wider hover:text-ink"
            >
              {replying ? "Cancel" : "Reply"}
            </button>
          )}
          {comment.isOwn && (
            <>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="uppercase tracking-wider hover:text-ink"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={del}
                className="uppercase tracking-wider hover:text-cat-entitled"
              >
                Delete
              </button>
            </>
          )}
          {!comment.isOwn &&
            (reported ? (
              <span className="uppercase tracking-wider text-muted">Reported</span>
            ) : (
              <button
                type="button"
                onClick={report}
                className="uppercase tracking-wider hover:text-cat-entitled"
              >
                Report
              </button>
            ))}
        </div>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          <OwnStatusNote comment={comment} onChanged={onChanged} />
          {comment.isOwn && (
            <button
              type="button"
              onClick={del}
              className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-cat-entitled"
            >
              Delete
            </button>
          )}
        </div>
      )}

      {replying && onReply && (
        <div className="mt-3">
          <Composer
            articleId={articleId}
            parentId={comment.id}
            signedIn={signedIn}
            compact
            onPosted={(c) => {
              onReply(c);
              setReplying(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function EditBox({
  comment,
  onCancel,
  onSaved,
}: {
  comment: PublicComment;
  onCancel: () => void;
  onSaved: (c: PublicComment) => void;
}) {
  const [body, setBody] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    const text = body.trim();
    if (!text) {
      setErr("Comment can't be empty.");
      return;
    }
    setErr(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        comment?: PublicComment;
        error?: string;
      };
      if (!res.ok || !d.comment) {
        setErr(d.error ?? "Couldn't save the edit.");
        return;
      }
      onSaved(d.comment);
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={4000}
        dir="auto"
        className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-[15px] leading-relaxed text-ink outline-none focus:border-accent"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
        >
          Cancel
        </button>
        {err && <span className="font-mono text-[11px] text-cat-entitled">{err}</span>}
      </div>
      <p className="font-mono text-[10px] text-muted">
        Edited comments are re-checked by the moderator.
      </p>
    </div>
  );
}

// The author's view of their own non-published comment: honest status + an
// appeal on a rejection. Only ever rendered for comment.isOwn (the server only
// returns a non-published comment to its own author).
function OwnStatusNote({
  comment,
  onChanged,
}: {
  comment: PublicComment;
  onChanged: (c: PublicComment) => void;
}) {
  const [appealing, setAppealing] = useState(false);
  const [appealed, setAppealed] = useState(false);

  async function appeal(): Promise<void> {
    setAppealing(true);
    try {
      const res = await fetch("/api/comments/appeal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commentId: comment.id }),
      });
      if (res.ok) {
        setAppealed(true);
        onChanged({ ...comment, status: "held" });
      }
    } finally {
      setAppealing(false);
    }
  }

  if (comment.status === "held" || comment.status === "quarantined") {
    return (
      <p className="mt-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-muted">
        Pending review — only you can see this until a moderator approves it.
      </p>
    );
  }
  // rejected
  return (
    <div className="mt-1.5 rounded-md border border-line bg-surface px-3 py-2 text-[12px]">
      <p className="text-muted">
        This wasn&apos;t posted{comment.moderationReason ? `: ${comment.moderationReason}` : "."}
      </p>
      {appealed ? (
        <p className="mt-1 text-muted">Appeal sent — a moderator will take another look.</p>
      ) : (
        <button
          type="button"
          onClick={appeal}
          disabled={appealing}
          className="mt-1 font-mono uppercase tracking-wider text-accent hover:underline disabled:opacity-50"
        >
          {appealing ? "Sending…" : "Ask a human to review"}
        </button>
      )}
    </div>
  );
}

function Composer({
  articleId,
  parentId,
  signedIn,
  compact,
  onPosted,
}: {
  articleId: string;
  parentId?: string;
  signedIn: boolean;
  compact?: boolean;
  onPosted: (c: PublicComment) => void;
}) {
  const [body, setBody] = useState("");
  const [name, setName] = useState<string>(() => {
    if (signedIn || typeof window === "undefined") return "";
    return window.localStorage.getItem(NAME_KEY) ?? "";
  });
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function submit(): Promise<void> {
    const text = body.trim();
    if (!text) return;
    if (!signedIn && !name.trim()) {
      setErr("Add a name to comment.");
      return;
    }
    setErr(null);
    setPosting(true);
    try {
      if (!signedIn) window.localStorage.setItem(NAME_KEY, name.trim());
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articleId,
          parentId,
          body: text,
          guestName: signedIn ? undefined : name.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        comment?: PublicComment;
        error?: string;
      };
      if (!res.ok || !data.comment) {
        setErr(data.error ?? "Something went wrong. Try again.");
        return;
      }
      onPosted(data.comment);
      setBody("");
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="space-y-2">
      {!signedIn && (
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={60}
          className="w-full max-w-[260px] rounded-md border border-line bg-bg px-3 py-1.5 text-[14px] text-ink outline-none placeholder:text-muted focus:border-accent"
        />
      )}
      <textarea
        ref={taRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={parentId ? "Write a reply…" : "Share your take…"}
        rows={compact ? 2 : 3}
        maxLength={4000}
        dir="auto"
        className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted focus:border-accent"
      />
      <div className="flex items-center justify-between gap-3">
        {err ? (
          <p className="font-mono text-[11px] text-cat-entitled">{err}</p>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {parentId ? "" : "Be kind. Spam and hate get removed."}
          </span>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={posting || !body.trim()}
          className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {posting ? "Posting…" : parentId ? "Reply" : "Post"}
        </button>
      </div>
    </div>
  );
}
