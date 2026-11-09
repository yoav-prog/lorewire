"use client";

// The reader's video player. Same native-controls <video> the page rendered
// inline before, wrapped in a client component so the Skip Intro feature can
// overlay its button and honor the "Always skip intro" pref (the same
// lw.wires.skip_intro store the Wires cards read — one knob, both players).
// The intro window is resolved SERVER-side (lib/intro-window-resolve) and
// arrives as two numbers; the raw props blob never reaches the client.
// Plan: _plans/2026-07-04-skip-intro.md.

import { useRef } from "react";
import SkipIntroButton from "@/components/SkipIntroButton";
import { useSkipIntro } from "@/components/useSkipIntro";
import { useWirePrefs } from "@/components/wires/useWirePrefs";
import type { IntroWindow } from "@/lib/intro-window";

export interface StoryVideoProps {
  storyId: string;
  src: string;
  poster: string | null;
  /** CSS aspect-ratio value (from aspectDims), e.g. "9 / 16". */
  cssRatio: string;
  introWindow: IntroWindow | null;
}

export default function StoryVideo({
  storyId,
  src,
  poster,
  cssRatio,
  introWindow,
}: StoryVideoProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { skipIntro } = useWirePrefs();
  const {
    showSkip,
    skipNow,
    handleTimeUpdate,
    handleLoadedMetadata,
    notifyManualSeek,
  } = useSkipIntro({
    introWindow,
    autoSkip: skipIntro,
    logNs: "story skip-intro",
    id: storyId,
  });

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-bg">
      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        preload="metadata"
        poster={poster ?? undefined}
        className="block w-full"
        style={{ aspectRatio: cssRatio }}
        onLoadedMetadata={(e) => handleLoadedMetadata(e.currentTarget)}
        onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
        // Native controls own seeking here. Our programmatic skip also fires
        // this event, but its target (the window's end) sits OUTSIDE the
        // window, so it can never suppress itself — only a user seek landing
        // INSIDE the intro does.
        onSeeking={(e) => notifyManualSeek(e.currentTarget.currentTime * 1000)}
      />
      {/* Above the native control bar, Netflix placement. */}
      {showSkip && (
        <div className="absolute bottom-16 right-3 z-10">
          <SkipIntroButton onClick={() => skipNow(videoRef.current)} />
        </div>
      )}
    </div>
  );
}
