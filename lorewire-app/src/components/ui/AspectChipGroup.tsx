"use client";

// Visual chip group for picking a video aspect ratio. Phase 4 of
// _plans/2026-06-12-video-aspect-ratio.md. Wraps the Phase A ChipGroup
// with two preset chips ("16:9 landscape" and "9:16 portrait") whose
// preview slot renders a tiny CSS-only frame in the right shape so the
// admin picks by what the value LOOKS like, not by reading the string.
//
// Pure presentational — caller owns state. Used by:
//   - SettingChipGroup at /admin/settings (global default)
//   - the story edit page (per-story override)
//   - the video editor's Metadata panel (per-story override, auto-saving)
//   - the segment upload form (which orientation to normalise to)
//
// Lives next to the other ui/ primitives so it can be imported anywhere
// without dragging an admin-only dep tree.

import { ChipGroup, type ChipOption } from "./ChipGroup";
import { type VideoAspect } from "@/lib/aspect";

const FRAME_LANDSCAPE = (
  <span
    aria-hidden
    className="block rounded-sm border border-line bg-surface2"
    style={{ width: 24, height: 13 }}
  />
);

const FRAME_PORTRAIT = (
  <span
    aria-hidden
    className="block rounded-sm border border-line bg-surface2"
    style={{ width: 13, height: 24 }}
  />
);

export const ASPECT_CHIP_OPTIONS: ChipOption<VideoAspect>[] = [
  {
    id: "16:9",
    label: "16:9 wide",
    hint: "Landscape — YouTube main feed, X / Twitter cards, LinkedIn",
    preview: FRAME_LANDSCAPE,
  },
  {
    id: "9:16",
    label: "9:16 tall",
    hint: "Portrait — YouTube Shorts, TikTok, Reels",
    preview: FRAME_PORTRAIT,
  },
];

export interface AspectChipGroupProps {
  value: VideoAspect;
  onChange: (next: VideoAspect) => void;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export function AspectChipGroup({
  value,
  onChange,
  label,
  ariaLabel,
  disabled,
}: AspectChipGroupProps) {
  return (
    <ChipGroup<VideoAspect>
      value={value}
      options={ASPECT_CHIP_OPTIONS}
      onChange={onChange}
      label={label}
      ariaLabel={ariaLabel ?? label ?? "Aspect ratio"}
      disabled={disabled}
    />
  );
}
