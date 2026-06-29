// Remotion root: registers the DoodleShort composition + the PosterStill
// composition (the latter rendered via renderStill from the Cloud Run
// /render-poster endpoint per
// _plans/2026-06-28-phase-2-social-poster-render.md).
//
// CLI renders:
//   Video:  `npx remotion render video/src/Root.tsx DoodleShort out.mp4 --props=./path/to.json`
//   Still:  `npx remotion still video/src/Root.tsx PosterStill out.png --props=./path/to.json`

import React from "react";
import { Composition, registerRoot, type CalculateMetadataFunction } from "remotion";
import { DoodleShort } from "./DoodleShort";
import {
  LANDSCAPE_HEIGHT,
  LANDSCAPE_WIDTH,
  POSTER_HEIGHT,
  POSTER_WIDTH,
  PosterStill,
  PosterStillLandscape,
  type PosterStillLandscapeProps,
  type PosterStillProps,
} from "./PosterStill";
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
const PosterStillLoose = PosterStill as unknown as React.ComponentType<LooseProps>;
const PosterStillLandscapeLoose =
  PosterStillLandscape as unknown as React.ComponentType<LooseProps>;

// PosterStill defaults — only used by Remotion Studio preview when no
// --props is passed. The pipeline render always supplies real props.
const POSTER_DEFAULT_PROPS: PosterStillProps = {
  scene_1_url: "",
  text: "Her refusal ended everything.",
  brand_text: "LORE WIRE",
};

// Phase 3 landscape OG-card defaults. Same shape as the portrait, just
// rendered into the 1200×630 PosterStillLandscape composition. Studio-
// preview only; production always supplies real props.
const POSTER_LANDSCAPE_DEFAULT_PROPS: PosterStillLandscapeProps = {
  scene_1_url: "",
  text: "Her refusal ended everything.",
  brand_text: "LORE WIRE",
};

const Root: React.FC = () => (
  <>
    <Composition
      id="DoodleShort"
      component={DoodleShortLoose}
      fps={FPS}
      width={STUDIO_FALLBACK_DIMS.width}
      height={STUDIO_FALLBACK_DIMS.height}
      defaultProps={DEFAULT_PROPS as unknown as LooseProps}
      calculateMetadata={calculateMetadata}
    />
    {/* Still composition for social cover renders. durationInFrames=1
        because renderStill only ever rasterizes frame 0; fps is required
        by Remotion's Composition contract but unused for stills. */}
    <Composition
      id="PosterStill"
      component={PosterStillLoose}
      fps={FPS}
      width={POSTER_WIDTH}
      height={POSTER_HEIGHT}
      durationInFrames={1}
      defaultProps={POSTER_DEFAULT_PROPS as unknown as LooseProps}
    />
    {/* Phase 3 landscape OG-card composition. Same renderStill seam,
        different aspect. Selected by the Cloud Run /render-poster
        endpoint when `aspect: "landscape"` is requested. Per
        _plans/2026-06-29-phase-3-og-poster-cards.md. */}
    <Composition
      id="PosterStillLandscape"
      component={PosterStillLandscapeLoose}
      fps={FPS}
      width={LANDSCAPE_WIDTH}
      height={LANDSCAPE_HEIGHT}
      durationInFrames={1}
      defaultProps={POSTER_LANDSCAPE_DEFAULT_PROPS as unknown as LooseProps}
    />
  </>
);

registerRoot(Root);
