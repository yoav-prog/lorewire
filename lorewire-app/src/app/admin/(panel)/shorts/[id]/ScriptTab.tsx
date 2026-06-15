"use client";

// Script tab — Phase 3 of the short editor.
//
// One textarea bound to ShortConfig.script with a 1.5 s autosave debounce
// (matches the Scenes / Captions tabs). Editing the script triggers a
// Lane B re-render plan: new audio gets synthesized from this text and
// new caption timing comes off the alignment.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useEffect, useRef, useState, useTransition } from "react";
import type { ShortConfig } from "@/lib/short-config";
import { saveShortConfigPatch } from "./actions";

const SAVE_DEBOUNCE_MS = 1500;

export function ScriptTab({
  storyId,
  config,
  onConfigChange,
}: {
  storyId: string;
  config: ShortConfig;
  onConfigChange: (next: ShortConfig) => void;
}) {
  const [draft, setDraft] = useState(config.script ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync draft when the parent config updates (e.g. after a Lane B
  // render finishes and refreshes the loader).
  useEffect(() => {
    setDraft(config.script ?? "");
  }, [config.script]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function onChange(value: string) {
    setDraft(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaving(true);
      startTransition(async () => {
        const result = await saveShortConfigPatch(storyId, { script: value });
        if (!result.ok) {
          setError(result.error ?? "save failed");
        } else if (result.config) {
          onConfigChange(result.config);
        }
        setSaving(false);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  const charCount = draft.length;
  // The shorts pipeline targets 45-60s narration; rough rule of thumb is
  // ~14 chars/sec at normal pace, so 600-840 chars is the sweet spot.
  const tooShort = charCount > 0 && charCount < 200;
  const tooLong = charCount > 1200;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Narration script
        </h2>
        <span className="font-mono text-[10px] text-muted">
          Edits trigger Lane B (voice + assembly, ~$0.10)
        </span>
      </div>

      <p className="text-[12px] text-muted">
        This is the text the TTS reads. Editing it queues a fresh voiceover +
        new caption timing on the next render; scenes and character image
        stay exactly as they are.
      </p>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          {error}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        rows={14}
        className="w-full rounded-md border border-line bg-bg px-3 py-2 text-[14px] leading-relaxed text-ink outline-none focus:border-accent"
        placeholder="Once upon a time…"
      />

      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
        <span>
          {charCount} chars
          {tooShort && (
            <span className="ml-2 text-warn">· shorter than recommended (~200+)</span>
          )}
          {tooLong && (
            <span className="ml-2 text-warn">· longer than recommended (&lt;1200)</span>
          )}
        </span>
        <span>{saving ? "saving…" : "·"}</span>
      </div>
    </section>
  );
}
