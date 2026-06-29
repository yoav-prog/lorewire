// Short editor.
//
// Server Component shell: auth, story lookup, short_config seed (via the
// action's loadShortEditorState), voice catalog load for the Voice tab,
// then hand off to the client component that owns the tabs + interactivity.
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "@/lib/dal";
import { getStory, getUserById, listSegments } from "@/lib/repo";
import { listVoices } from "@/lib/voice-library";
import { readForeignSession } from "@/lib/short-edit-session";
import { resolveShortSegments } from "@/lib/short-segments";
import {
  LEGACY_DEFAULT_ASPECT,
  isVideoAspect,
  type VideoAspect,
} from "@/lib/aspect";
import {
  getLatestFacebookPostForStoryAction,
  getLatestInstagramPostForStoryAction,
  getLatestTikTokPostForStoryAction,
  getLatestYouTubePostForStoryAction,
  getSeoMetadataForStoryAction,
  listArticlesLinkedToStoryAction,
  loadShortEditorState,
} from "./actions";
import { ShortEditorClient } from "./ShortEditorClient";
import { ShortSegmentsStatusCard } from "./ShortSegmentsStatusCard";
import { StoryTitleHeader } from "./StoryTitleHeader";

export default async function ShortEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("content.manage");
  const { id } = await params;
  const story = await getStory(id);
  if (!story) notFound();

  // Voices: the catalog is per-process-memoized in listVoices() so this
  // costs ~1 ms after the first page load of the admin shell.
  // Linked articles: feed the per-scene "Use in article" promote actions
  // in ScenesTab. Empty list when no article points at this story.
  const [
    state,
    voices,
    articlesResult,
    latestFacebookPost,
    latestInstagramPost,
    latestYouTubePost,
    latestTikTokPost,
  ] = await Promise.all([
    loadShortEditorState(id),
    listVoices().catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] listVoices failed", { err: String(err) });
      return [];
    }),
    listArticlesLinkedToStoryAction(id).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] linked articles failed", {
        err: String(err),
      });
      return { ok: false, articles: [] } as const;
    }),
    // Latest facebook_posts row for the manual Publish-to-Facebook button.
    // Best-effort: a lookup failure should not block the editor from
    // rendering — the button just shows "no post yet" instead of state.
    getLatestFacebookPostForStoryAction(id).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] latest facebook post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    // Same shape for the Instagram button.
    getLatestInstagramPostForStoryAction(id).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] latest instagram post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    // YouTube button.
    getLatestYouTubePostForStoryAction(id).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] latest youtube post lookup failed", {
        err: String(err),
      });
      return null;
    }),
    // TikTok button.
    getLatestTikTokPostForStoryAction(id).catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] latest tiktok post lookup failed", {
        err: String(err),
      });
      return null;
    }),
  ]);

  // SEO metadata for the SEO card on the editor. Best-effort: a
  // lookup failure should not block the editor — the card just shows
  // "Not generated yet" and exposes the Generate button.
  const initialSeoMetadata = await getSeoMetadataForStoryAction(id).catch(
    (err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] seo metadata lookup failed", {
        err: String(err),
      });
      return { metadata: null, generatedAt: null };
    },
  );
  const linkedArticles = articlesResult.ok
    ? (articlesResult.articles ?? [])
    : [];

  // Mirror the render path's segment resolution so the editor surfaces
  // exactly which 9:16 intro/outro will splice on the next Cloud Run
  // render (and why if either is being skipped). Walks the short
  // resolver chain (short_config override -> story columns -> global
  // active) so the card reflects ground truth.
  const segmentsResolved = state.ok
    ? await resolveShortSegments(state.config ?? null, story).catch((err) => {
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[short editor page] resolveShortSegments failed", {
          err: String(err),
        });
        return null;
      })
    : null;

  // 9:16 segment library for the override picker. Filter to enabled +
  // ready 9:16 rows so a disabled or non-9:16 segment can't be picked
  // (the resolver would just drop it anyway). Slim projection so the
  // client bundle doesn't ship the source_url + uploaded_at noise.
  const [introLibrary, outroLibrary] = await Promise.all([
    state.ok ? listSegments("intro") : Promise.resolve([]),
    state.ok ? listSegments("outro") : Promise.resolve([]),
  ]);
  function only916Enabled(rows: typeof introLibrary) {
    return rows
      .filter((r) => {
        const aspect: VideoAspect = isVideoAspect(r.aspect)
          ? r.aspect
          : LEGACY_DEFAULT_ASPECT;
        return (
          aspect === "9:16" && r.enabled !== 0 && r.status === "ready"
        );
      })
      .map((r) => ({ id: r.id, label: r.label ?? r.id.slice(0, 8) }));
  }
  const segmentPickerOptions = state.ok
    ? {
        intro: only916Enabled(introLibrary),
        outro: only916Enabled(outroLibrary),
      }
    : { intro: [], outro: [] };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            <Link
              href={`/admin/videos/${id}`}
              className="hover:text-accent hover:underline"
            >
              ← Story
            </Link>
            <span>·</span>
            <span>Short editor</span>
          </div>
          <div className="mt-1">
            <StoryTitleHeader storyId={id} initialTitle={story.title ?? null} />
          </div>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Scenes · Captions · Script · Voice
        </div>
      </header>

      {state.ok && segmentsResolved && (
        <ShortSegmentsStatusCard
          storyId={id}
          intro={{
            label: segmentsResolved.intro.segment?.label ?? null,
            reason: segmentsResolved.intro.reason,
            source: segmentsResolved.intro.source,
          }}
          outro={{
            label: segmentsResolved.outro.segment?.label ?? null,
            reason: segmentsResolved.outro.reason,
            source: segmentsResolved.outro.source,
          }}
          override={{
            intro_segment_id: state.config?.intro_segment_id ?? null,
            outro_segment_id: state.config?.outro_segment_id ?? null,
            skip_intro: state.config?.skip_intro ?? false,
            skip_outro: state.config?.skip_outro ?? false,
          }}
          pickerOptions={segmentPickerOptions}
        />
      )}

      {!state.ok ? (
        <NoShortYet error={state.error ?? "unknown"} storyId={id} />
      ) : (
        <ShortEditorClient
          storyId={id}
          initialConfig={state.config!}
          initialRender={state.latestRender ?? null}
          voices={voices}
          foreignOwnerEmail={await resolveForeignOwnerEmail(
            state.config!,
            session.userId,
          )}
          linkedArticles={linkedArticles}
          initialFacebookPost={latestFacebookPost}
          initialInstagramPost={latestInstagramPost}
          initialYouTubePost={latestYouTubePost}
          initialTikTokPost={latestTikTokPost}
          initialSeoMetadata={initialSeoMetadata}
        />
      )}
    </div>
  );
}

// Phase 5: read the persisted edit-session and look up the foreign owner's
// email when it's still fresh. Returns null when the current user owns the
// session OR the session is stale OR no session was ever claimed — all of
// which mean "no banner."
async function resolveForeignOwnerEmail(
  config: import("@/lib/short-config").ShortConfig,
  currentUserId: string,
): Promise<string | null> {
  const read = readForeignSession(config, currentUserId);
  if (!read.isForeign || !read.foreignUserId) return null;
  const otherUser = await getUserById(read.foreignUserId);
  return otherUser?.email ?? read.foreignUserId;
}

function NoShortYet({ error, storyId }: { error: string; storyId: string }) {
  // The most common reason the editor lands cold is "you haven't generated
  // a short for this story yet." Send the admin to the video editor where
  // the Generate Short button lives — Phase 2's plan moves that button up
  // into this surface, but for Phase 1 we link out.
  if (error === "no-short-yet" || error === "short_renders-props-empty") {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-ink">
          No short exists for this story yet.
        </p>
        <p className="mt-1 text-[12px] text-muted">
          Generate one from the story editor, then come back here to fine-tune
          individual scenes.
        </p>
        <Link
          href={`/admin/videos/${storyId}`}
          className="mt-3 inline-block rounded-md border border-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent hover:bg-accent/10"
        >
          Open video editor
        </Link>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-warn bg-warn/10 p-4 text-[12px] text-warn"
    >
      Could not load the short editor: {error}
    </div>
  );
}
