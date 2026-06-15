"use client";

// Captions tab — Phase 2 of the short editor.
//
// List of caption chunks with inline text + timing editors. Each chunk
// addresses through `captions.<idx>.<field>` patches that
// applyShortConfigPatch handles. Autosaves on a 1.5 s debounce, same as
// the Scenes tab.
//
// The "Render after edits" surface is mounted by ShortEditorClient as a
// sticky banner above the tabs so it's reachable from every tab — see
// RenderAfterEditsBanner.tsx.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ShortCaptionChunk, ShortConfig } from "@/lib/short-config";
import { saveShortConfigPatch } from "./actions";

const SAVE_DEBOUNCE_MS = 1500;

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.max(0, ms - totalSeconds * 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(
    Math.floor(millis / 10),
  ).padStart(2, "0")}`;
}

interface Draft {
  text: string;
  startMs: string;
  endMs: string;
}

function chunkToDraft(c: ShortCaptionChunk): Draft {
  return {
    text: c.text,
    startMs: String(c.start_ms),
    endMs: String(c.end_ms),
  };
}

export function CaptionsTab({
  storyId,
  config,
  onConfigChange,
}: {
  storyId: string;
  config: ShortConfig;
  onConfigChange: (next: ShortConfig) => void;
}) {
  const router = useRouter();
  const captions = config.captions;
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    captions.map(chunkToDraft),
  );
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const saveTimers = useRef<Array<ReturnType<typeof setTimeout> | null>>([]);

  // Re-sync drafts when the parent config changes (e.g. after a Lane A
  // render swaps in fresh captions, or another tab edits something).
  const configCaptionsKey = captions
    .map((c) => `${c.start_ms}-${c.end_ms}-${c.text}`)
    .join("|");
  useEffect(() => {
    setDrafts(captions.map(chunkToDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configCaptionsKey]);

  useEffect(() => {
    return () => {
      for (const t of saveTimers.current) if (t) clearTimeout(t);
    };
  }, []);

  function scheduleSave(idx: number, patch: Record<string, unknown>) {
    const existing = saveTimers.current[idx];
    if (existing) clearTimeout(existing);
    saveTimers.current[idx] = setTimeout(() => {
      setSavingIdx(idx);
      startTransition(async () => {
        const result = await saveShortConfigPatch(storyId, patch);
        if (!result.ok) {
          setError(result.error ?? "save failed");
        } else if (result.config) {
          onConfigChange(result.config);
        }
        setSavingIdx(null);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  function onTextChange(idx: number, value: string) {
    setDrafts((d) => {
      const next = [...d];
      next[idx] = { ...next[idx], text: value };
      return next;
    });
    scheduleSave(idx, { [`captions.${idx}.text`]: value });
  }

  function onTimingChange(idx: number, field: "startMs" | "endMs", value: string) {
    setDrafts((d) => {
      const next = [...d];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const colKey = field === "startMs" ? "start_ms" : "end_ms";
    scheduleSave(idx, { [`captions.${idx}.${colKey}`]: parsed });
  }

  if (captions.length === 0) {
    return (
      <section className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-ink">
          This short has no captions yet.
        </p>
        <p className="mt-1 text-[12px] text-muted">
          Captions are generated as part of the voiceover synthesis — once
          the next render completes they will appear here for fine-tuning.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Captions ({captions.length})
        </h2>
        <span className="font-mono text-[10px] text-muted">
          Edits trigger an assembly-only re-render (Lane A, ~$0.05)
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-warn bg-warn/10 px-3 py-2 text-[12px] text-warn"
        >
          {error}
        </div>
      )}

      <ol className="space-y-2">
        {captions.map((c, idx) => {
          const d = drafts[idx] ?? chunkToDraft(c);
          const isSaving = savingIdx === idx;
          const startInvalid =
            !Number.isFinite(Number(d.startMs)) || Number(d.startMs) < 0;
          const endInvalid =
            !Number.isFinite(Number(d.endMs)) || Number(d.endMs) < Number(d.startMs);
          return (
            <li
              key={idx}
              className="space-y-2 rounded-md border border-line bg-surface p-3"
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted">
                <span>
                  Chunk {idx + 1} · {formatTime(c.start_ms)} → {formatTime(c.end_ms)}
                </span>
                <span>{isSaving ? "saving…" : "·"}</span>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_120px]">
                <input
                  value={d.text}
                  onChange={(e) => onTextChange(idx, e.target.value)}
                  placeholder="Caption text"
                  className="rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
                />
                <label className="block">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted">
                    start ms
                  </span>
                  <input
                    type="number"
                    value={d.startMs}
                    onChange={(e) => onTimingChange(idx, "startMs", e.target.value)}
                    min={0}
                    className={`mt-0.5 w-full rounded-md border bg-bg px-2 py-1 text-[12px] font-mono text-ink outline-none ${
                      startInvalid ? "border-warn" : "border-line focus:border-accent"
                    }`}
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-muted">
                    end ms
                  </span>
                  <input
                    type="number"
                    value={d.endMs}
                    onChange={(e) => onTimingChange(idx, "endMs", e.target.value)}
                    min={Number(d.startMs)}
                    className={`mt-0.5 w-full rounded-md border bg-bg px-2 py-1 text-[12px] font-mono text-ink outline-none ${
                      endInvalid ? "border-warn" : "border-line focus:border-accent"
                    }`}
                  />
                </label>
              </div>

              {(startInvalid || endInvalid) && (
                <p className="font-mono text-[10px] text-warn">
                  Timing won&apos;t save until both values are non-negative and end ≥ start.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
