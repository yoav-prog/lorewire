"use client";

// Reddit's official embed widget: drops a styled card with the post's title,
// score, and a link through. Uses their CDN script at embed.reddit.com which
// hydrates the blockquote in place. Falls back to a plain link footer when
// the source URL doesn't look like a real post (e.g. fixture placeholders),
// so the demo envelope row doesn't render a broken embed.

import { useEffect, useRef } from "react";

const WIDGET_SRC = "https://embed.reddit.com/widgets.js";

// Real post ids on Reddit are alphanumeric and 5+ chars. We exclude obvious
// placeholder strings so the demo doesn't try to embed a non-existent post.
export function isRealRedditUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const match = url.match(/reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]{5,})/i);
  if (!match) return false;
  const id = match[1].toLowerCase();
  return !["example", "test", "placeholder", "demo"].includes(id);
}

interface Props {
  url: string;
  title?: string;
}

export function RedditEmbed({ url, title }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Inject the Reddit widget script once per page load. If it's already on
    // the page, ask it to re-scan in case we mounted a new blockquote.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${WIDGET_SRC}"]`,
    );
    if (existing) {
      // Reddit exposes a `redditEmbedded.run()` global once the widget loads.
      // It's optional and undocumented, so we ignore missing.
      const win = window as unknown as { redditEmbedded?: { run?: () => void } };
      win.redditEmbedded?.run?.();
      return;
    }
    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    document.body.appendChild(script);
  }, [url]);

  return (
    <div ref={containerRef} className="reddit-embed-wrapper">
      <blockquote
        className="reddit-embed-bq"
        data-embed-height="500"
        data-embed-theme="dark"
        style={{ margin: 0 }}
      >
        <a href={url} target="_blank" rel="noopener noreferrer">
          {title || "View on Reddit"}
        </a>
      </blockquote>
    </div>
  );
}
