"use client";

// Tiny client wrapper around <video> so we can attach an onError handler.
// Server components can't bind DOM event listeners — without this, a
// 404'd video_url silently rendered an empty player and the admin would
// click Publish on a broken video. Now we show a clear error overlay so
// the admin sees the failure before publishing.

import { useState } from "react";

export default function StoryVideoPreview({ src }: { src: string }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-[12px] text-danger">
        Video failed to load (broken URL?).{" "}
        <a
          href={src}
          target="_blank"
          rel="noreferrer noopener"
          className="underline"
        >
          open URL directly ↗
        </a>
      </div>
    );
  }
  return (
    <video
      controls
      preload="metadata"
      src={src}
      onError={() => setError(true)}
      className="w-full rounded-lg border border-line"
    />
  );
}
