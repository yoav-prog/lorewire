// Creation-time options for article shorts, surfaced in the admin "Generate
// short" picker. Mirrors the Python registries (pipeline/shorts_narration.py
// NARRATION_STYLES and pipeline/shorts.py LENGTH_PRESETS) so the UI can render
// the choices without a round trip. Keep the ids in sync with the Python side;
// the worker resolves an unknown id to the default, so a drift is safe-failing.
//
// 2026-06-21: the five-vibe registry was replaced by a single hook-first
// structure per _plans/2026-06-21-shorts-hook-first-restructure.md. Tone
// variance lives inside the one structure (the script LLM picks a tone_knob
// per story) rather than as a picker preset. The picker keeps a single entry
// so legacy renders that stored a narration_style of "suspense", "punchy",
// etc. resolve cleanly to the new default — the Python `get_style` falls back
// to hook-first for any unknown id.

export interface ShortOption {
  id: string;
  label: string;
  description: string;
}

export const NARRATION_VIBES: ShortOption[] = [
  {
    id: "hook-first",
    label: "Hook-first (cold-open climax)",
    description:
      "Opens on the climax beat, rewinds to the start, builds back, then hands the viewer the poll.",
  },
];

export const LENGTH_PRESETS: ShortOption[] = [
  {
    id: "standard",
    label: "Standard (~45s)",
    description: "Punchy single-beat short.",
  },
  {
    id: "extended",
    label: "Extended (~1 min)",
    description: "Longer cut that develops the story more.",
  },
];

export const DEFAULT_NARRATION_VIBE = "hook-first";
export const DEFAULT_LENGTH_PRESET = "standard";
