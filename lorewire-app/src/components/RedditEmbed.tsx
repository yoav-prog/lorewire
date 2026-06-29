"use client";

// Reddit's official embed widget: drops a styled card with the post's title,
// score, and a link through. Uses their CDN script at embed.reddit.com which
// hydrates the blockquote in place. Callers gate rendering through
// `resolveRedditEmbedTarget` (lib/reddit-thread) so a story with a wrong or
// placeholder source URL doesn't show a mismatched thread under the body.

import { useEffect, useRef } from "react";

const WIDGET_SRC = "https://embed.reddit.com/widgets.js";

// Re-exported so existing call sites keep importing from this file. The
// stricter validation lives in lib/reddit-thread so it can be unit-tested
// without pulling React into the test runner.
export {
  isRealRedditUrl,
  resolveRedditEmbedTarget,
  type RedditEmbedTarget,
} from "@/lib/reddit-thread";

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
