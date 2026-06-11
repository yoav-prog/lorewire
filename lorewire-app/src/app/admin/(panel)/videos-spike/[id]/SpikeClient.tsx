"use client";

// Spike client: dynamic-imports @remotion/player so the Player bundle never
// reaches the server render path (matches the council's "iframe fallback if
// SSR is hostile" plan but proves we don't need it). The inline Composition
// uses standard Remotion primitives (`useCurrentFrame`, `interpolate`,
// `AbsoluteFill`) so we are validating the whole chain — Next 16 client
// boundary, Player runtime, composition transform pipeline — not just the
// import resolving.

import { useMemo } from "react";
import dynamic from "next/dynamic";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
} from "remotion";

const PlayerNoSSR = dynamic(
  () => import("@remotion/player").then((m) => m.Player),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center rounded-xl border border-line bg-surface text-[12px] text-muted"
        style={{ aspectRatio: "9 / 16", maxHeight: "70vh" }}
      >
        Loading Player runtime…
      </div>
    ),
  },
);

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;
const DURATION_FRAMES = FPS * 5;

// Remotion's Player widens component props to Record<string, unknown> so any
// composition can mount it. We keep a precise local type for ergonomics and
// cast at the Player boundary below — same pattern @remotion/player docs use
// when not pairing the composition with a Zod schema.
interface SpikeCompProps extends Record<string, unknown> {
  title: string;
}

function SpikeComposition({ title }: SpikeCompProps) {
  const frame = useCurrentFrame();
  // Fade in over the first 18 frames, hold, then drift up over the last 30.
  const fadeIn = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lift = interpolate(
    frame,
    [DURATION_FRAMES - 30, DURATION_FRAMES],
    [0, -24],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ background: "#fbfaf4" }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          padding: 64,
        }}
      >
        <div
          style={{
            opacity: fadeIn,
            transform: `translateY(${lift}px)`,
            color: "#1a1714",
            fontFamily: "Arial Black, Arial, sans-serif",
            fontSize: 96,
            fontWeight: 900,
            lineHeight: 1.05,
            textAlign: "center",
            letterSpacing: -2,
            maxWidth: 880,
          }}
        >
          {title}
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "flex-end",
          padding: 96,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            opacity: fadeIn,
            color: "#fbfaf4",
            background: "#e8462b",
            fontFamily: "Arial, sans-serif",
            fontSize: 36,
            padding: "10px 28px",
            borderRadius: 999,
            letterSpacing: 1,
            fontWeight: 700,
          }}
        >
          frame {frame}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export default function SpikeClient({ title }: { title: string }) {
  // `inputProps` is memoized so the Player doesn't re-mount the composition
  // on every parent render — recommended in the Remotion Player docs and the
  // same pattern the real editor will use when edit state changes drive
  // composition props.
  const inputProps = useMemo(() => ({ title }), [title]);

  // eslint-disable-next-line no-console -- rule 14
  console.info("[video editor spike] client mounted", { title });

  // Player's `component` prop is typed as `LooseComponentType<Record<string,
  // unknown>>` — required keys on the composition's own props are stripped at
  // the boundary. We keep the strong internal type for ergonomics and cast
  // here. Matches the @remotion/player example for typed inputProps without
  // a Zod schema.
  const Component = SpikeComposition as unknown as React.ComponentType<
    Record<string, unknown>
  >;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <PlayerNoSSR
        component={Component}
        inputProps={inputProps}
        durationInFrames={DURATION_FRAMES}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        fps={FPS}
        controls
        loop
        style={{
          aspectRatio: `${WIDTH} / ${HEIGHT}`,
          maxHeight: "70vh",
          width: "100%",
          borderRadius: 12,
          overflow: "hidden",
        }}
      />
    </div>
  );
}
