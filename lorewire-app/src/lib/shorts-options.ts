// Creation-time options for article shorts, surfaced in the admin "Generate
// short" picker. Mirrors the Python registries (pipeline/shorts_narration.py
// NARRATION_STYLES and pipeline/shorts.py LENGTH_PRESETS) so the UI can render
// the choices without a round trip. Keep the ids in sync with the Python side;
// the worker resolves an unknown id to the default, so a drift is safe-failing.

export interface ShortOption {
  id: string;
  label: string;
  description: string;
}

export const NARRATION_VIBES: ShortOption[] = [
  {
    id: "storyteller",
    label: "Storyteller",
    description: "Warm, cinematic narrative. Sets a scene and builds to the turn.",
  },
  {
    id: "suspense",
    label: "Suspense / Mystery",
    description: "True-crime tension. Opens on the unsettling fact, builds to a twist.",
  },
  {
    id: "punchy",
    label: "Punchy Explainer",
    description: "Fast, high-retention. Bold hook, one takeaway, teaser-payoff.",
  },
  {
    id: "conversational",
    label: "Conversational",
    description: "Casual and human, like a friend telling you what just happened.",
  },
  {
    id: "documentary",
    label: "Documentary",
    description: "Measured, authoritative, factual. Lets the facts carry the weight.",
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

export const DEFAULT_NARRATION_VIBE = "suspense";
export const DEFAULT_LENGTH_PRESET = "standard";
