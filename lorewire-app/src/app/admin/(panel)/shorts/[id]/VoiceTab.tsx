"use client";

// Voice tab — Phase 3 of the short editor.
//
// Slim picker bound to ShortConfig.voice (an override on the global
// stories.voice_provider chain, scoped to this short). NOT a port of
// components/voice-picker/VoicePicker.tsx — that one writes to the
// stories columns; we write to the short_config column via
// saveShortConfigPatch. Same VoiceEntry source data, narrower UI.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useMemo, useState, useTransition } from "react";
import type { VoiceEntry } from "@/lib/voice-library";
import type { ShortConfig, ShortVoiceOverride } from "@/lib/short-config";
import { saveShortConfigPatch } from "./actions";

export function VoiceTab({
  storyId,
  config,
  voices,
  onConfigChange,
}: {
  storyId: string;
  config: ShortConfig;
  voices: VoiceEntry[];
  onConfigChange: (next: ShortConfig) => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const current = config.voice ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return voices;
    return voices.filter((v) => {
      const haystack =
        `${v.name} ${v.provider} ${v.language} ${v.accent ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [voices, query]);

  function pick(voice: ShortVoiceOverride | null) {
    setError(null);
    setPendingId(voice ? voice.voice_id : "__clear__");
    startTransition(async () => {
      const result = await saveShortConfigPatch(storyId, {
        voice,
      });
      if (!result.ok) {
        setError(result.error ?? "save failed");
      } else if (result.config) {
        onConfigChange(result.config);
      }
      setPendingId(null);
    });
  }

  function isSelected(v: VoiceEntry): boolean {
    return (
      current !== null &&
      current.provider === v.provider &&
      current.voice_id === v.voice_id
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Voice override
        </h2>
        <span className="font-mono text-[10px] text-muted">
          Editing triggers Lane B (voice + assembly, ~$0.10)
        </span>
      </div>

      <p className="text-[12px] text-muted">
        Pick a voice for this short. When unset (highlighted below) the
        renderer falls back to the story&apos;s voice override or the global
        default.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => pick(null)}
          disabled={pendingId !== null || current === null}
          className={
            current === null
              ? "rounded-md border border-accent bg-accent/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent"
              : "rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-accent hover:text-accent disabled:cursor-wait disabled:opacity-60"
          }
        >
          {current === null ? "Using story default" : "Reset to default"}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name / provider / language…"
          className="flex-1 rounded-md border border-line bg-bg px-3 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-muted">
          {voices.length === 0
            ? "No voices in the library yet."
            : "No voices match the search."}
        </p>
      ) : (
        <ul className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((v) => {
            const selected = isSelected(v);
            const pending = pendingId === v.voice_id;
            return (
              <li key={`${v.provider}:${v.voice_id}`}>
                <button
                  type="button"
                  onClick={() =>
                    pick({ provider: v.provider, voice_id: v.voice_id })
                  }
                  disabled={pendingId !== null}
                  className={
                    selected
                      ? "flex w-full items-center justify-between gap-3 rounded-md border border-accent bg-accent/10 px-3 py-2 text-left text-[13px] text-ink"
                      : "flex w-full items-center justify-between gap-3 rounded-md border border-line bg-bg px-3 py-2 text-left text-[13px] text-ink hover:border-accent hover:bg-surface disabled:cursor-wait disabled:opacity-60"
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-ink">{v.name}</div>
                    <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted">
                      {v.provider} · {v.language}
                      {v.accent && ` · ${v.accent}`}
                    </div>
                  </div>
                  {pending && (
                    <span className="font-mono text-[10px] text-muted">
                      saving…
                    </span>
                  )}
                  {!pending && selected && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
                      selected
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
