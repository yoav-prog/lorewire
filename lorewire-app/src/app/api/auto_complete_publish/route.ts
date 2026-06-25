// Vercel cron drain for the bulk complete-and-publish flag.
//
// The /admin/content "COMPLETE & PUBLISH" bulk action sets
// stories.auto_publish_when_ready=1 on every selected video story
// after enqueuing whatever assets were missing. This cron polls
// flagged stories on a 2-minute cadence: on each tick, for every
// flagged row, run evaluateAssetCompleteness; if ready, flip the
// status to 'published', run the autocurate hooks, and call every
// per-platform publisher (Facebook + Instagram Reels, Facebook +
// Instagram Stories where toggled, YouTube, TikTok) with
// trigger='auto' so the publisher's own dedup gate prevents
// double-posts. Then clear the flag.
//
// Not-ready rows: increment auto_publish_attempts. If the per-story
// cap is reached, clear the flag + log the give-up so the operator
// sees the stuck story in observability. The cap prevents a
// permanently-broken asset (an exhausted external API key, a
// silently-failing render lane) from piling up infinite cron work.
//
// Auth: CRON_SECRET Bearer, same pattern as
// auto_publish_full_pipeline + every retry_* cron in the project.
//
// Plan: _plans/2026-06-25-bulk-complete-and-publish.md.

import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { all, one, run } from "@/lib/db";
import { getStory, getSetting, setStatus, type SocialPlatform } from "@/lib/repo";
import { evaluateAssetCompleteness } from "@/lib/asset-completeness";
import { autoDraftPollForSubject } from "@/lib/poll-autodraft";
import { latestDoneShortRenderForStory } from "@/lib/short-render-queue";
import { ensureSeoMetadataForStory } from "@/lib/seo-metadata";
import { autoCurateOnPublish } from "@/lib/publish-auto-curate";
import { publishShortToFacebook } from "@/lib/publish-to-facebook";
import { publishShortToInstagram } from "@/lib/publish-to-instagram";
import { publishShortToYouTube } from "@/lib/publish-to-youtube";
import { publishShortToTikTok } from "@/lib/publish-to-tiktok";
import {
  publishShortToFacebookStory,
  SETTING_AUTO_PUBLISH as FB_STORY_SETTING_AUTO_PUBLISH,
} from "@/lib/publish-to-facebook-story";
import {
  publishShortToInstagramStory,
  SETTING_AUTO_PUBLISH as IG_STORY_SETTING_AUTO_PUBLISH,
} from "@/lib/publish-to-instagram-story";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Max flagged rows processed per cron firing. The publish loop is
 *  ~6 platform calls per story; 25 keeps a tick well under the
 *  300s maxDuration on Vercel even when one platform is slow. */
const BATCH_LIMIT = 25;

/** Default per-story retry cap before we clear the flag and log a
 *  give-up. 12 ticks × 2 minutes = 24 minutes of asset-render
 *  budget, which exceeds the typical short render. Overridable
 *  via the `auto_publish.max_attempts` setting; non-positive
 *  values disable the cap (operator override for a known-slow
 *  asset queue). */
const DEFAULT_MAX_ATTEMPTS = 12;

const SETTING_KILL_SWITCH = "auto_publish.enabled";
const SETTING_MAX_ATTEMPTS = "auto_publish.max_attempts";

const PLATFORMS: SocialPlatform[] = [
  "facebook",
  "instagram",
  "youtube",
  "tiktok",
];

// ─── Auth + logging ───────────────────────────────────────────────────────────

function namespacedLog(event: string, fields: Record<string, unknown>): void {
   
  console.info(
    `[auto-complete-publish-cron ${event}]`,
    JSON.stringify(fields),
  );
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  return header === `Bearer ${expected}`;
}

// ─── Drain ────────────────────────────────────────────────────────────────────

interface FlaggedRow {
  id: string;
  reddit_id: string | null;
  category: string | null;
}

async function serve(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    namespacedLog("auth_fail", {
      ip: req.headers.get("x-forwarded-for") ?? "unknown",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Kill switch — settings.auto_publish.enabled='0' disables the cron
  // without un-flagging stories. They sit until the switch is flipped.
  const killSwitchRaw = await getSetting(SETTING_KILL_SWITCH);
  if (killSwitchRaw === "0" || killSwitchRaw === "false") {
    namespacedLog("disabled", { reason: "kill switch" });
    return NextResponse.json({ disabled: true });
  }

  const maxAttempts = await resolveMaxAttempts();

  const flagged = await all<FlaggedRow>(
    `SELECT id, reddit_id, category
     FROM stories
     WHERE auto_publish_when_ready = 1
       AND status != 'published'
       AND status != 'archived'
     ORDER BY updated_at ASC
     LIMIT ?`,
    [BATCH_LIMIT],
  );

  namespacedLog("tick", {
    flaggedCount: flagged.length,
    cap: BATCH_LIMIT,
    max_attempts: maxAttempts,
  });

  let published = 0;
  let stillWaiting = 0;
  let gaveUp = 0;
  let errored = 0;

  for (const row of flagged) {
    try {
      let completeness = await evaluateAssetCompleteness(row.id);
      namespacedLog("gate", {
        story_id: row.id,
        ready: completeness.ready,
        missing: completeness.missing,
      });

      // Already-published shouldn't happen given the WHERE clause
      // above, but the gate's belt-and-suspenders check guards
      // against the race where setStatus was called between the
      // SELECT and the gate. Clear the flag silently.
      if (completeness.missing.includes("already_published")) {
        await clearFlag(row.id, "already_published");
        published += 1;
        continue;
      }

      // Poll-only stuck path: a video story whose initial autodraft
      // hit an LLM failure sits with polls.enabled=0 indefinitely
      // because autodraft only retries on save / publish / lazy
      // view. Retry it from here so a flagged story isn't held
      // hostage by a transient LLM blip. Idempotent: the autodraft
      // helper short-circuits when polls.enabled=1, so this is
      // cheap when the issue is something else. Only fires when
      // poll is the actual gate (re-evaluating costs ~5 small
      // queries — not free, but cheap relative to the LLM call we
      // skip on the enabled=1 path). Plan §4.
      if (completeness.missing.includes("poll")) {
        try {
          const story = await getStory(row.id);
          if (story) {
            const r = await autoDraftPollForSubject({
              kind: "story",
              storyId: row.id,
              title: story.title,
              body: story.body,
              category: story.category,
            });
            namespacedLog("poll_retry", {
              story_id: row.id,
              ok: r.ok,
              ai: r.ai,
              fallback_reason: r.fallbackReason,
            });
            if (r.ok && r.ai) {
              completeness = await evaluateAssetCompleteness(row.id);
              namespacedLog("gate_after_poll_retry", {
                story_id: row.id,
                ready: completeness.ready,
                missing: completeness.missing,
              });
            }
          }
        } catch (e) {
          namespacedLog("poll_retry_error", {
            story_id: row.id,
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (!completeness.ready) {
        const attempts = await incrementAttempts(row.id);
        if (maxAttempts > 0 && attempts >= maxAttempts) {
          await clearFlag(row.id, `max_attempts (${attempts})`);
          gaveUp += 1;
          namespacedLog("giveup", {
            story_id: row.id,
            attempts,
            last_missing: completeness.missing,
          });
        } else {
          stillWaiting += 1;
        }
        continue;
      }

      // Ready. Flip status first so even if publishing partially
      // fails the story is publicly visible.
      await setStatus(row.id, "published");
      try {
        await autoCurateOnPublish(row.id, row.category);
      } catch (e) {
        // autocurate is best-effort; never let it block the publish.
        namespacedLog("autocurate_warn", {
          story_id: row.id,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      const publishResult = await publishStoryToAllSocials(row.id);
      namespacedLog("publish", {
        story_id: row.id,
        render_id: publishResult.renderId,
        posted: publishResult.posted,
        pending: publishResult.pending,
        failed: publishResult.failed,
        skipped: publishResult.skipped,
      });

      await clearFlag(row.id, "published");
      published += 1;

      // Revalidate the surfaces that show the published story so the
      // first visitor sees fresh state. Same path set the manual
      // publish action hits.
      revalidatePath(`/admin/stories/${row.id}`);
      revalidatePath("/admin/content");
      revalidatePath("/admin");
      revalidatePath("/");
    } catch (e) {
      errored += 1;
      const message = e instanceof Error ? e.message : String(e);
      namespacedLog("error", {
        story_id: row.id,
        message: message.slice(0, 500),
      });
      // Leave the flag set so the next tick retries (subject to
      // attempts cap). The error path doesn't increment because the
      // gate phase may not have run; relying on the cap stops
      // permanently-broken stories without burning legit transients.
    }
  }

  namespacedLog("done", {
    drained: flagged.length,
    published,
    still_waiting: stillWaiting,
    gave_up: gaveUp,
    errored,
  });

  return NextResponse.json({
    drained: flagged.length,
    published,
    still_waiting: stillWaiting,
    gave_up: gaveUp,
    errored,
  });
}

// ─── Per-story publish + helpers ─────────────────────────────────────────────

interface PublishSummary {
  renderId: string | null;
  posted: string[];
  pending: string[];
  failed: Array<{ platform: string; reason: string }>;
  skipped: Array<{ platform: string; reason: string }>;
}

/** Publish one story's latest short to every social platform we
 *  target. Mirrors the per-story branch of bulkPublishToSocialsAction
 *  but with trigger='auto' so each publisher's dedup gate rejects
 *  re-publishes on flag-bounce. Cross-posts to FB/IG Stories when
 *  the toggle settings are on, same as the bulk action.
 *
 *  Returns an inline summary for the cron's structured log. */
async function publishStoryToAllSocials(
  storyId: string,
): Promise<PublishSummary> {
  const story = await getStory(storyId);
  if (!story) {
    return {
      renderId: null,
      posted: [],
      pending: [],
      failed: [],
      skipped: [{ platform: "all", reason: "story disappeared" }],
    };
  }

  const render = await latestDoneShortRenderForStory(storyId);
  if (!render || render.status !== "done" || !render.output_url) {
    return {
      renderId: null,
      posted: [],
      pending: [],
      failed: [],
      skipped: [
        { platform: "all", reason: "no completed short render at publish time" },
      ],
    };
  }

  const articleUrl = await resolveArticleUrl(storyId);

  // Best-effort SEO metadata generation — same pattern the bulk
  // action uses. A failure here just means the publishers fall
  // back to the settings-level template instead of LLM captions.
  try {
    await ensureSeoMetadataForStory({ storyId, articleUrl });
  } catch (e) {
    namespacedLog("seo_warn", {
      story_id: storyId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const context = {
    hook: null,
    title: story.title ?? null,
    article_url: articleUrl,
    category: story.category ?? null,
  };

  const posted: string[] = [];
  const pending: string[] = [];
  const failed: Array<{ platform: string; reason: string }> = [];
  const skipped: Array<{ platform: string; reason: string }> = [];

  for (const platform of PLATFORMS) {
    try {
      const result = await dispatchPublish(
        platform,
        storyId,
        render.id,
        render.output_url,
        context,
      );
      if (result.status === "posted") {
        posted.push(platform);
        // Cross-post to FB/IG Stories on a successful Reel publish,
        // same as the bulk action. Fire-and-forget; errors never
        // block the main publish path or surface in the response.
        if (platform === "facebook" || platform === "instagram") {
          void crossPostStoryIfEnabled(
            platform,
            storyId,
            render.id,
            render.output_url,
          );
        }
      } else if (result.status === "pending") {
        pending.push(platform);
        if (platform === "instagram") {
          // IG Reel pending = container queued; Story has its own
          // independent flow so it can fire now.
          void crossPostStoryIfEnabled(
            platform,
            storyId,
            render.id,
            render.output_url,
          );
        }
      } else if (result.status === "failed") {
        failed.push({
          platform,
          reason: result.row.error_message ?? "unknown publisher error",
        });
      } else {
        skipped.push({ platform, reason: result.reason });
      }
    } catch (e) {
      failed.push({
        platform,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { renderId: render.id, posted, pending, failed, skipped };
}

/** Per-platform adapter dispatch. Kept inline here (rather than
 *  shared with the bulk action) because exporting it from actions.ts
 *  would expose a server action surface the client could invoke;
 *  the duplication is one short switch. The bulk action's manual
 *  trigger and the cron's auto trigger have different dedup
 *  semantics by design, so even shared code would branch on it. */
async function dispatchPublish(
  platform: SocialPlatform,
  storyId: string,
  renderId: string,
  videoUrl: string,
  context: {
    hook: string | null;
    title: string | null;
    article_url: string;
    category: string | null;
  },
) {
  if (platform === "facebook") {
    return publishShortToFacebook({
      storyId,
      renderId,
      videoUrl,
      trigger: "auto",
      context: {
        hook: context.hook,
        title: context.title,
        article_url: context.article_url,
      },
    });
  }
  if (platform === "instagram") {
    return publishShortToInstagram({
      storyId,
      renderId,
      videoUrl,
      trigger: "auto",
      context: {
        hook: context.hook,
        title: context.title,
        article_url: context.article_url,
      },
    });
  }
  if (platform === "youtube") {
    return publishShortToYouTube({
      storyId,
      renderId,
      videoUrl,
      trigger: "auto",
      context,
    });
  }
  return publishShortToTikTok({
    storyId,
    renderId,
    videoUrl,
    trigger: "auto",
    context,
  });
}

/** Toggle-gated Story cross-post. Mirrors crossPostStoryIfEnabled in
 *  actions.ts so the cron's publish behavior matches the bulk
 *  action's behavior 1:1 — same setting keys, same trigger value,
 *  same error swallowing. */
async function crossPostStoryIfEnabled(
  platform: "facebook" | "instagram",
  storyId: string,
  renderId: string,
  videoUrl: string,
): Promise<void> {
  try {
    const settingKey =
      platform === "facebook"
        ? FB_STORY_SETTING_AUTO_PUBLISH
        : IG_STORY_SETTING_AUTO_PUBLISH;
    const on = (await getSetting(settingKey)) === "1";
    if (!on) {
      namespacedLog("story_skip_toggle_off", {
        story_id: storyId,
        platform,
      });
      return;
    }
    const r =
      platform === "facebook"
        ? await publishShortToFacebookStory({
            storyId,
            renderId,
            videoUrl,
            trigger: "auto",
          })
        : await publishShortToInstagramStory({
            storyId,
            renderId,
            videoUrl,
            trigger: "auto",
          });
    namespacedLog("story_published", {
      story_id: storyId,
      platform,
      status: r.status,
    });
  } catch (e) {
    namespacedLog("story_error", {
      story_id: storyId,
      platform,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Resolve the article URL for the publisher context. Duplicated from
 *  bulkResolveArticleUrl in actions.ts (it's a private helper there);
 *  10 lines is not worth a new shared module given how stable both
 *  call sites are. */
async function resolveArticleUrl(storyId: string): Promise<string> {
  const origin =
    process.env.NEXT_PUBLIC_SITE_ORIGIN || "https://www.lorewire.com";
  const article = await one<{ language: string; slug: string }>(
    "SELECT language, slug FROM articles WHERE story_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1",
    [storyId],
  ).catch(() => null);
  return article
    ? `${origin}/articles/${article.language}/${article.slug}`
    : origin;
}

async function incrementAttempts(storyId: string): Promise<number> {
  await run(
    "UPDATE stories SET auto_publish_attempts = COALESCE(auto_publish_attempts, 0) + 1 WHERE id = ?",
    [storyId],
  );
  const row = await one<{ n: number | null }>(
    "SELECT auto_publish_attempts AS n FROM stories WHERE id = ?",
    [storyId],
  );
  return row?.n ?? 0;
}

async function clearFlag(storyId: string, reason: string): Promise<void> {
  await run(
    "UPDATE stories SET auto_publish_when_ready = 0, auto_publish_attempts = 0 WHERE id = ?",
    [storyId],
  );
  namespacedLog("clear", { story_id: storyId, reason });
}

async function resolveMaxAttempts(): Promise<number> {
  const raw = await getSetting(SETTING_MAX_ATTEMPTS);
  if (!raw) return DEFAULT_MAX_ATTEMPTS;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ATTEMPTS;
  return n;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return serve(req);
}

export const maxDuration = 300;
