"use client";

import { useState } from "react";
import VoiceoverEditor from "./VoiceoverEditor";

type VoiceOption = {
  voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
};
type ModelOption = { id: string; label: string };

// Collapsed "+ New voiceover" affordance that reveals the editor on demand, so
// the page isn't a wall of permanent boxes.
export default function CreateVoiceover({
  models,
  voices,
}: {
  models: ModelOption[];
  voices: VoiceOption[];
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-dashed border-line bg-surface/40 px-4 py-3 text-left text-[13px] text-muted transition-colors hover:border-accent hover:text-ink"
      >
        + New voiceover
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          New voiceover
        </h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[12px] text-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <VoiceoverEditor preset={null} models={models} voices={voices} />
    </div>
  );
}
