// Remotion root: registers the DoodleShort composition.
// CLI render: `npx remotion render video/src/Root.tsx DoodleShort out.mp4 --props=./path/to.json`.

import React from "react";
import { Composition, registerRoot, type CalculateMetadataFunction } from "remotion";
import { DoodleShort } from "./DoodleShort";
import type { ShortVideoConfig } from "./types";
import { aspectDims, LEGACY_DEFAULT_ASPECT } from "./aspect";
import { deriveCompositionMetadata, FPS } from "./composition-metadata";

// Studio-preview fallback dimensions. The renderer hands real width/
// height back from `calculateMetadata` on every actual render (one of
// 1080x1920 portrait or 1920x1080 landscape via the aspect resolver),
// so these only show up when an admin opens the composition in Remotion
// Studio without supplying props. Kept at the legacy 9:16 so the Studio
// preview matches what the pipeline produced before Phase 0.
const STUDIO_FALLBACK_DIMS = aspectDims(LEGACY_DEFAULT_ASPECT);

// Remotion's Composition + CalculateMetadataFunction generic accepts
// Record<string, unknown>, not arbitrary structured types. We keep
// ShortVideoConfig as the precise internal type and assert at the
// Composition boundary — same pattern @remotion/player asks for in
// lorewire-app/.../SpikeClient.tsx.
type LooseProps = Record<string, unknown>;

const calculateMetadata: CalculateMetadataFunction<LooseProps> = ({
  props,
}) => {
  const cfg = props as unknown as ShortVideoConfig;
  const m = deriveCompositionMetadata(cfg);

  console.info("[render aspect resolve]", {
    config_aspect: cfg.aspect ?? null,
    resolved: m.resolvedAspect,
    width: m.width,
    height: m.height,
  });

  return {
    durationInFrames: m.durationInFrames,
    width: m.width,
    height: m.height,
  };
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
    width={STUDIO_FALLBACK_DIMS.width}
    height={STUDIO_FALLBACK_DIMS.height}
    defaultProps={DEFAULT_PROPS as unknown as LooseProps}
    calculateMetadata={calculateMetadata}
  />
);

registerRoot(Root);
