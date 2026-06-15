"use client";

// Client-side shell for the short editor. Owns the tab bar + the active tab
// content + the always-on Render After Edits banner + (Phase 5) the
// concurrency banner and the heartbeat hook.
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ShortConfig } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import type { VoiceEntry } from "@/lib/voice-library";
import { SHORT_EDIT_HEARTBEAT_INTERVAL_MS } from "@/lib/short-edit-session";
import { CaptionsTab } from "./CaptionsTab";
import { CaptionStyleTab } from "./CaptionStyleTab";
import { EditSessionBanner } from "./EditSessionBanner";
import { RenderAfterEditsBanner } from "./RenderAfterEditsBanner";
import { ScenesTab } from "./ScenesTab";
import { ScriptTab } from "./ScriptTab";
import { UseShortAsVideoButton } from "./UseShortAsVideoButton";
import { ShortPreviewPlayer } from "./ShortPreviewPlayer";
import { VoiceTab } from "./VoiceTab";
import type { LinkedArticleSummary } from "./actions";
import {
  claimShortEditSession,
  heartbeatShortEditSession,
} from "./actions";

type TabId = "scenes" | "script" | "captions" | "style" | "voice";

const TABS: Array<{
  id: TabId;
  label: string;
  available: boolean;
  hint?: string;
}> = [
  { id: "scenes", label: "Scenes", available: true },
  { id: "captions", label: "Captions", available: true },
  { id: "style", label: "Style", available: true },
  { id: "script", label: "Script", available: true },
  { id: "voice", label: "Voice", available: true },
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
  voices,
  foreignOwnerEmail,
  linkedArticles,
}: {
  storyId: string;
  initialConfig: ShortConfig;
  initialRender: ShortRenderRow | null;
  voices: VoiceEntry[];
  /** Set when the server render detected a foreign live session. The banner
   *  renders only when this is non-null; the heartbeat hook stays dormant
   *  until the take-over button is clicked (which calls router.refresh()
   *  and we land cold again with foreignOwnerEmail=null). Phase 5. */
  foreignOwnerEmail: string | null;
  /** Articles whose `articles.story_id` matches this short's story. Drives
   *  the per-scene "Use in article" picker in ScenesTab. Empty list when
   *  no article is linked yet — Scenes tab surfaces a friendly hint. */
  linkedArticles: LinkedArticleSummary[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("scenes");
  const [config, setConfig] = useState<ShortConfig>(initialConfig);
  const configKey = useMemo(() => buildConfigKey(config), [config]);

  // Heartbeat hook. We hold the session only while the banner is NOT up;
  // a foreign session means the take-over UI is the explicit gate to
  // start claiming.
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (foreignOwnerEmail) return; // banner is up; don't claim

    let cancelled = false;
    const stamp = async () => {
      try {
        const result = await heartbeatShortEditSession(storyId);
        if (!cancelled && !result.ok && result.error === "session-stolen") {
          // Someone took over between heartbeats. Refresh so the page
          // re-classifies + the banner pops up. Don't keep firing
          // heartbeats over the new owner.
          // eslint-disable-next-line no-console -- rule 14
          console.info("[short editor session lost]", { storyId });
          router.refresh();
        }
      } catch {
        /* transient — try again next tick */
      }
    };

    // Initial claim. Best-effort; the periodic heartbeat retries if this
    // misses.
    claimShortEditSession(storyId).catch(() => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor session claim failed]", { storyId });
    });
    heartbeatRef.current = setInterval(
      stamp,
      SHORT_EDIT_HEARTBEAT_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [storyId, foreignOwnerEmail, router]);

  return (
    <div className="space-y-3">
      <EditSessionBanner
        storyId={storyId}
        foreignOwnerEmail={foreignOwnerEmail}
      />

      <RenderAfterEditsBanner storyId={storyId} configKey={configKey} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-3">
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
          linkedArticles={linkedArticles}
        />
      )}
      {tab === "captions" && (
        <CaptionsTab
          storyId={storyId}
          config={config}
          onConfigChange={setConfig}
        />
      )}
      {tab === "style" && (
        <CaptionStyleTab
          storyId={storyId}
          config={config}
          onConfigChange={setConfig}
        />
      )}
      {tab === "script" && (
        <ScriptTab
          storyId={storyId}
          config={config}
          onConfigChange={setConfig}
        />
      )}
      {tab === "voice" && (
        <VoiceTab
          storyId={storyId}
          config={config}
          voices={voices}
          onConfigChange={setConfig}
        />
      )}

          <UseShortAsVideoButton
            storyId={storyId}
            disabled={
              initialRender === null ||
              initialRender.status !== "done" ||
              !initialRender.output_url
            }
          />
        </div>

        <aside className="min-w-0">
          <ShortPreviewPlayer config={config} />
        </aside>
      </div>
    </div>
  );
}
