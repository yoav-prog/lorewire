"use client";

// Per-scene "Use in article" actions. Each scene card in ScenesTab mounts
// one of these; the three buttons promote the scene's image into the
// chosen linked article's hero / og / gallery slot via the server
// actions in ./actions.ts.
//
// UX:
//  - 0 linked articles → render nothing (the parent surfaces a tab-level
//    hint).
//  - 1 linked article → render three buttons; click applies to that one
//    article.
//  - 2+ → render a select above the buttons; the picked article is the
//    target. Picker state is local-per-card so an admin can target
//    different articles per scene (rare but real for SEO variants).
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md (Phase 5+).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LinkedArticleSummary } from "./actions";
import {
  addSceneToArticleGallery,
  promoteSceneToArticleHero,
  promoteSceneToArticleOg,
} from "./actions";

const BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

export function SceneArticleActions({
  storyId,
  frameId,
  frameAlt,
  linkedArticles,
}: {
  storyId: string;
  frameId: string;
  frameAlt: string;
  linkedArticles: LinkedArticleSummary[];
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string>(
    linkedArticles[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (linkedArticles.length === 0) return null;

  const articleId = picked || linkedArticles[0]?.id || "";

  function apply(kind: "hero" | "og" | "gallery") {
    if (!articleId) return;
    setError(null);
    setApplied(null);
    startTransition(async () => {
      let r: { ok: boolean; error?: string };
      if (kind === "hero") {
        r = await promoteSceneToArticleHero(storyId, frameId, articleId);
      } else if (kind === "og") {
        r = await promoteSceneToArticleOg(storyId, frameId, articleId);
      } else {
        r = await addSceneToArticleGallery(storyId, frameId, articleId, frameAlt);
      }
      if (!r.ok) {
        setError(r.error ?? "apply failed");
        return;
      }
      setApplied(kind);
      router.refresh();
      // Auto-clear the "applied" pill after a moment so the buttons
      // don't get stuck in a per-click confirmation state.
      window.setTimeout(() => setApplied(null), 2500);
    });
  }

  return (
    <div className="space-y-1.5">
      {linkedArticles.length > 1 && (
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={pending}
          className="w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-accent disabled:cursor-wait"
        >
          {linkedArticles.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title ?? "(untitled)"}
              {a.language ? ` · ${a.language}` : ""}
            </option>
          ))}
        </select>
      )}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => apply("hero")}
          disabled={pending || !articleId}
          className={BTN}
          title="Replace the article's hero image with this scene"
        >
          {applied === "hero" ? "Hero ✓" : "Hero"}
        </button>
        <button
          type="button"
          onClick={() => apply("og")}
          disabled={pending || !articleId}
          className={BTN}
          title="Replace the article's OG image with this scene"
        >
          {applied === "og" ? "OG ✓" : "OG"}
        </button>
        <button
          type="button"
          onClick={() => apply("gallery")}
          disabled={pending || !articleId}
          className={BTN}
          title="Append this scene to the article's gallery"
        >
          {applied === "gallery" ? "Gallery ✓" : "Gallery"}
        </button>
      </div>
      {error && (
        <p className="font-mono text-[10px] text-warn">{error}</p>
      )}
    </div>
  );
}
