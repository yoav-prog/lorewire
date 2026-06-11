// MicroWiggle wraps any image-rendering child with a small sinusoidal
// rotation + translate driven by useCurrentFrame() and a per-instance seed.
// Subtle on purpose: max 0.6 degrees and 2px. Composes cleanly on top of a
// Ken-Burns scale/translate because we apply the wiggle as a sibling CSS
// transform inside an inner wrapper, so the two transforms stack instead of
// stomping each other.

import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

interface Props {
  seed: number;
  enabled: boolean;
  children: React.ReactNode;
}

export const MicroWiggle: React.FC<Props> = ({ seed, enabled, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!enabled) return <>{children}</>;

  // Two slow sinusoids at different periods + offsets, so x and y don't move
  // in lockstep. Frequencies in Hz; period ~1.5s and ~2.3s respectively.
  const t = frame / fps;
  const xAmp = 2;
  const yAmp = 1.5;
  const rotAmp = 0.6;
  const x = Math.sin(t * 4.2 + seed * 1.7) * xAmp;
  const y = Math.cos(t * 2.7 + seed * 0.9) * yAmp;
  const rot = Math.sin(t * 3.1 + seed * 0.5) * rotAmp;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transform: `translate(${x}px, ${y}px) rotate(${rot}deg)`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  );
};
