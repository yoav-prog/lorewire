"use client";

// Client wrapper that hosts the 7 non-overview tabs inside the unified
// /admin/stories/[id] page (Scenes / Captions / Style / Script / Voice /
// Publish & SEO / Render). Owns the shared client state that the 5
// editing tabs mutate (the ShortConfig blob) and the foreign-session
// heartbeat. All 7 share the EditSessionBanner / RenderAfterEditsBanner
// / RenderStatusPanel chrome — Publish + Render don't mutate config but
// still benefit from seeing the in-progress render status while they
// publish or queue a re-render. The tab components themselves are
// imported verbatim from the standalone short editor — no fork, no
// behavior drift.
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

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ShortConfig } from "@/lib/short-config";
import type { ShortRenderRow } from "@/lib/short-render-queue";
import type { VoiceEntry } from "@/lib/voice-library";
import type { FacebookPostRow } from "@/lib/publish-to-facebook";
import type { InstagramPostRow } from "@/lib/publish-to-instagram";
import type { TikTokPostRow } from "@/lib/publish-to-tiktok";
import type { YouTubePostRow } from "@/lib/publish-to-youtube";
import { SHORT_EDIT_HEARTBEAT_INTERVAL_MS } from "@/lib/short-edit-session";
import { CaptionsTab } from "@/app/admin/(panel)/shorts/[id]/CaptionsTab";
import { CaptionStyleTab } from "@/app/admin/(panel)/shorts/[id]/CaptionStyleTab";
import { EditSessionBanner } from "@/app/admin/(panel)/shorts/[id]/EditSessionBanner";
import { PublishToFacebookButton } from "@/app/admin/(panel)/shorts/[id]/PublishToFacebookButton";
import { PublishToInstagramButton } from "@/app/admin/(panel)/shorts/[id]/PublishToInstagramButton";
import { PublishToTikTokButton } from "@/app/admin/(panel)/shorts/[id]/PublishToTikTokButton";
import { PublishToYouTubeButton } from "@/app/admin/(panel)/shorts/[id]/PublishToYouTubeButton";
import { RenderAfterEditsBanner } from "@/app/admin/(panel)/shorts/[id]/RenderAfterEditsBanner";
import { RenderStatusPanel } from "@/app/admin/(panel)/shorts/[id]/RenderStatusPanel";
import { ScenesTab } from "@/app/admin/(panel)/shorts/[id]/ScenesTab";
import { ScriptTab } from "@/app/admin/(panel)/shorts/[id]/ScriptTab";
import { SeoMetadataCard } from "@/app/admin/(panel)/shorts/[id]/SeoMetadataCard";
import { ShortPreviewPlayer } from "@/app/admin/(panel)/shorts/[id]/ShortPreviewPlayer";
import { UseShortAsVideoButton } from "@/app/admin/(panel)/shorts/[id]/UseShortAsVideoButton";
import { VoiceTab } from "@/app/admin/(panel)/shorts/[id]/VoiceTab";
import {
  claimShortEditSession,
  heartbeatShortEditSession,
  type LinkedArticleSummary,
  type SeoMetadataState,
} from "@/app/admin/(panel)/shorts/[id]/actions";
// ShortClientTabId + asShortClientTab live in tabs.ts (server-safe).
// Importing the value-form of either from this "use client" module
// would make them client-only, and page.tsx (a Server Component) calls
// asShortClientTab during render — which throws
// "Attempted to call X() from the server" in production (fixed
// 2026-06-25 after a tab-click 500 incident).
import type { ShortClientTabId } from "./tabs";

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
  initialFacebookPost,
  initialInstagramPost,
  initialYouTubePost,
  initialTikTokPost,
  initialSeoMetadata,
}: {
  storyId: string;
  /** One of the 7 short-client tabs. The parent only renders this
   *  component when isShortClientTab(activeTab) is true. */
  activeTab: ShortClientTabId;
  initialConfig: ShortConfig;
  initialRender: ShortRenderRow | null;
  voices: VoiceEntry[];
  /** Non-null when the server saw a foreign live edit session. While
   *  the banner is up, the heartbeat hook stays dormant — the user has
   *  to explicitly take over to start claiming the session. */
  foreignOwnerEmail: string | null;
  linkedArticles: LinkedArticleSummary[];
  /** Most recent platform-publish rows for the 4 publish buttons. Null
   *  when the story has never been published to that platform — the
   *  button just shows "no post yet" instead of state. */
  initialFacebookPost: FacebookPostRow | null;
  initialInstagramPost: InstagramPostRow | null;
  initialYouTubePost: YouTubePostRow | null;
  initialTikTokPost: TikTokPostRow | null;
  /** LLM-generated per-platform SEO metadata, or { metadata: null }
   *  when nothing has been generated yet — the SEO card surfaces a
   *  Generate button in that case. */
  initialSeoMetadata: SeoMetadataState;
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
          {activeTab === "publish" && (
            <PublishTabContent
              storyId={storyId}
              initialRender={initialRender}
              initialFacebookPost={initialFacebookPost}
              initialInstagramPost={initialInstagramPost}
              initialYouTubePost={initialYouTubePost}
              initialTikTokPost={initialTikTokPost}
              initialSeoMetadata={initialSeoMetadata}
            />
          )}
          {activeTab === "render" && (
            <RenderTabContent
              storyId={storyId}
              initialRender={initialRender}
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

// Publish & SEO tab content. Stacked vertically: SEO card first (so the
// LLM-generated metadata is visible BEFORE the user clicks publish),
// then the 4 platform buttons in stable order. All 4 buttons share the
// same gate: a done short render with an output_url. The buttons own
// their own per-platform UX (inline confirm panel, caption override,
// status under the button) — this container just stacks them.
function PublishTabContent({
  storyId,
  initialRender,
  initialFacebookPost,
  initialInstagramPost,
  initialYouTubePost,
  initialTikTokPost,
  initialSeoMetadata,
}: {
  storyId: string;
  initialRender: ShortRenderRow | null;
  initialFacebookPost: FacebookPostRow | null;
  initialInstagramPost: InstagramPostRow | null;
  initialYouTubePost: YouTubePostRow | null;
  initialTikTokPost: TikTokPostRow | null;
  initialSeoMetadata: SeoMetadataState;
}) {
  const publishDisabled =
    initialRender === null ||
    initialRender.status !== "done" ||
    !initialRender.output_url;
  return (
    <div className="space-y-3">
      <SeoMetadataCard storyId={storyId} initial={initialSeoMetadata} />
      <PublishToFacebookButton
        storyId={storyId}
        disabled={publishDisabled}
        initialPost={initialFacebookPost}
      />
      <PublishToInstagramButton
        storyId={storyId}
        disabled={publishDisabled}
        initialPost={initialInstagramPost}
      />
      <PublishToYouTubeButton
        storyId={storyId}
        disabled={publishDisabled}
        initialPost={initialYouTubePost}
      />
      <PublishToTikTokButton
        storyId={storyId}
        disabled={publishDisabled}
        initialPost={initialTikTokPost}
      />
    </div>
  );
}

// Render tab content. The live render status + render-after-edits
// trigger already render above the tab content (shared chrome across
// every short-client tab), so this tab focuses on the two render-level
// actions that don't fit naturally elsewhere:
//   1. "Use this short as the story's video" — copies the short's
//      output_url onto stories.video_url so the public reader plays the
//      short by default.
//   2. The 16:9 long-form editor escape hatch — for the retired
//      long-form pipeline. Lives here per the plan; no other admin
//      surface links to it.
function RenderTabContent({
  storyId,
  initialRender,
}: {
  storyId: string;
  initialRender: ShortRenderRow | null;
}) {
  const useDisabled =
    initialRender === null ||
    initialRender.status !== "done" ||
    !initialRender.output_url;
  return (
    <div className="space-y-3">
      <UseShortAsVideoButton storyId={storyId} disabled={useDisabled} />
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          Legacy long-form editor
        </div>
        <p className="mb-3 text-[12px] text-muted">
          For the retired 16:9 long-form pipeline. New stories should not
          need this — the unified editor handles every step a short needs.
        </p>
        <Link
          href={`/admin/videos/${storyId}`}
          onClick={() => {
            // eslint-disable-next-line no-console -- rule 14 (observability)
            console.info("[unified editor escape hatch]", {
              storyId,
              currentTab: "render",
            });
          }}
          className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
        >
          Open 16:9 long-form editor →
        </Link>
      </div>
    </div>
  );
}
