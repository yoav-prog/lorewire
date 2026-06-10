// Inter is the composition's only font. Loading it through @remotion/google-fonts
// bundles the WOFF2 files at render time so the look is identical across every
// machine — without this, Chromium falls back to whatever sans-serif the host
// happens to have installed and the karaoke caption widths drift, breaking the
// frame distribution math that snaps to caption boundaries.
//
// Weights used: 700 (channel pill), 800 (title chip), 900 (caption band).

import { loadFont } from "@remotion/google-fonts/Inter";

const loaded = loadFont("normal", {
  weights: ["700", "800", "900"],
  subsets: ["latin"],
});

export const FONT_FAMILY = loaded.fontFamily;
