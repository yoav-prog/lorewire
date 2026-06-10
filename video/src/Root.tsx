// Remotion root: registers the DoodleShort composition.
// CLI render: `npx remotion render video/src/Root.tsx DoodleShort out.mp4 --props=./path/to.json`.

import React from "react";
import { Composition, registerRoot, type CalculateMetadataFunction } from "remotion";
import { DoodleShort } from "./DoodleShort";
import type { ShortVideoConfig } from "./types";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

const calculateMetadata: CalculateMetadataFunction<ShortVideoConfig> = ({
  props,
}) => {
  // durationInFrames comes from the props' duration_ms so the same composition
  // handles a 1:30 video and a 4:00 video without a code change. fps + size are
  // fixed by the visual contract.
  const durationInFrames = Math.max(1, Math.ceil((props.duration_ms / 1000) * FPS));
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

const Root: React.FC = () => (
  <Composition
    id="DoodleShort"
    component={DoodleShort}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={calculateMetadata}
  />
);

registerRoot(Root);
