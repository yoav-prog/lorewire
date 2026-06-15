"use client";

// Client-side shell for the short editor. Owns the tab bar + the active tab
// content. Phase 1 ships ONE tab (Scenes); the others are placeholders so
// the user can see where the surface is going and we can wire them up in
// follow-up PRs without restructuring this file.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useState } from "react";
import type { ShortConfig } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import { ScenesTab } from "./ScenesTab";

type TabId = "scenes" | "script" | "captions" | "voice" | "render";

const TABS: Array<{
  id: TabId;
  label: string;
  available: boolean;
  hint?: string;
}> = [
  { id: "scenes", label: "Scenes", available: true },
  { id: "script", label: "Script", available: false, hint: "Phase 3" },
  { id: "captions", label: "Captions", available: false, hint: "Phase 2" },
  { id: "voice", label: "Voice", available: false, hint: "Phase 3" },
  { id: "render", label: "Render", available: false, hint: "Phase 4" },
];

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

  return (
    <div className="space-y-3">
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
                  : `Not in Phase 1 — ${t.hint ?? "later"}`
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
    </div>
  );
}
