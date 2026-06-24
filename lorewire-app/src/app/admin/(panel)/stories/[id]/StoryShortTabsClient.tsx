"use client";

// Client wrapper that hosts the 5 ShortConfig-driven tabs (Scenes /
// Captions / Style / Script / Voice) inside the unified
// /admin/stories/[id] page. Owns the shared client state that all 5 tabs
// mutate (the ShortConfig blob) and the foreign-session heartbeat. The
// tab components themselves are imported verbatim from the standalone
// short editor — no fork, no behavior drift.
//
// The active tab is URL-driven (?tab=…), resolved on the server, and
// passed in via props. Tab switching happens at the page level via
// StoryTabBar — this component just renders the active short-tab.
//
// Cut 4 will 308-redirect the standalone /admin/shorts/[id] into the
// unified page; until then, both surfaces work and share the same
// underlying state.
//
// Plan: _plans/2026-06-24-unified-story-editor.md.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ShortConfig } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import type { VoiceEntry } from "@/lib/voice-library";
import { SHORT_EDIT_HEARTBEAT_INTERVAL_MS } from "@/lib/short-edit-session";
import { CaptionsTab } from "@/app/admin/(panel)/shorts/[id]/CaptionsTab";
import { CaptionStyleTab } from "@/app/admin/(panel)/shorts/[id]/CaptionStyleTab";
import { EditSessionBanner } from "@/app/admin/(panel)/shorts/[id]/EditSessionBanner";
import { RenderAfterEditsBanner } from "@/app/admin/(panel)/shorts/[id]/RenderAfterEditsBanner";
import { RenderStatusPanel } from "@/app/admin/(panel)/shorts/[id]/RenderStatusPanel";
import { ScenesTab } from "@/app/admin/(panel)/shorts/[id]/ScenesTab";
import { ScriptTab } from "@/app/admin/(panel)/shorts/[id]/ScriptTab";
import { ShortPreviewPlayer } from "@/app/admin/(panel)/shorts/[id]/ShortPreviewPlayer";
import { VoiceTab } from "@/app/admin/(panel)/shorts/[id]/VoiceTab";
import {
  claimShortEditSession,
  heartbeatShortEditSession,
  type LinkedArticleSummary,
} from "@/app/admin/(panel)/shorts/[id]/actions";
import type { StoryTabId } from "./tabs";

// The five tabs this wrapper renders. Narrower than StoryTabId so the
// switch below is exhaustive in TypeScript.
type ShortConfigTabId =
  | "scenes"
  | "captions"
  | "style"
  | "script"
  | "voice";

// A stable digest the render-after-edits banner re-polls on. Includes
// every field the render plan diffs against so any edit triggers a fresh
// plan fetch. Mirrors the digest in the standalone ShortEditorClient —
// keep in sync if either side adds a field.
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

export function StoryShortTabsClient({
  storyId,
  activeTab,
  initialConfig,
  initialRender,
  voices,
  foreignOwnerEmail,
  linkedArticles,
}: {
  storyId: string;
  /** One of the 5 ShortConfig-driven tabs. The parent only renders this
   *  component when isShortConfigTab(activeTab) is true. */
  activeTab: ShortConfigTabId;
  initialConfig: ShortConfig;
  initialRender: ShortRenderRow | null;
  voices: VoiceEntry[];
  /** Non-null when the server saw a foreign live edit session. While
   *  the banner is up, the heartbeat hook stays dormant — the user has
   *  to explicitly take over to start claiming the session. */
  foreignOwnerEmail: string | null;
  linkedArticles: LinkedArticleSummary[];
}) {
  const router = useRouter();
  const [config, setConfig] = useState<ShortConfig>(initialConfig);
  const configKey = useMemo(() => buildConfigKey(config), [config]);
  // Seeded from initialRender so a page-cold-start still shows whatever
  // was last in-flight; updates when RenderAfterEditsBanner queues a new
  // render so RenderStatusPanel can poll the just-queued id.
  const [activeRenderId, setActiveRenderId] = useState<string | null>(
    initialRender?.id ?? null,
  );

  // Caption template from the LAST done render's props. Used as the floor
  // for the editor preview's caption style so a settings-level color /
  // position / weight override (baked into every fresh render's
  // caption_template by the Python pipeline) shows up in the preview too.
  const baselineCaptionTemplate = useMemo<Record<string, unknown> | null>(() => {
    const raw = initialRender?.props;
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const t = (parsed as Record<string, unknown>).caption_template;
      return t && typeof t === "object" && !Array.isArray(t)
        ? (t as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [initialRender?.props]);

  // Heartbeat hook. We hold the session only while the banner is NOT up;
  // a foreign session means the take-over UI is the explicit gate to
  // start claiming.
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (foreignOwnerEmail) return;

    let cancelled = false;
    const stamp = async () => {
      try {
        const result = await heartbeatShortEditSession(storyId);
        if (!cancelled && !result.ok && result.error === "session-stolen") {
          // eslint-disable-next-line no-console -- rule 14
          console.info("[unified editor session lost]", { storyId });
          router.refresh();
        }
      } catch {
        /* transient — try again next tick */
      }
    };

    claimShortEditSession(storyId).catch(() => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[unified editor session claim failed]", { storyId });
    });
    heartbeatRef.current = setInterval(stamp, SHORT_EDIT_HEARTBEAT_INTERVAL_MS);

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

      <RenderAfterEditsBanner
        storyId={storyId}
        configKey={configKey}
        onRenderQueued={setActiveRenderId}
      />

      <RenderStatusPanel
        activeRenderId={activeRenderId}
        initialRender={initialRender}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-3">
          {activeTab === "scenes" && (
            <ScenesTab
              storyId={storyId}
              config={config}
              onConfigChange={setConfig}
              initialRender={initialRender}
              linkedArticles={linkedArticles}
            />
          )}
          {activeTab === "captions" && (
            <CaptionsTab
              storyId={storyId}
              config={config}
              onConfigChange={setConfig}
            />
          )}
          {activeTab === "style" && (
            <CaptionStyleTab
              storyId={storyId}
              config={config}
              onConfigChange={setConfig}
            />
          )}
          {activeTab === "script" && (
            <ScriptTab
              storyId={storyId}
              config={config}
              onConfigChange={setConfig}
            />
          )}
          {activeTab === "voice" && (
            <VoiceTab
              storyId={storyId}
              config={config}
              voices={voices}
              onConfigChange={setConfig}
            />
          )}
        </div>

        <aside className="min-w-0">
          <ShortPreviewPlayer
            config={config}
            baselineCaptionTemplate={baselineCaptionTemplate}
          />
        </aside>
      </div>
    </div>
  );
}

/** Narrowing helper for callers that only have a StoryTabId. Lets the
 *  parent gate on isShortConfigTab() and then safely cast to the narrow
 *  ShortConfigTabId without an `as`. */
export function asShortConfigTab(tab: StoryTabId): ShortConfigTabId | null {
  switch (tab) {
    case "scenes":
    case "captions":
    case "style":
    case "script":
    case "voice":
      return tab;
    default:
      return null;
  }
}
