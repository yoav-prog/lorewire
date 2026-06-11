// Remotion root: registers the DoodleShort composition.
// CLI render: `npx remotion render video/src/Root.tsx DoodleShort out.mp4 --props=./path/to.json`.

import React from "react";
import { Composition, registerRoot, type CalculateMetadataFunction } from "remotion";
import { DoodleShort } from "./DoodleShort";
import type { ShortVideoConfig } from "./types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// Remotion's Composition + CalculateMetadataFunction generic accepts
// Record<string, unknown>, not arbitrary structured types. We keep
// ShortVideoConfig as the precise internal type and assert at the
// Composition boundary — same pattern @remotion/player asks for in
// lorewire-app/.../SpikeClient.tsx.
type LooseProps = Record<string, unknown>;

const calculateMetadata: CalculateMetadataFunction<LooseProps> = ({
  props,
}) => {
  // durationInFrames is the rendered MP4's length in frames. Without a trim
  // that's just the full duration; with a trim it's the clipped window. The
  // composition shifts all internal timing by clip_start_ms so absolute
  // caption/frame windows still line up while the rendered output is exactly
  // [clip_start_ms, clip_end_ms]. fps + size are fixed by the visual contract.
  const cfg = props as unknown as ShortVideoConfig;
  const clipStart = cfg.clip_start_ms ?? 0;
  const clipEnd = cfg.clip_end_ms ?? cfg.duration_ms;
  const renderedMs = Math.max(1, clipEnd - clipStart);
  const durationInFrames = Math.max(1, Math.ceil((renderedMs / 1000) * FPS));
  return { durationInFrames };
};

// Default props power the Studio preview when no --props is passed. They are
// not used by the pipeline render path, which always supplies real props.
const DEFAULT_PROPS: ShortVideoConfig = {
  voiceover_url: "",
  title: "LoreWire preview",
  channel_name: "lorewire",
  duration_ms: 5000,
  doodle_frames: [],
  captions: [
    { start_ms: 0, end_ms: 2500, text: "Preview" },
    { start_ms: 2500, end_ms: 5000, text: "Composition" },
  ],
};

const DoodleShortLoose = DoodleShort as unknown as React.ComponentType<LooseProps>;

const Root: React.FC = () => (
  <Composition
    id="DoodleShort"
    component={DoodleShortLoose}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={DEFAULT_PROPS as unknown as LooseProps}
    calculateMetadata={calculateMetadata}
  />
);

registerRoot(Root);
