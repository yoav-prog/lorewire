"use client";

// Client-side shell for the short editor. Owns the tab bar + the active tab
// content + the always-on Render After Edits banner. Phase 1 lit up Scenes;
// Phase 2 adds Captions + the Lane A render path.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useMemo, useState } from "react";
import type { ShortConfig } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import { CaptionsTab } from "./CaptionsTab";
import { RenderAfterEditsBanner } from "./RenderAfterEditsBanner";
import { ScenesTab } from "./ScenesTab";

type TabId = "scenes" | "script" | "captions" | "voice" | "render";

const TABS: Array<{
  id: TabId;
  label: string;
  available: boolean;
  hint?: string;
}> = [
  { id: "scenes", label: "Scenes", available: true },
  { id: "captions", label: "Captions", available: true },
  { id: "script", label: "Script", available: false, hint: "Phase 3" },
  { id: "voice", label: "Voice", available: false, hint: "Phase 3" },
  { id: "render", label: "Render", available: false, hint: "Phase 4" },
];

// A stable digest the banner can re-poll on. We deliberately include all the
// fields the render plan diffs against (captions + frame urls + prompts +
// script + voice + voiceover_url) so any edit triggers a fresh plan fetch.
function buildConfigKey(c: ShortConfig): string {
  const frames = c.doodle_frames
    .map((f) => `${f.id}:${f.url}:${f.image_prompt ?? ""}`)
    .join("|");
  const caps = c.captions
    .map((cap) => `${cap.start_ms}-${cap.end_ms}-${cap.text}`)
    .join("|");
  const voice = c.voice ? `${c.voice.provider}:${c.voice.voice_id}` : "";
  return `${frames}#${caps}#${c.script ?? ""}#${voice}#${c.voiceover_url ?? ""}`;
}

export function ShortEditorClient({
  storyId,
  initialConfig,
  initialRender,
}: {
  storyId: string;
  initialConfig: ShortConfig;
  initialRender: ShortRenderRow | null;
}) {
  const [tab, setTab] = useState<TabId>("scenes");
  const [config, setConfig] = useState<ShortConfig>(initialConfig);
  const configKey = useMemo(() => buildConfigKey(config), [config]);

  return (
    <div className="space-y-3">
      <RenderAfterEditsBanner storyId={storyId} configKey={configKey} />

      <nav
        role="tablist"
        aria-label="Short editor tabs"
        className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1"
      >
        {TABS.map((t) => {
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              type="button"
              disabled={!t.available}
              onClick={() => t.available && setTab(t.id)}
              title={
                t.available
                  ? undefined
                  : `Not available yet — ${t.hint ?? "later"}`
              }
              className={
                isActive
                  ? "rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-bg"
                  : t.available
                    ? "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:bg-accent/10"
                    : "rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted opacity-50"
              }
            >
              {t.label}
              {!t.available && t.hint && (
                <span className="ml-1 text-[9px] text-muted">{t.hint}</span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "scenes" && (
        <ScenesTab
          storyId={storyId}
          config={config}
          onConfigChange={setConfig}
          initialRender={initialRender}
        />
      )}
      {tab === "captions" && (
        <CaptionsTab
          storyId={storyId}
          config={config}
          onConfigChange={setConfig}
        />
      )}
    </div>
  );
}
