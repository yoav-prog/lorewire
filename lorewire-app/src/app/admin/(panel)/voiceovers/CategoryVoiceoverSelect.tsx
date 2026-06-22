"use client";

import { useState, useTransition } from "react";
import { setCategoryVoiceoverAction } from "@/app/admin/actions";

// One category -> voiceover row. Auto-saves on change (no Save button) with a
// live status so the click is never ambiguous.
export default function CategoryVoiceoverSelect({
  category,
  currentId,
  presets,
}: {
  category: string;
  currentId: string;
  presets: { id: string; name: string }[];
}) {
  const [value, setValue] = useState(currentId);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function onChange(next: string) {
    setValue(next);
    const fd = new FormData();
    fd.set("category", category);
    fd.set("id", next);
    start(async () => {
      await setCategoryVoiceoverAction(fd);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[13px] text-ink">{category}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent disabled:opacity-60"
      >
        <option value="">Inherit default</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="w-16 shrink-0 text-[11px] text-muted" aria-live="polite">
        {pending ? "Saving…" : saved ? "Saved ✓" : ""}
      </span>
    </div>
  );
}
