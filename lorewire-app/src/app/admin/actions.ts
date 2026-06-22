"use server";

// Server actions for the admin. Every mutation re-checks authorization at the
// data source (requireAdmin) rather than trusting the proxy alone.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { CATEGORIES } from "@/app/admin/ui";
import { requireAdmin, ensureSeedAdmin, currentUser } from "@/lib/dal";
import { createSession, deleteSession } from "@/lib/session";
import {
  getUserByEmail,
  updateStory,
  setStatus,
  setSetting,
  getSetting,
  upsertVoiceover,
  deleteVoiceover,
  setDefaultVoiceoverId,
  setCategoryVoiceoverId,
  getStoryConfigJson,
  setStoryConfigJson,
  getSegment,
  setSegmentEnabled,
  updateSegmentLabel,
  deleteSegment,
  setStorySegmentOverride,
  createArticle,
  getArticle,
  getArticleBySourceSheetRowId,
  updateArticle,
  setArticleStatus,
  setArticleNoindex,
  setArticleStoryId,
  setStoryNoindex,
  setStoryVoice,
  getStory as getStoryRow,
  deleteArticle,
  deleteStory,
  setStoryCategory,
  appendRevision,
  checkSlugAvailable,
  updateArticleSlug,
  getRevision,
  nameRevision,
  unnameRevision,
  pruneRevisions,
  type StoryStatus,
  type SegmentKind,
  type ArticleStatus,
  type ArticleLanguage,
} from "@/lib/repo";
import { verifyPassword } from "@/lib/passwords";
import { selectModel, type Stage } from "@/lib/models";
import { run } from "@/lib/db";
import {
  canEnqueueImageRegen,
  cancelAllImageRendersForOwner,
  cancelImageRender,
  enqueueImageRegen,
  enqueueScenesBulk,
  listRenderEvents,
  type EnqueueScenesBulkResult,
  type RenderEventRow,
} from "@/lib/image-render-queue";
import { sanitizeLabel } from "@/lib/segments-upload";
import {
  LEGACY_DEFAULT_ASPECT,
  VIDEO_ASPECTS,
  activeSegmentSettingKey,
  isVideoAspect,
  legacyActiveSegmentSettingKey,
} from "@/lib/aspect";
import {
  USER_CAPTION_PRESETS_SETTING_KEY,
  findBuiltInCaptionPreset,
  type CaptionPreset,
  type CaptionStyleValues,
} from "@/lib/caption-presets";
import {
  isArticleType,
  isArticleLanguage,
  slugifyTitle,
} from "@/lib/articles";
import { countImagesMissingAlt } from "@/lib/tiptap-article-image";
import {
  appendArticleGalleryItem,
  countGalleryImagesMissingAlt,
} from "@/lib/tiptap-gallery";
import { getLinkedShortFrame } from "@/lib/article-shorts";
import {
  NewsPayloadSchema,
  FeaturePayloadSchema,
  ListiclePayloadSchema,
  ReviewPayloadSchema,
} from "@/lib/article-payload";
import { isValidSlugShape } from "@/lib/article-seo";
import type { ArticleType } from "@/lib/repo";
import {
  isConfigured as isSheetsConfigured,
  parseSheetRef,
  readRows,
  stableRowId,
} from "@/lib/sheets";

export interface LoginState {
  error?: string;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Enter your email and password." };
  }
  // Bootstrap the first admin from env if the users table is still empty.
  await ensureSeedAdmin();
  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return { error: "Wrong email or password." };
  }
  await createSession({ userId: user.id, email: user.email, role: user.role });
  redirect("/admin");
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/admin/login");
}

export async function saveStory(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await updateStory(id, {
    title: String(formData.get("title") ?? ""),
    category: String(formData.get("category") ?? ""),
    duration: String(formData.get("duration") ?? ""),
    source_url: String(formData.get("source_url") ?? ""),
    summary: String(formData.get("summary") ?? ""),
    body: String(formData.get("body") ?? ""),
    teleprompter: String(formData.get("teleprompter") ?? ""),
  });
  // 2026-06-18 polls plan extension: every story should have a poll.
  // Try to autodraft now that the admin has just saved (body may
  // have meaningful content). Service is idempotent — skips when an
  // enabled poll already exists. Best-effort: any failure logs and
  // the save still succeeds.
  try {
    const body = String(formData.get("body") ?? "").trim();
    if (body.length >= 50) {
      const story = await getStoryRow(id);
      const { autoDraftPollForSubject } = await import("@/lib/poll-autodraft");
      await autoDraftPollForSubject({
        kind: "story",
        storyId: id,
        title: story?.title ?? null,
        body,
        category: story?.category ?? null,
      });
    }
  } catch (err) {
    console.warn("[stories action] autodraft on save failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath("/admin/stories");
}

export async function changeStatus(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as StoryStatus;
  if (!id || !status) return;
  await setStatus(id, status);
  // 2026-06-18 polls plan extension: fire the autodraft service when
  // a story transitions to published — the public widget needs a poll
  // by then. Idempotent (skips enabled polls). Body should be
  // populated by the pipeline at this point.
  if (status === "published") {
    try {
      const story = await getStoryRow(id);
      const body = (story?.body ?? "").trim();
      if (story && body.length >= 50) {
        const { autoDraftPollForSubject } = await import(
          "@/lib/poll-autodraft"
        );
        await autoDraftPollForSubject({
          kind: "story",
          storyId: id,
          title: story.title,
          body,
          category: story.category,
        });
      }
    } catch (err) {
      console.warn("[stories action] autodraft on publish failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath("/admin/stories");
  revalidatePath("/admin");
}

export async function setStoryNoindexAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const noindex = String(formData.get("noindex") ?? "") === "1";
  if (!id) return;
  await setStoryNoindex(id, noindex);
  console.info("[stories action] noindex", { id, noindex });
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath(`/admin/videos/${id}`);
}

// Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: per-story aspect
// override. Lives inside `video_config.aspect` (the same field the renderer
// reads via `resolveAspect`). When the story has no video_config yet we
// write a minimal `{"aspect":...}` blob — the pipeline's first-render
// merge picks the existing aspect up and stamps the full config on top
// without clobbering it. Re-runs preserve the choice through Phase 0's
// merge logic.
//
// Validation is strict: only the two supported strings are accepted; any
// other payload is silently rejected so a tampered client can't write a
// garbage value the renderer would then trip on.
export async function setStoryAspectAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const rawAspect = String(formData.get("aspect") ?? "");
  if (!id) return { ok: false, error: "missing id" };
  if (rawAspect !== "16:9" && rawAspect !== "9:16") {
    console.warn("[stories action] aspect rejected", { id, rawAspect });
    return { ok: false, error: "invalid aspect" };
  }
  const existingJson = await getStoryConfigJson(id);
  let next: Record<string, unknown>;
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      next = parsed && typeof parsed === "object" ? { ...parsed } : {};
    } catch {
      // The column held something that can't round-trip. Refuse rather
      // than clobber what might be salvageable by the pipeline's merge.
      console.warn("[stories action] aspect: malformed video_config", { id });
      return { ok: false, error: "video_config not parseable" };
    }
  } else {
    next = {};
  }
  next.aspect = rawAspect;
  await setStoryConfigJson(id, JSON.stringify(next));
  console.info("[stories action] aspect", { id, aspect: rawAspect });
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath(`/admin/videos/${id}`);
  revalidatePath(`/v/${id}`);
  return { ok: true };
}

// Phase 1 of _plans/2026-06-17-engagement-polls.md. Story-level poll
// save: validates the editor inputs through validatePollInputs (single
// trust boundary, also reused by the LLM auto-draft endpoint) and
// upserts the row. The story's current category is snapshotted onto
// polls.category so the rail queries don't have to join through
// stories on the hot path. Returns a shape the client can branch on so
// inline validation errors render without a refresh.
export async function savePollAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  created?: boolean;
}> {
  await requireAdmin();
  const storyId = String(formData.get("story_id") ?? "");
  if (!storyId) return { ok: false, error: "missing story id" };
  const story = await getStoryRow(storyId);
  if (!story) {
    console.warn("[polls action] save: story not found", { story_id: storyId });
    return { ok: false, error: "story not found" };
  }
  const { upsertPoll } = await import("@/lib/polls");
  const result = await upsertPoll({
    storyId,
    question: String(formData.get("question") ?? ""),
    optionA: String(formData.get("option_a") ?? ""),
    optionB: String(formData.get("option_b") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "1",
    category: story.category,
  });
  if (!result.ok) {
    console.warn("[polls action] save rejected", {
      story_id: storyId,
      error: result.error,
    });
    return { ok: false, error: result.error };
  }
  console.info("[polls action] save", {
    story_id: storyId,
    poll_id: result.pollId,
    created: result.created,
  });
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath("/admin/polls");
  return { ok: true, created: result.created };
}

// 2026-06-18 polls plan extension: backfill action for the "every
// article must have a poll, whether existing or new" requirement.
// Walks every published story + article without an enabled poll and
// fires the autodraft service. Best-effort per row: a per-row failure
// logs and skips, never aborts the batch. Idempotent — re-running is
// safe; rows with admin-saved (enabled=1) polls are left alone.
//
// Surfaces on /admin/polls as a button. Per-call cost: ~$0.001 per
// row × (count of subjects without an enabled poll). With 50
// existing articles + 100 stories that's ~$0.15.
export interface BackfillPollsResult {
  ok: boolean;
  storiesScanned: number;
  articlesScanned: number;
  pollsCreatedFromLLM: number;
  pollsCreatedAsDraft: number;
  errors: number;
}

export async function backfillPollsAction(): Promise<BackfillPollsResult> {
  await requireAdmin();
  const startedAt = Date.now();
  const result: BackfillPollsResult = {
    ok: true,
    storiesScanned: 0,
    articlesScanned: 0,
    pollsCreatedFromLLM: 0,
    pollsCreatedAsDraft: 0,
    errors: 0,
  };
  const { autoDraftPollForSubject, tiptapToPlainText } = await import(
    "@/lib/poll-autodraft"
  );
  const { listStories, listArticlesSlim, getArticle } = await import(
    "@/lib/repo"
  );

  // Stories: published rows the public reader can see. We don't try
  // to autodraft drafts because admin hasn't decided on the body yet.
  const stories = await listStories({ status: "published" });
  for (const s of stories) {
    result.storiesScanned += 1;
    const body = (s.body ?? "").trim();
    if (body.length < 50) {
      continue; // not enough text for the LLM to make sense of
    }
    try {
      const r = await autoDraftPollForSubject({
        kind: "story",
        storyId: s.id,
        title: s.title,
        body,
        category: s.category,
      });
      if (r.ok && r.ai) result.pollsCreatedFromLLM += 1;
      else if (r.ok && !r.ai) result.pollsCreatedAsDraft += 1;
      else result.errors += 1;
    } catch (err) {
      result.errors += 1;
      console.warn("[polls backfill story failed]", {
        story_id: s.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Articles: every published article. Read each via getArticle so we
  // have the document column for tiptapToPlainText.
  const articles = await listArticlesSlim({ status: "published" });
  for (const a of articles) {
    result.articlesScanned += 1;
    const full = await getArticle(a.id);
    if (!full) continue;
    const bodyText = tiptapToPlainText(full.document);
    if (bodyText.length < 50) continue;
    try {
      const r = await autoDraftPollForSubject({
        kind: "article",
        articleId: a.id,
        title: a.title,
        bodyText,
        type: a.type,
      });
      if (r.ok && r.ai) result.pollsCreatedFromLLM += 1;
      else if (r.ok && !r.ai) result.pollsCreatedAsDraft += 1;
      else result.errors += 1;
    } catch (err) {
      result.errors += 1;
      console.warn("[polls backfill article failed]", {
        article_id: a.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.info("[polls backfill done]", {
    duration_ms: Date.now() - startedAt,
    ...result,
  });
  revalidatePath("/admin/polls");
  return result;
}

// 2026-06-18 standalone-article polls (plan §15). Mirrors
// savePollAction for the article CMS surface. Articles get their
// OWN poll authored on the article edit page — independent of any
// linked story's poll. The article reader resolves article-own >
// linked-story priority (see /articles/[locale]/[slug]/page.tsx).
//
// Category snapshot uses the article TYPE (news / feature /
// listicle / review) so per-type analytics roll up without a join
// to articles — same shape story polls use for stories.category.
export async function saveArticlePollAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  created?: boolean;
}> {
  await requireAdmin();
  const articleId = String(formData.get("article_id") ?? "");
  if (!articleId) return { ok: false, error: "missing article id" };
  const article = await getArticle(articleId);
  if (!article) {
    console.warn("[polls action] save: article not found", {
      article_id: articleId,
    });
    return { ok: false, error: "article not found" };
  }
  const { upsertPoll } = await import("@/lib/polls");
  const result = await upsertPoll({
    articleId,
    question: String(formData.get("question") ?? ""),
    optionA: String(formData.get("option_a") ?? ""),
    optionB: String(formData.get("option_b") ?? ""),
    enabled: String(formData.get("enabled") ?? "") === "1",
    category: article.type,
  });
  if (!result.ok) {
    console.warn("[polls action] save article rejected", {
      article_id: articleId,
      error: result.error,
    });
    return { ok: false, error: result.error };
  }
  console.info("[polls action] save article", {
    article_id: articleId,
    poll_id: result.pollId,
    created: result.created,
  });
  revalidatePath(`/admin/articles/${articleId}`);
  revalidatePath("/admin/polls");
  return { ok: true, created: result.created };
}

// ─── Asset re-render ─────────────────────────────────────────────────────────
// Enqueue one image-regen request. Admin clicks Regenerate on a hero, scene,
// prop, mouth-swap, OG, or gallery image; we run a budget pre-flight, queue
// the row, and let pipeline/image_render_worker.py drain it.
//
// Returns a shape the client can branch on without try/catch. Cap rejection
// surfaces as an explicit error so the UI can render "today: $X.XX of $Y
// used — try tomorrow" instead of an opaque 500.

export interface EnqueueImageRegenResult {
  ok: boolean;
  error?: string;
  renderId?: string;
  estimateCents?: number;
  spentCents?: number;
  capCents?: number;
}

export async function enqueueImageRegenAction(opts: {
  ownerKind: "story" | "article";
  ownerId: string;
  asset: string;
}): Promise<EnqueueImageRegenResult> {
  const session = await requireAdmin();
  const { ownerKind, ownerId, asset } = opts;
  if (!ownerId || !asset) {
    return { ok: false, error: "missing owner/asset" };
  }
  // Validate the owner exists before burning budget. Article and story
  // tables are separate, so branch by kind. We keep the story row when
  // we have one — the scenes bulk path needs body + duration to
  // auto-derive the target scene count.
  let storyRow: Awaited<ReturnType<typeof getStoryRow>> | null = null;
  if (ownerKind === "article") {
    const row = await getArticle(ownerId);
    if (!row) return { ok: false, error: "article not found" };
  } else {
    storyRow = await getStoryRow(ownerId);
    if (!storyRow) return { ok: false, error: "story not found" };
  }

  // Story scenes route to the per-scene bulk enqueue. The legacy single
  // 'scenes' row can't fit under Vercel's function deadline (the 2026-06-13
  // zombie incident). Article scenes don't exist as a slug today, so this
  // dispatch is story-only. Pass body + duration so the bulk enqueue
  // resolves the SAME auto-derived count the panel displays — otherwise
  // a 27-scene story gets a 30-row queue and the trailing rows fall off
  // the end of stories.images (the exact regression that hit `envelope`
  // 2026-06-14). Return shape is normalised back into the
  // EnqueueImageRegenResult the caller already handles, so the panel and
  // the bulk Rebuild-all button keep working without per-call-site changes.
  if (ownerKind === "story" && asset === "scenes" && storyRow) {
    const bulk = await enqueueScenesBulk({
      ownerKind,
      ownerId,
      requestedBy: session.userId,
      storyBody: storyRow.body,
      storyDuration: storyRow.duration,
    });
    return scenesBulkAsRegenResult(bulk, ownerId);
  }

  const pre = await canEnqueueImageRegen(asset);
  if (!pre.ok) {
    console.warn("[image regen action] budget exceeded", {
      asset,
      estimate_cents: pre.estimateCents,
      spent_cents: pre.budget.spentCents,
      cap_cents: pre.budget.capCents,
    });
    return {
      ok: false,
      error: "daily-budget-exceeded",
      estimateCents: pre.estimateCents,
      spentCents: pre.budget.spentCents,
      capCents: pre.budget.capCents,
    };
  }

  const fresh = await enqueueImageRegen({
    ownerKind,
    ownerId,
    asset,
    promptHash: null,
    requestedBy: session.userId,
  });

  console.info("[image regen action] enqueued", {
    render_id: fresh.id,
    owner_kind: ownerKind,
    owner_id: ownerId,
    asset,
    estimate_cents: pre.estimateCents,
    user_id: session.userId,
  });

  revalidateOwnerPanels(ownerKind, ownerId);

  return {
    ok: true,
    renderId: fresh.id,
    estimateCents: pre.estimateCents,
    spentCents: pre.budget.spentCents,
    capCents: pre.budget.capCents,
  };
}

// Per-row event timeline for image_renders (Phase 2 observability).
// The RenderEventTimeline client component polls this every 3s while
// the parent row is transitional. Cheap query — events for one render
// are ~5-200 rows max with a primary-key-style index lookup.
export async function listRenderEventsAction(
  renderId: string,
): Promise<RenderEventRow[]> {
  await requireAdmin();
  if (!renderId) return [];
  return listRenderEvents(renderId);
}

// Stop button — single row. Flips the queue row to 'cancelled' so the cron
// drain skips it. No-op when the row is already settled.
//
// Companion to `enqueueImageRegenAction`. Both gated by `requireAdmin`. The
// path-revalidation set must include every admin surface that renders the
// MediaRegenPanel so cancelled rows visibly settle after one click.

export interface CancelImageRenderResult {
  ok: boolean;
  error?: string;
  /** Status the row had immediately before the flip — useful for telemetry. */
  priorStatus?: string;
}

export async function cancelImageRenderAction(opts: {
  renderId: string;
  reason?: string;
}): Promise<CancelImageRenderResult> {
  const session = await requireAdmin();
  const { renderId } = opts;
  const reason = (opts.reason ?? "").trim() || "cancelled by admin";
  if (!renderId) return { ok: false, error: "missing render id" };

  const updated = await cancelImageRender(renderId, reason);
  if (!updated) {
    console.warn("[cancel image render] not-found", { render_id: renderId });
    return { ok: false, error: "render not found" };
  }
  if (updated.status !== "cancelled") {
    console.info("[cancel image render] not-cancellable", {
      render_id: renderId,
      status: updated.status,
    });
    return { ok: false, error: "not-cancellable", priorStatus: updated.status };
  }

  console.info("[cancel image render] ok", {
    render_id: renderId,
    asset: updated.asset,
    owner_kind: updated.owner_kind,
    owner_id: updated.owner_id,
    user_id: session.userId,
  });

  revalidateOwnerPanels(updated.owner_kind, updated.owner_id);
  return { ok: true };
}

// Stop button — every active row for one owner. Used by the panel header's
// "Stop all" affordance and by the per-card "Stop all scenes" affordance on
// the bulk scenes row. Returns the count flipped so the toast can read
// "Cancelled 27 jobs."

export interface CancelAllImageRendersResult {
  ok: boolean;
  cancelled: number;
  error?: string;
}

export async function cancelAllImageRendersAction(opts: {
  ownerKind: "story" | "article";
  ownerId: string;
  reason?: string;
}): Promise<CancelAllImageRendersResult> {
  const session = await requireAdmin();
  const { ownerKind, ownerId } = opts;
  const reason = (opts.reason ?? "").trim() || "stopped by admin (bulk)";
  if (!ownerId) return { ok: false, cancelled: 0, error: "missing owner" };

  const { cancelled } = await cancelAllImageRendersForOwner(
    ownerKind,
    ownerId,
    reason,
  );
  console.info("[cancel all image renders] ok", {
    owner_kind: ownerKind,
    owner_id: ownerId,
    cancelled_count: cancelled.length,
    user_id: session.userId,
  });
  revalidateOwnerPanels(ownerKind, ownerId);
  return { ok: true, cancelled: cancelled.length };
}

// Normalise an enqueueScenesBulk result into the EnqueueImageRegenResult
// shape the panel + Rebuild-all button already speak. Defined alongside the
// cancel actions because that's where the route-revalidation conventions
// live; keeping both helpers next to each other makes the dispatch obvious.
function scenesBulkAsRegenResult(
  bulk: EnqueueScenesBulkResult,
  ownerId: string,
): EnqueueImageRegenResult {
  if (!bulk.ok) {
    return {
      ok: false,
      error: bulk.error ?? "scenes-bulk-failed",
      estimateCents: bulk.estimateCents,
      spentCents: bulk.spentCents,
      capCents: bulk.capCents,
    };
  }
  // Bulk enqueue logs once for the batch — per-row logging would flood the
  // console with N nearly-identical lines.
  console.info("[image regen action] scenes bulk enqueued", {
    owner_id: ownerId,
    count: bulk.count,
    estimate_cents: bulk.estimateCents,
    first_render_id: bulk.firstRenderId,
  });
  revalidateOwnerPanels("story", ownerId);
  return {
    ok: true,
    renderId: bulk.firstRenderId,
    estimateCents: bulk.estimateCents,
    spentCents: bulk.spentCents,
    capCents: bulk.capCents,
  };
}

function revalidateOwnerPanels(
  ownerKind: string,
  ownerId: string,
): void {
  if (ownerKind === "story") {
    revalidatePath(`/admin/stories/${ownerId}`);
    revalidatePath(`/admin/videos/${ownerId}`);
  } else {
    revalidatePath(`/admin/articles/${ownerId}`);
  }
}

export async function setModelAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const stage = String(formData.get("stage") ?? "") as Stage;
  const model = String(formData.get("model") ?? "");
  if (!stage || !model) return;
  await selectModel(stage, model);
  revalidatePath("/admin/models");
}

// Per-key value validators for `saveSettingAction`. Keys not listed accept
// any string (the existing free-form behavior). Validators return either the
// canonicalised value (often identical to the input) or null to reject the
// write, in which case the action no-ops without surfacing an error — the
// client UI already constrains the input, so a failed validation here means
// either a stale form submit or a malicious client. Rejecting silently is
// the safe default since the UI's optimistic state already showed the
// (rejected) value to the user — better to leak nothing than to mask a
// security-relevant rejection in a 4xx error stream.
const SETTING_VALUE_VALIDATORS: Record<
  string,
  (raw: string) => string | null
> = {
  "video.default_aspect": (raw) =>
    raw === "16:9" || raw === "9:16" ? raw : null,
  "media.scene_count_mode": (raw) =>
    raw === "auto" || raw === "manual" ? raw : null,
  "media.scene_count_target_seconds_per_scene": (raw) => {
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) return null;
    // Mirrors the pipeline-side clamp range so a tampered client can't
    // wedge the pipeline into asking for absurd scene counts.
    if (v < 1 || v > 30) return null;
    return String(v);
  },
  // Per-tick row cap for the Vercel cron drain (see
  // `lorewire-app/api/drain_image_renders.py` and
  // `_plans/2026-06-13-worker-host-stop-button-observability.md`).
  // Range matches DRAIN_MAX_ROWS_PER_TICK env clamp on the Python
  // side so the admin and the worker never disagree.
  "media.cron_max_rows_per_tick": (raw) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    if (n < 1 || n > 60) return null;
    return String(n);
  },
  // Homepage curation behaviour (phase 4 of
  // _plans/2026-06-16-homepage-curation.md). Closed enum + bool flag
  // so a tampered client can't wedge HomePage into an unknown branch.
  "curation.empty_rail_behavior": (raw) =>
    raw === "fallback" || raw === "hide" ? raw : null,
  "curation.hero_required": (raw) =>
    raw === "true" || raw === "false" ? raw : null,
};

export async function saveSettingAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const key = String(formData.get("key") ?? "");
  if (!key) return;
  const rawValue = String(formData.get("value") ?? "");
  const validator = SETTING_VALUE_VALIDATORS[key];
  const value = validator ? validator(rawValue) : rawValue;
  if (value === null) {
    console.warn(
      `[admin setting] reject key=${key} value=${JSON.stringify(
        rawValue.slice(0, 32),
      )} (failed validator)`,
    );
    return;
  }
  await setSetting(key, value);
  // Settings show up in multiple admin pages (the master switch lives on
  // both /admin/settings and /admin/segments; the daily render cap setting
  // is read from /admin/videos/[id]). Revalidate the whole admin layout so
  // the next render anywhere under /admin reflects the new value.
  revalidatePath("/admin", "layout");
}

// --- Voiceover presets (/admin/voiceovers) ----------------------------------
// CRUD for named TTS presets + the global-default / per-category selection.
// All admin-gated; the pipeline reads the resulting voiceovers table + the
// voiceovers.default / voiceovers.category.<Cat> settings via
// pipeline/voiceovers.resolve_voiceover.

export async function saveVoiceoverAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim();
  const voiceId = String(formData.get("voice_id") ?? "").trim();
  if (!name || !provider || !voiceId) return;
  const id = String(formData.get("id") ?? "").trim() || randomUUID();
  const stylePrompt = String(formData.get("style_prompt") ?? "").trim();
  const rateRaw = String(formData.get("speaking_rate") ?? "").trim();
  const rate = rateRaw ? Number(rateRaw) : null;
  await upsertVoiceover({
    id,
    name,
    provider,
    voice_id: voiceId,
    style_prompt: stylePrompt || null,
    speaking_rate: rate !== null && Number.isFinite(rate) ? rate : null,
    hook_pause: String(formData.get("hook_pause") ?? "") === "1" ? 1 : 0,
  });
  console.info("[voiceover action] save", { id, name, provider, voiceId });
  revalidatePath("/admin/voiceovers");
}

export async function deleteVoiceoverAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await deleteVoiceover(id);
  console.info("[voiceover action] delete", { id });
  revalidatePath("/admin/voiceovers");
}

export async function setDefaultVoiceoverAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "").trim();
  await setDefaultVoiceoverId(id);
  console.info("[voiceover action] set default", { id });
  // The default feeds the shorts pipeline; revalidate the whole admin layout.
  revalidatePath("/admin", "layout");
}

export async function setCategoryVoiceoverAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const category = String(formData.get("category") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) return;
  await setCategoryVoiceoverId(category, id);
  console.info("[voiceover action] set category", { category, id });
  revalidatePath("/admin/voiceovers");
}

// Synthesize a sample for an arbitrary (possibly unsaved) voiceover config so
// the admin can hear a voice WHILE choosing it in the editor, before saving.
// Calls the Python preview endpoint (which has the Google creds) with the shared
// CRON_SECRET; returns the MP3 as a data URL the client plays. Preview only
// works where the Vercel Python runtime + creds exist (deploy), not local
// `next dev`; the error path surfaces that cleanly.
export async function previewVoiceoverConfigAction(config: {
  provider: string;
  voice_id: string;
  style_prompt?: string | null;
  speaking_rate?: number | null;
  hook_pause?: boolean;
}): Promise<{ ok: true; audio: string } | { ok: false; error: string }> {
  await requireAdmin();
  if (!config.provider || !config.voice_id) {
    return { ok: false, error: "Pick a model and a voice first." };
  }
  return runVoiceoverPreview({
    provider: config.provider,
    voice_id: config.voice_id,
    style_prompt: config.style_prompt ?? null,
    speaking_rate: config.speaking_rate ?? null,
    hook_pause: !!config.hook_pause,
  });
}

// Shared core: POST a config to the Python preview endpoint and return a data
// URL. Kept separate so both the editor (config) and any saved-preset caller
// can reuse it.
async function runVoiceoverPreview(payload: {
  provider: string;
  voice_id: string;
  style_prompt: string | null;
  speaking_rate: number | null;
  hook_pause: boolean;
}): Promise<{ ok: true; audio: string } | { ok: false; error: string }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, error: "CRON_SECRET is not set, so preview is unavailable." };
  }
  const h = await headers();
  const host = h.get("host");
  if (!host) return { ok: false, error: "Could not resolve the app host for preview." };
  const proto = h.get("x-forwarded-proto") ?? "https";
  try {
    const resp = await fetch(`${proto}://${host}/api/preview_voiceover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        provider: payload.provider,
        voice_id: payload.voice_id,
        style_prompt: payload.style_prompt,
        speaking_rate: payload.speaking_rate,
        hook_pause: payload.hook_pause,
      }),
    });
    if (!resp.ok) {
      const msg = (await resp.text()).slice(0, 200);
      return { ok: false, error: `Preview failed (${resp.status}): ${msg}` };
    }
    const data = (await resp.json()) as {
      audio_base64: string;
      content_type: string;
    };
    return {
      ok: true,
      audio: `data:${data.content_type};base64,${data.audio_base64}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Wave 3 Phase 1 + 2: save all 14 caption template fields for whatever scope
// the form is editing (global / per-category / per-story). The form's hidden
// __scope / __cat / __story fields tell us which key prefix to write under;
// the bare field name in the form input (e.g. "caption.color") loses its
// "caption." prefix here and gets re-keyed with the scope prefix.
const CAPTION_TEMPLATE_FIELDS = [
  "position_y",
  "size_scale",
  "padding_x",
  "text_transform",
  "letter_spacing",
  "line_height",
  "font_weight",
  "color",
  "outline_color",
  "outline_width",
  "active_word_color",
  "spoken_word_color",
  "entry_effect",
  "word_highlight",
] as const;

function captionPrefix(scope: string, cat?: string, story?: string): string {
  if (scope === "story" && story) return `caption.story.${story}`;
  if (scope === "cat" && cat) return `caption.cat.${cat}`;
  return "caption";
}

/** Phase 5 of _plans/2026-06-12-video-aspect-ratio.md: optional aspect
 *  segment layered onto every settings-key prefix. "16:9" / "9:16"
 *  encode as "16x9" / "9x16" so the dotted namespace stays unambiguous.
 *  Anything else (including the literal "any") returns an empty string,
 *  meaning "the aspect-agnostic tier" (the pre-Phase-5 behaviour). */
function captionAspectSegment(aspect: string): string {
  if (aspect === "16:9") return ".16x9";
  if (aspect === "9:16") return ".9x16";
  return "";
}

// Per-story caption style action. The video editor's Caption style tab
// calls this with the bare field name + new value; an empty value clears
// the story-scope override (so the field falls back to category → global →
// defaults via lib/caption-style.ts).
//
// Returns a typed result so the client can branch on success/failure
// without try/catch wrappers. Revalidates the video editor page so the
// next render of the live preview reads the fresh resolved style.
export interface SaveStoryCaptionStyleResult {
  ok: boolean;
  error?: string;
}

export async function saveStoryCaptionStyleAction(
  storyId: string,
  field: string,
  value: string,
): Promise<SaveStoryCaptionStyleResult> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing-story" };
  if (!CAPTION_STYLE_FIELDS_SET.has(field)) {
    return { ok: false, error: `unknown caption field "${field}"` };
  }
  const key = `caption.story.${storyId}.${field}`;
  // Empty value = clear the override. The renderer / inheritance chain
  // falls back to category → global → defaults.
  const trimmed = value.trim();
  await setSetting(key, trimmed);
  console.info("[admin caption-style save]", {
    story_id: storyId,
    field,
    cleared: trimmed === "",
  });
  revalidatePath(`/admin/videos/${storyId}`);
  revalidatePath(`/admin/templates`);
  return { ok: true };
}

// Caption fields the action accepts. Mirrors lib/caption-style.ts's
// CAPTION_STYLE_FIELDS. Duplicated here as a Set so the validation is one
// hash lookup instead of an array scan; the type-level guarantee that the
// two stay in sync is enforced by the test suite.
const CAPTION_STYLE_FIELDS_SET = new Set<string>([
  "position_y",
  "size_scale",
  "padding_x",
  "text_transform",
  "font_weight",
  "letter_spacing",
  "line_height",
  "color",
  "active_word_color",
  "spoken_word_color",
  "outline_color",
  "outline_width",
  "entry_effect",
  "word_highlight",
]);

// ─── Caption presets (Phase B) ─────────────────────────────────────────────
//
// applyCaptionStylePresetAction batch-writes every field of one preset
// into the story-scope settings. Built-ins live in
// lib/caption-presets.ts; user presets live in the settings table
// under USER_CAPTION_PRESETS_SETTING_KEY and are merged at apply time
// so an admin's saved style works exactly like a built-in.
//
// clearStoryCaptionOverridesAction wipes all 14 story-scope keys so
// the panel falls back to category → global → defaults. Used by the
// "Reset all" action in the panel header.
//
// saveUserCaptionPresetAction appends to the user-presets list under
// the user's account. Names are length-capped (60 chars) and
// control-char rejected (rule 13 §Security).

const MAX_PRESET_NAME_LEN = 60;
// eslint-disable-next-line no-control-regex -- intentional: rejecting them
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export interface ApplyCaptionPresetResult {
  ok: boolean;
  error?: string;
  /** The applied preset's id, echoed back for the UI to highlight. */
  presetId?: string;
}

async function listUserCaptionPresets(): Promise<CaptionPreset[]> {
  const raw = await getSetting(USER_CAPTION_PRESETS_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CaptionPreset =>
        Boolean(p) &&
        typeof p === "object" &&
        typeof (p as CaptionPreset).id === "string" &&
        typeof (p as CaptionPreset).name === "string" &&
        Boolean((p as CaptionPreset).values),
    );
  } catch {
    return [];
  }
}

export async function applyCaptionStylePresetAction(
  storyId: string,
  presetId: string,
): Promise<ApplyCaptionPresetResult> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing-story" };
  if (!presetId) return { ok: false, error: "missing-preset" };

  // Built-ins first; fall through to the user-presets list. Both
  // share the CaptionPreset shape so the apply logic is identical.
  let preset: CaptionPreset | undefined = findBuiltInCaptionPreset(presetId);
  if (!preset) {
    const userPresets = await listUserCaptionPresets();
    preset = userPresets.find((p) => p.id === presetId);
  }
  if (!preset) return { ok: false, error: "unknown-preset" };

  // Sequential because settings_kv writes are cheap and a parallel
  // burst can still hit per-row locks under sqlite. 14 fields = ~14ms
  // total locally, ~70ms across an edge function. Worth the simpler
  // failure mode.
  for (const [field, value] of Object.entries(preset.values)) {
    if (!CAPTION_STYLE_FIELDS_SET.has(field)) continue;
    await setSetting(`caption.story.${storyId}.${field}`, value);
  }

  console.info("[admin caption-style preset_applied]", {
    story_id: storyId,
    preset_id: preset.id,
    field_count: Object.keys(preset.values).length,
  });

  revalidatePath(`/admin/videos/${storyId}`);
  revalidatePath(`/admin/templates`);
  return { ok: true, presetId: preset.id };
}

export interface ClearCaptionOverridesResult {
  ok: boolean;
  error?: string;
}

export async function clearStoryCaptionOverridesAction(
  storyId: string,
): Promise<ClearCaptionOverridesResult> {
  await requireAdmin();
  if (!storyId) return { ok: false, error: "missing-story" };
  for (const field of CAPTION_STYLE_FIELDS_SET) {
    await setSetting(`caption.story.${storyId}.${field}`, "");
  }
  console.info("[admin caption-style overrides_cleared]", {
    story_id: storyId,
    field_count: CAPTION_STYLE_FIELDS_SET.size,
  });
  revalidatePath(`/admin/videos/${storyId}`);
  revalidatePath(`/admin/templates`);
  return { ok: true };
}

export interface SaveUserCaptionPresetResult {
  ok: boolean;
  error?: string;
  presetId?: string;
}

export async function saveUserCaptionPresetAction(opts: {
  name: string;
  values: CaptionStyleValues;
}): Promise<SaveUserCaptionPresetResult> {
  await requireAdmin();
  const name = opts.name.trim();
  if (name.length === 0) return { ok: false, error: "name-empty" };
  if (name.length > MAX_PRESET_NAME_LEN) {
    return { ok: false, error: "name-too-long" };
  }
  if (CONTROL_CHAR_RE.test(name)) {
    return { ok: false, error: "name-control-chars" };
  }

  // Validate every field actually IS a caption field. A drift from
  // CAPTION_STYLE_FIELDS_SET would otherwise pollute the saved preset
  // with bogus keys that subsequent apply calls would silently skip.
  for (const k of Object.keys(opts.values)) {
    if (!CAPTION_STYLE_FIELDS_SET.has(k)) {
      return { ok: false, error: `unknown-field:${k}` };
    }
  }

  const id = `user-${randomUUID().slice(0, 8)}`;
  const fresh: CaptionPreset = {
    id,
    name,
    tagline: `User preset · ${name}`,
    values: opts.values,
  };
  const existing = await listUserCaptionPresets();
  const next = [...existing, fresh];
  await setSetting(USER_CAPTION_PRESETS_SETTING_KEY, JSON.stringify(next));

  console.info("[admin caption-style user_preset_saved]", {
    preset_id: id,
    name,
    total_user_presets: next.length,
  });

  revalidatePath(`/admin/videos`, "layout");
  revalidatePath(`/admin/templates`);
  return { ok: true, presetId: id };
}

// Server-only read helper exposed for the page's RSC pass.
export async function getUserCaptionPresetsForPage(): Promise<CaptionPreset[]> {
  await requireAdmin();
  return listUserCaptionPresets();
}

export async function saveCaptionTemplateAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const rawScope = String(formData.get("__scope") ?? "global");
  const cat = String(formData.get("__cat") ?? "") || undefined;
  const story = String(formData.get("__story") ?? "") || undefined;
  // Phase 5 of _plans/2026-06-12-video-aspect-ratio.md: an optional
  // aspect dimension layered on top of every tier. Anything other than
  // the supported pair is treated as the aspect-agnostic tier so a
  // tampered client cannot wedge writes into an arbitrary key namespace.
  const rawAspect = String(formData.get("__aspect") ?? "");
  const aspect = rawAspect === "16:9" || rawAspect === "9:16" ? rawAspect : "";
  // Scope guard: cat-scope without cat, or story-scope without story, is an
  // incomplete selection. Refuse to write — otherwise the writes would land
  // at the global prefix and silently overwrite the wrong tier.
  const scope =
    (rawScope === "cat" && !cat) || (rawScope === "story" && !story)
      ? "global"
      : rawScope;
  const prefix = captionPrefix(scope, cat, story) + captionAspectSegment(aspect);

  const changedKeys: string[] = [];
  for (const bare of CAPTION_TEMPLATE_FIELDS) {
    const formKey = `caption.${bare}`;
    const next = String(formData.get(formKey) ?? "").trim();
    const prev = String(formData.get(`__prev__${bare}`) ?? "").trim();
    if (next !== prev) {
      await setSetting(`${prefix}.${bare}`, next);
      changedKeys.push(`${prefix}.${bare}`);
    }
  }
  console.info("[admin caption-template save]", {
    rawScope,
    resolvedScope: scope,
    cat,
    story,
    aspect: aspect || null,
    changed: changedKeys,
    changedCount: changedKeys.length,
  });
  revalidatePath("/admin/templates");
  // Redirect back to the same scope view with ?saved=1 so the page renders a
  // saved-banner instead of giving the admin no feedback.
  const search = new URLSearchParams();
  if (aspect) {
    search.set("aspect", aspect);
  }
  if (scope !== "global") {
    search.set("scope", scope);
    if (scope === "cat" && cat) search.set("cat", cat);
    if (scope === "story" && story) search.set("story", story);
  }
  search.set("saved", "1");
  redirect(`/admin/templates?${search.toString()}`);
}

// --- intro/outro segment actions (Wave 3 Phase 4) ---------------------------
// Upload, set-active, enable/disable, rename, delete, and per-story override.
// Each action runs requireAdmin and validates inputs before touching state.
// Errors surface to the page through a ?error= search param on the redirect
// so the admin sees what went wrong without a thrown 500.

function parseKind(raw: unknown): SegmentKind | null {
  return raw === "intro" || raw === "outro" ? raw : null;
}

function redirectToSegments(params?: Record<string, string>): never {
  const search = new URLSearchParams(params);
  const qs = search.toString();
  redirect(qs ? `/admin/segments?${qs}` : "/admin/segments");
}

// uploadSegmentAction was the original Server-Action-based uploader. It
// failed in prod because Vercel caps Function request bodies at 4.5 MB and
// videos are 5-500 MB. Replaced by /api/admin/segments/sign-upload + a
// direct browser->GCS resumable PUT (see SegmentUploadForm.tsx). Ffmpeg
// normalize moved off-Vercel into pipeline/segments_worker.py.

export async function setActiveSegmentAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const kind = parseKind(formData.get("kind"));
  if (!kind) redirectToSegments({ error: "missing-kind" });
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToSegments({ error: "missing-id" });
  const seg = await getSegment(id);
  if (!seg || seg.kind !== kind) {
    redirectToSegments({ error: "segment-not-found" });
  }
  // Write the slot matching the segment's OWN aspect (coalescing a NULL column
  // to the 9:16 floor), never a requested one — so a 9:16 and a 16:9 segment
  // each fill their own slot and can both be live.
  const aspect = isVideoAspect(seg!.aspect) ? seg!.aspect : LEGACY_DEFAULT_ASPECT;
  await setSetting(activeSegmentSettingKey(kind, aspect), id);
  console.info(`[admin segments] set-active kind=${kind} aspect=${aspect} id=${id}`);
  revalidatePath("/admin/segments");
  revalidatePath("/admin/settings");
  redirectToSegments({ active: id });
}

export async function setSegmentEnabledAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled") ?? "") === "1";
  if (!id) redirectToSegments({ error: "missing-id" });
  await setSegmentEnabled(id, enabled);
  console.info(`[admin segments] enabled id=${id} -> ${enabled}`);
  revalidatePath("/admin/segments");
  redirectToSegments();
}

export async function renameSegmentAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToSegments({ error: "missing-id" });
  const label = sanitizeLabel(String(formData.get("label") ?? ""));
  await updateSegmentLabel(id, label);
  console.info(`[admin segments] rename id=${id} label=${label.slice(0, 40)}`);
  revalidatePath("/admin/segments");
  redirectToSegments();
}

export async function deleteSegmentAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToSegments({ error: "missing-id" });
  const seg = await getSegment(id);
  if (!seg) {
    redirectToSegments({ error: "segment-not-found" });
  }
  // Clear any active pointer that names this id, otherwise the next render
  // would try a deleted id and fall back to no intro/outro silently. Check
  // both per-aspect slots (a worker re-probe could have moved the segment's
  // aspect after it was set active) plus the vestigial legacy key. Also clear
  // any per-story override that pinned this id so those stories revert to "use
  // the active segment for their aspect".
  const kind = seg!.kind as SegmentKind;
  let clearedActive = false;
  for (const aspect of VIDEO_ASPECTS) {
    const key = activeSegmentSettingKey(kind, aspect);
    if ((await getSetting(key)) === id) {
      await setSetting(key, "");
      clearedActive = true;
    }
  }
  const legacyKey = legacyActiveSegmentSettingKey(kind);
  if ((await getSetting(legacyKey)) === id) {
    await setSetting(legacyKey, "");
    clearedActive = true;
  }
  const overrideCol =
    kind === "intro" ? "intro_segment_id" : "outro_segment_id";
  await run(
    `UPDATE stories SET ${overrideCol} = NULL WHERE ${overrideCol} = ?`,
    [id],
  );
  await deleteSegment(id);
  console.info(
    `[admin segments] delete kind=${kind} id=${id} cleared_active=${clearedActive}`,
  );
  revalidatePath("/admin/segments");
  revalidatePath("/admin/settings");
  redirectToSegments({ deleted: id });
}

export async function setStoryOverrideAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const storyId = String(formData.get("story_id") ?? "");
  const kind = parseKind(formData.get("kind"));
  const pick = String(formData.get("pick") ?? "inherit");
  if (!storyId || !kind) {
    redirect(`/admin/stories/${storyId}?error=missing-fields`);
  }
  await setStorySegmentOverride(storyId, kind, pick);
  console.info(
    `[admin story-edit] override kind=${kind} story=${storyId} pick=${pick}`,
  );
  revalidatePath(`/admin/stories/${storyId}`);
  redirect(`/admin/stories/${storyId}`);
}

// Phase 3 of _plans/2026-06-14-voiceover-picker.md. Persists the
// per-story voice override the picker selected. Validates the chosen
// (provider, voice_id) against the live library so a tampered form
// value can't smuggle a free-text id into the DB (rule 13 — never
// trust the client). The empty/"reset" path clears both columns so
// the resolution chain falls back to the admin global setting.
export async function setStoryVoiceAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
}> {
  await requireAdmin();
  const storyId = String(formData.get("story_id") ?? "");
  const rawProvider = String(formData.get("voice_provider") ?? "");
  const rawVoiceId = String(formData.get("voice_id") ?? "");
  if (!storyId) {
    return { ok: false, error: "missing story_id" };
  }
  // Empty or "reset" sentinel -> clear both columns (use global default).
  // Treating an unset provider as a reset matches the picker's "Use
  // global default" affordance — the form submits with empty inputs.
  if (!rawProvider) {
    await setStoryVoice(storyId, null, null);
    console.info("[stories action] voice reset", { story_id: storyId });
    revalidatePath(`/admin/stories/${storyId}`);
    revalidatePath(`/admin/videos/${storyId}`);
    return { ok: true };
  }
  // Validate against the live library — a free-text provider/voice_id
  // would let an admin form-edit a value the picker never showed. The
  // library is cheap (24h memoized after the first call).
  const { listVoices } = await import("@/lib/voice-library");
  const voices = await listVoices();
  const match = voices.find(
    (v) => v.provider === rawProvider && v.voice_id === rawVoiceId,
  );
  if (!match) {
    console.warn("[stories action] voice rejected", {
      story_id: storyId,
      rawProvider,
      rawVoiceId,
    });
    return { ok: false, error: "unknown voice" };
  }
  await setStoryVoice(storyId, match.provider, match.voice_id);
  console.info("[stories action] voice", {
    story_id: storyId,
    provider: match.provider,
    voice_id: match.voice_id,
  });
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true };
}

// Phase 4 of _plans/2026-06-14-voiceover-picker.md. Enqueues a
// voice_renders row so the local Python worker (or, eventually, the
// Vercel cron drain) can synthesize the new audio against the story's
// body text using the per-story voice override + global setting
// fallback chain.
//
// The action is a thin orchestrator: validate, read the story row's
// snapshot, hand off to the queue helper. The heavy lifting (TTS,
// caption rebuild, GCS upload, three-column atomic write to stories)
// lives on the Python side in pipeline/voice_renders_worker.py — same
// architectural seam the image_renders + story_jobs queues use.
export async function regenerateVoiceoverAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  renderId?: string;
}> {
  const session = await requireAdmin();
  const storyId = String(formData.get("story_id") ?? "");
  if (!storyId) {
    return { ok: false, error: "missing story_id" };
  }
  const story = await getStoryRow(storyId);
  if (!story) {
    return { ok: false, error: "story not found" };
  }
  const body = (story.body ?? "").trim();
  if (!body) {
    return { ok: false, error: "story has no body to synthesize" };
  }
  // Snapshot the per-story override at enqueue time. If the picker
  // changes the override after enqueue but before claim, the worker
  // STILL processes with the snapshotted values — the regen the user
  // asked for is the regen the worker performs. Mid-flight override
  // swap would be a confusing race.
  const { enqueueVoiceRender } = await import("@/lib/voice-render-queue");
  let result: Awaited<ReturnType<typeof enqueueVoiceRender>>;
  try {
    result = await enqueueVoiceRender({
      storyId,
      body,
      voiceProvider: story.voice_provider,
      voiceId: story.voice_id,
      requestedBy: session.userId,
    });
  } catch (e) {
    // A DB error here (e.g. the ON CONFLICT partial unique index missing in
    // an under-migrated environment) must NOT throw out of the server
    // action — an uncaught throw drops the whole editor into Next's error
    // boundary ("This page couldn't load"). Return a friendly inline message
    // the picker surfaces instead, and log the real cause for the operator.
    console.error("[voice regen action] enqueue threw", {
      story_id: storyId,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      ok: false,
      error: "Could not queue the voiceover. Please try again in a moment.",
    };
  }
  if (!result.ok) {
    console.warn("[voice regen action] enqueue failed", {
      story_id: storyId,
      error: result.error,
    });
    return { ok: false, error: result.error };
  }
  console.info("[voice regen action] enqueued", {
    story_id: storyId,
    render_id: result.renderId,
    voice_provider: story.voice_provider,
    voice_id: story.voice_id,
    requested_by: session.userId,
  });
  revalidatePath(`/admin/stories/${storyId}`);
  revalidatePath(`/admin/videos/${storyId}`);
  return { ok: true, renderId: result.renderId };
}

// --- articles CMS actions (Phase 1) ----------------------------------------
// All four actions follow the existing admin pattern: requireAdmin first,
// validate input close to the data, log a single line per outcome, then
// revalidate the touched paths. Errors that the editor can recover from
// surface via ?error= on the redirect target rather than throwing.

function redirectToArticles(params?: Record<string, string>): never {
  const search = new URLSearchParams(params);
  const qs = search.toString();
  redirect(qs ? `/admin/articles?${qs}` : "/admin/articles");
}

function redirectToArticle(id: string, params?: Record<string, string>): never {
  const search = new URLSearchParams(params);
  const qs = search.toString();
  redirect(qs ? `/admin/articles/${id}?${qs}` : `/admin/articles/${id}`);
}

export async function createArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const user = await currentUser();
  const type = formData.get("type");
  const language = formData.get("language");
  const title = String(formData.get("title") ?? "").trim();
  if (!isArticleType(type)) redirectToArticles({ error: "bad-type" });
  if (!isArticleLanguage(language)) redirectToArticles({ error: "bad-language" });
  if (!title) redirectToArticles({ error: "missing-title" });

  const id = randomUUID();
  const slug = slugifyTitle(title, id);
  await createArticle({
    id,
    type,
    language,
    slug,
    title,
    author_id: user?.id ?? null,
  });
  console.info("[articles action] create", {
    id,
    type,
    language,
    slug,
    titleLen: title.length,
  });
  // 2026-06-18 polls plan extension: every article must have a poll
  // row by default. On create the body is empty so the autodraft
  // service inserts the category preset as a disabled draft —
  // saveArticleAction calls the same service again once the editor
  // has real content, which promotes the draft to enabled=1 via the
  // LLM. Best-effort: any failure logs and the article create still
  // succeeds (we never block the redirect on poll generation).
  try {
    const { autoDraftPollForSubject } = await import("@/lib/poll-autodraft");
    await autoDraftPollForSubject({
      kind: "article",
      articleId: id,
      title,
      bodyText: "",
      type,
    });
  } catch (err) {
    console.warn("[articles action] autodraft failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  revalidatePath("/admin/articles");
  redirect(`/admin/articles/${id}`);
}

export async function saveArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const user = await currentUser();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToArticles({ error: "missing-id" });

  const article = await getArticle(id);
  if (!article) redirectToArticles({ error: "not-found" });

  // Document is the Tiptap JSON serialized by the editor on submit. We do not
  // try to re-validate the JSON structure here — that's the editor's job;
  // a malformed document is recovered by the read path (Phase 2 will surface
  // a "needs repair" view rather than crash the editor).
  const document = String(formData.get("document") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const subtitle = String(formData.get("subtitle") ?? "").trim();
  const summary = String(formData.get("summary") ?? "").trim();
  const heroImage = String(formData.get("hero_image") ?? "").trim();

  await updateArticle(id, {
    title: title || null,
    subtitle: subtitle || null,
    summary: summary || null,
    hero_image: heroImage || null,
    document: document || article.document,
  });

  // Append a revision so the autosave trail starts populating from day one.
  // Coalescing in repo collapses fast-fire saves into a single row.
  const revisionId = randomUUID();
  const { coalesced } = await appendRevision({
    id: revisionId,
    article_id: id,
    document: document || article.document || "{}",
    payload: article.payload ?? "{}",
    title: title || article.title || "",
    status: article.status ?? "draft",
    author_id: user?.id ?? null,
  });
  console.info("[articles action] save", {
    id,
    titleLen: title.length,
    docLen: document.length,
    revisionId,
    coalesced,
  });
  // 2026-06-18 polls plan extension: try to upgrade an article's
  // disabled-draft poll to an LLM-drafted enabled poll now that the
  // editor save has populated real content. The autodraft service
  // skips admin-saved (enabled=1) polls and only acts on the draft
  // case. Best-effort: any error logs and the save still succeeds.
  try {
    const docForExtract = document || article.document || null;
    const { autoDraftPollForSubject, tiptapToPlainText } =
      await import("@/lib/poll-autodraft");
    const bodyText = tiptapToPlainText(docForExtract);
    // Only worth attempting when there's a meaningful body to read.
    // Sub-50-char bodies almost always produce LLM rejection; skip
    // so we don't burn cycles on every keystroke autosave.
    if (bodyText.length >= 50) {
      await autoDraftPollForSubject({
        kind: "article",
        articleId: id,
        title: title || article.title,
        bodyText,
        type: article.type,
      });
    }
  } catch (err) {
    console.warn("[articles action] autodraft upgrade failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath("/admin/articles");
  redirectToArticle(id, { saved: "1" });
}

export async function setArticleStatusAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as ArticleStatus;
  if (!id) redirectToArticles({ error: "missing-id" });
  if (
    status !== "draft" &&
    status !== "review" &&
    status !== "published" &&
    status !== "archived"
  ) {
    redirectToArticle(id, { error: "bad-status" });
  }
  // Publish guard: every image block must carry alt text. The editor surfaces
  // a warning band on missing-alt images so the writer sees the problem
  // before they hit publish; this is the load-bearing server check.
  if (status === "published") {
    const article = await getArticle(id);
    if (!article) redirectToArticles({ error: "not-found" });
    let doc: unknown = null;
    try {
      doc = article!.document ? JSON.parse(article!.document) : null;
    } catch {
      doc = null;
    }
    const missing =
      countImagesMissingAlt(doc) + countGalleryImagesMissingAlt(doc);
    if (missing > 0) {
      console.info("[articles action] publish-blocked alt-missing", {
        id,
        missing,
      });
      redirectToArticle(id, {
        error: `alt-missing-${missing}`,
      });
    }
  }
  await setArticleStatus(id, status);
  console.info("[articles action] status", { id, status });
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath("/admin/articles");
  revalidatePath("/admin/content");
  redirectToArticle(id, { status: "saved" });
}

export async function setArticleNoindexAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const noindex = String(formData.get("noindex") ?? "") === "1";
  if (!id) redirectToArticles({ error: "missing-id" });
  await setArticleNoindex(id, noindex);
  console.info("[articles action] noindex", { id, noindex });
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath(`/articles`, "layout");
  redirectToArticle(id, { noindex: noindex ? "on" : "off" });
}

// Slug change runs the per-language uniqueness check before writing. The
// editor surfaces an `?error=slug-taken` query param so the SEO panel can
// flag the collision without losing the user's input.
export async function updateArticleSlugAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const slug = String(formData.get("slug") ?? "").trim();
  if (!id) redirectToArticles({ error: "missing-id" });
  if (!/^[a-z0-9-]+$/.test(slug)) {
    redirectToArticle(id, { error: "bad-slug" });
  }
  const article = await getArticle(id);
  if (!article) redirectToArticles({ error: "not-found" });
  const language = (article.language ?? "en") as ArticleLanguage;
  const available = await checkSlugAvailable(language, slug, id);
  if (!available) redirectToArticle(id, { error: "slug-taken" });
  await updateArticleSlug(id, slug);
  console.info("[articles action] update-slug", { id, slug, language });
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath("/admin/articles");
  redirectToArticle(id, { slug: "saved" });
}

// Save the type-specific payload. The form serializes a flat shape; we
// reassemble + validate per type before writing. The sidebar carries a
// hidden `__type` so the action picks the right schema without re-reading
// the article — we still cross-check it against the stored type and refuse
// a mismatch, which would otherwise let a swapped form post a payload that
// the reader can't interpret.
export async function updateArticlePayloadAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToArticles({ error: "missing-id" });
  const article = await getArticle(id);
  if (!article) redirectToArticles({ error: "not-found" });
  const claimedType = String(formData.get("__type") ?? "");
  if (!isArticleType(claimedType)) {
    redirectToArticle(id, { error: "bad-type" });
  }
  if (article!.type !== claimedType) {
    // Hard reject: the form was generated for a different type than the row
    // currently is. Either a stale tab or a tampered form; either way we
    // refuse the write and tell the editor to reload.
    redirectToArticle(id, { error: "type-mismatch" });
  }
  const type = claimedType as ArticleType;

  // Per-type parse. We build a plain object from the FormData keys the
  // sidebar emits — keys are namespaced under "payload." so a future SEO
  // tab can share the form without collision.
  function field(name: string): string {
    return String(formData.get(`payload.${name}`) ?? "");
  }
  function fieldList(name: string): string[] {
    // The sidebar emits repeated fields for arrays (pros / cons / item.*).
    // FormData.getAll preserves order, which the schemas care about.
    return formData.getAll(`payload.${name}`).map((v) => String(v ?? ""));
  }

  let parsed: unknown;
  try {
    switch (type) {
      case "news":
        parsed = NewsPayloadSchema.parse({
          datelineLocation: field("datelineLocation"),
          datelineDate: field("datelineDate"),
          sourceUrl: field("sourceUrl"),
          sourceLabel: field("sourceLabel"),
        });
        break;
      case "feature":
        parsed = FeaturePayloadSchema.parse({
          authorByline: field("authorByline"),
          readingTimeMinutes: field("readingTimeMinutes") || 0,
        });
        break;
      case "listicle": {
        // Items arrive as parallel arrays — title[i], body[i], imageUrl[i],
        // imageAlt[i], rank[i]. Reassemble row-by-row so the schema can
        // validate each item's caps independently.
        const titles = fieldList("item.title");
        const bodies = fieldList("item.body");
        const urls = fieldList("item.imageUrl");
        const alts = fieldList("item.imageAlt");
        const ranks = fieldList("item.rank");
        const items = titles.map((title, i) => ({
          rank: Number(ranks[i] ?? i + 1) || i + 1,
          title,
          body: bodies[i] ?? "",
          imageUrl: urls[i] ?? "",
          imageAlt: alts[i] ?? "",
        }));
        parsed = ListiclePayloadSchema.parse({
          items,
          countdownOrder: field("countdownOrder") === "on",
        });
        break;
      }
      case "review":
        parsed = ReviewPayloadSchema.parse({
          rating: field("rating") || 0,
          verdict: field("verdict"),
          // Filter blank-after-trim entries so an empty extra row doesn't
          // pollute the bullets list.
          pros: fieldList("pros").filter((s) => s.trim()),
          cons: fieldList("cons").filter((s) => s.trim()),
        });
        break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[articles action] payload-validation FAILED", {
      id,
      type,
      msg: msg.slice(0, 200),
    });
    redirectToArticle(id, { error: "bad-payload" });
  }

  await updateArticle(id, { payload: JSON.stringify(parsed) });
  console.info("[articles action] payload-save", { id, type });
  revalidatePath(`/admin/articles/${id}`);
  redirectToArticle(id, { payload: "saved" });
}

// Save the SEO panel: slug + meta_title + meta_description + og_image in
// one go. Slug uses its dedicated writer because of the per-language
// collision check; the metadata fields are in ARTICLE_EDITABLE so the
// regular updateArticle path covers them. Both validations run before any
// write so a slug failure does not half-commit the metadata change.
export async function updateArticleSeoAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToArticles({ error: "missing-id" });
  const article = await getArticle(id);
  if (!article) redirectToArticles({ error: "not-found" });

  const language = (article!.language ?? "en") as ArticleLanguage;
  const newSlug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const metaTitle = String(formData.get("meta_title") ?? "").trim();
  const metaDescription = String(formData.get("meta_description") ?? "").trim();
  const ogImage = String(formData.get("og_image") ?? "").trim();

  // Slug shape + uniqueness, but only when it has actually changed —
  // otherwise a save with the writer's own current slug would needlessly
  // pay the collision check.
  if (newSlug && newSlug !== article!.slug) {
    if (!isValidSlugShape(newSlug)) {
      redirectToArticle(id, { error: "bad-slug" });
    }
    const available = await checkSlugAvailable(language, newSlug, id);
    if (!available) {
      redirectToArticle(id, { error: "slug-taken" });
    }
    await updateArticleSlug(id, newSlug);
  }

  // OG image is optional but must be http(s) when present; metadata fields
  // get character-cap guards too so a paste of an entire essay into the
  // description field can't bloat the row.
  if (ogImage && !/^https?:\/\//.test(ogImage)) {
    redirectToArticle(id, { error: "bad-og-image" });
  }
  if (metaTitle.length > 200 || metaDescription.length > 500) {
    redirectToArticle(id, { error: "meta-too-long" });
  }

  await updateArticle(id, {
    meta_title: metaTitle || null,
    meta_description: metaDescription || null,
    og_image: ogImage || null,
  });
  console.info("[articles seo] save", {
    id,
    slugChanged: newSlug !== article!.slug,
    metaTitleLen: metaTitle.length,
    metaDescLen: metaDescription.length,
    hasOgImage: Boolean(ogImage),
  });
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath("/admin/articles");
  redirectToArticle(id, { seo: "saved" });
}

// --- Sheets bootstrap import (Phase 3 slice 2) ----------------------------
// Two actions. previewSheetImport parses the URL, validates the env, and
// redirects to the import page in "preview" mode so the page can render
// headers + sample rows + the column mapper. commitSheetImport runs the
// actual inserts; it's idempotent via source_sheet_row_id so the writer
// can fix a typo in the sheet and re-import without double-creating rows.

const IMPORT_PREVIEW_LIMIT = 5;
const IMPORT_COMMIT_LIMIT = 200;

function redirectToImport(params?: Record<string, string>): never {
  const search = new URLSearchParams(params);
  const qs = search.toString();
  redirect(qs ? `/admin/articles/import?${qs}` : "/admin/articles/import");
}

export async function previewSheetImportAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  if (!isSheetsConfigured()) {
    redirectToImport({ error: "sheets-not-configured" });
  }
  const url = String(formData.get("sheetUrl") ?? "").trim();
  const ref = parseSheetRef(url);
  if (!ref) redirectToImport({ error: "bad-url" });
  console.info("[articles sheets-import] preview-requested", {
    spreadsheetId: ref!.spreadsheetId,
    gidFromUrl: ref!.gid,
  });
  const params: Record<string, string> = {
    spreadsheet_id: ref!.spreadsheetId,
  };
  // The chosen tab arrives via the form's `tab` field; if blank we let the
  // import page fall back to the URL's gid or the first tab.
  const tab = String(formData.get("tab") ?? "").trim();
  if (tab) params.tab = tab;
  else if (ref!.gid !== null) params.gid = String(ref!.gid);
  redirectToImport(params);
}

interface CommitMapping {
  titleHeader: string;
  summaryHeader: string;
  bodyHeader: string;
  rowIdHeader: string;
}

export async function commitSheetImportAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  if (!isSheetsConfigured()) {
    redirectToImport({ error: "sheets-not-configured" });
  }
  const spreadsheetId = String(formData.get("spreadsheet_id") ?? "").trim();
  if (!spreadsheetId) redirectToImport({ error: "missing-spreadsheet-id" });
  const rawTab = String(formData.get("tab") ?? "").trim();
  const rawGid = String(formData.get("gid") ?? "").trim();
  // tab title takes precedence over gid when both are present — the import
  // page passes the user's pick as `tab`. gid is a fallback from the URL.
  const tabIdentifier: string | number = rawTab
    ? rawTab
    : rawGid
      ? Number(rawGid)
      : "";
  if (tabIdentifier === "") redirectToImport({ error: "missing-tab" });

  const type = String(formData.get("article_type") ?? "");
  const language = String(formData.get("article_language") ?? "");
  if (!isArticleType(type)) redirectToImport({ error: "bad-type" });
  if (!isArticleLanguage(language)) redirectToImport({ error: "bad-language" });

  const mapping: CommitMapping = {
    titleHeader: String(formData.get("col_title") ?? "").trim(),
    summaryHeader: String(formData.get("col_summary") ?? "").trim(),
    bodyHeader: String(formData.get("col_body") ?? "").trim(),
    rowIdHeader: String(formData.get("col_row_id") ?? "").trim(),
  };
  if (!mapping.titleHeader) redirectToImport({ error: "missing-title-column" });

  // Read the rows fresh. We deliberately do NOT trust any preview cached on
  // the page — by the time the user clicks Confirm the spreadsheet may have
  // changed, and we want to import whatever's there NOW.
  let sheet;
  try {
    sheet = await readRows(spreadsheetId, tabIdentifier, {
      limit: IMPORT_COMMIT_LIMIT,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[articles sheets-import] read FAILED:", msg);
    redirectToImport({ error: "sheets-read-failed" });
  }

  const headerIndex: Record<string, number> = {};
  sheet!.headers.forEach((h, i) => {
    headerIndex[h] = i;
  });
  const titleIdx = headerIndex[mapping.titleHeader];
  if (titleIdx === undefined) {
    redirectToImport({ error: "title-column-not-in-sheet" });
  }
  const summaryIdx = mapping.summaryHeader
    ? headerIndex[mapping.summaryHeader]
    : undefined;
  const bodyIdx = mapping.bodyHeader
    ? headerIndex[mapping.bodyHeader]
    : undefined;
  const rowIdIdx = mapping.rowIdHeader
    ? headerIndex[mapping.rowIdHeader]
    : undefined;

  let inserted = 0;
  let skippedExisting = 0;
  let skippedNoTitle = 0;

  for (const row of sheet!.rows) {
    const title = (row[titleIdx] ?? "").trim();
    if (!title) {
      skippedNoTitle++;
      continue;
    }
    const rowKey =
      rowIdIdx !== undefined && row[rowIdIdx]
        ? row[rowIdIdx].trim()
        : title;
    const sourceRowId = stableRowId({ spreadsheetId, rowKey });
    const existing = await getArticleBySourceSheetRowId(sourceRowId);
    if (existing) {
      skippedExisting++;
      continue;
    }
    const summary = summaryIdx !== undefined ? (row[summaryIdx] ?? "").trim() : "";
    const bodyText = bodyIdx !== undefined ? (row[bodyIdx] ?? "").trim() : "";
    // Body is wrapped in a Tiptap doc with one paragraph per non-empty line.
    // Sheets cells often contain free-form prose with line breaks; preserving
    // them as separate paragraphs is closer to what the writer expects when
    // the article opens in the editor.
    const lines = bodyText ? bodyText.split(/\r?\n/).filter((l) => l.trim()) : [];
    const document = JSON.stringify(
      lines.length === 0
        ? { type: "doc", content: [{ type: "paragraph" }] }
        : {
            type: "doc",
            content: lines.map((line) => ({
              type: "paragraph",
              content: [{ type: "text", text: line }],
            })),
          },
    );
    const newId = randomUUID();
    await createArticle({
      id: newId,
      type,
      language,
      slug: slugifyTitle(title, newId),
      title,
      author_id: null,
      summary: summary || null,
      document,
      source_sheet_row_id: sourceRowId,
    });
    inserted++;
  }

  console.info("[articles sheets-import] commit", {
    spreadsheetId,
    tab: typeof tabIdentifier === "string" ? tabIdentifier : `gid:${tabIdentifier}`,
    inserted,
    skippedExisting,
    skippedNoTitle,
    type,
    language,
  });

  revalidatePath("/admin/articles");
  revalidatePath("/admin/content");
  redirect(
    `/admin/articles?imported=${inserted}` +
      (skippedExisting > 0 ? `&skipped=${skippedExisting}` : ""),
  );
}

// --- revisions (Phase 5 slice 1) -------------------------------------------
// Three actions cover the writer's revision workflow:
//   nameRevision -> promote a snapshot with a writer-supplied label
//   unnameRevision -> demote (label clears, retention can take it)
//   restoreRevision -> write the snapshot's document back onto the article
//                      and append a fresh revision marking the restore
//
// Restore is the load-bearing one: we don't replace the in-row document
// silently — appending a new revision means the writer can undo the
// undo just by restoring whatever was current before the restore landed.

export async function nameRevisionAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const articleId = String(formData.get("article_id") ?? "");
  const revisionId = String(formData.get("revision_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!articleId || !revisionId) {
    redirectToArticles({ error: "missing-id" });
  }
  if (!name) {
    redirect(
      `/admin/articles/${articleId}/history/${revisionId}?error=missing-name`,
    );
  }
  await nameRevision(revisionId, name);
  console.info("[articles action] name-revision", { articleId, revisionId });
  revalidatePath(`/admin/articles/${articleId}/history`);
  revalidatePath(`/admin/articles/${articleId}/history/${revisionId}`);
  redirect(
    `/admin/articles/${articleId}/history/${revisionId}?named=1`,
  );
}

export async function unnameRevisionAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const articleId = String(formData.get("article_id") ?? "");
  const revisionId = String(formData.get("revision_id") ?? "");
  if (!articleId || !revisionId) {
    redirectToArticles({ error: "missing-id" });
  }
  await unnameRevision(revisionId);
  console.info("[articles action] unname-revision", { articleId, revisionId });
  revalidatePath(`/admin/articles/${articleId}/history`);
  revalidatePath(`/admin/articles/${articleId}/history/${revisionId}`);
  redirect(
    `/admin/articles/${articleId}/history/${revisionId}?unnamed=1`,
  );
}

export async function restoreRevisionAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const user = await currentUser();
  const articleId = String(formData.get("article_id") ?? "");
  const revisionId = String(formData.get("revision_id") ?? "");
  if (!articleId || !revisionId) {
    redirectToArticles({ error: "missing-id" });
  }
  const [article, revision] = await Promise.all([
    getArticle(articleId),
    getRevision(revisionId),
  ]);
  if (!article) redirectToArticles({ error: "not-found" });
  if (!revision || revision.article_id !== articleId) {
    redirect(`/admin/articles/${articleId}/history?error=revision-mismatch`);
  }
  // Append a revision capturing the CURRENT state BEFORE overwriting so the
  // writer can undo the restore. Coalescing window doesn't apply here — we
  // force an insert with coalesceWindowSec=0 because a restore is a
  // deliberate action that should never be silently merged into a draft.
  await appendRevision({
    id: randomUUID(),
    article_id: articleId,
    document: article!.document ?? "{}",
    payload: article!.payload ?? "{}",
    title: article!.title ?? "",
    status: article!.status ?? "draft",
    author_id: user?.id ?? null,
    coalesceWindowSec: 0,
  });
  // Now write the restored document onto the article. updateArticle pushes
  // updated_at; we deliberately don't touch published_at — the public reader
  // shouldn't see a "republished" timestamp on what is editorially the same
  // piece moved backwards in history.
  await updateArticle(articleId, {
    document: revision!.document ?? "{}",
    payload: revision!.payload ?? "{}",
    title: revision!.title ?? article!.title ?? "",
  });
  // Then mark the restore in the trail by appending another revision; the
  // name field carries the marker so the history list shows it explicitly.
  const markerId = randomUUID();
  await appendRevision({
    id: markerId,
    article_id: articleId,
    document: revision!.document ?? "{}",
    payload: revision!.payload ?? "{}",
    title: revision!.title ?? article!.title ?? "",
    status: article!.status ?? "draft",
    author_id: user?.id ?? null,
    coalesceWindowSec: 0,
  });
  await nameRevision(
    markerId,
    `Restored from ${revision!.created_at?.slice(0, 16) ?? "earlier"}`,
  );
  console.info("[articles action] restore-revision", {
    articleId,
    revisionId,
    markerId,
  });
  revalidatePath(`/admin/articles/${articleId}`);
  revalidatePath(`/admin/articles/${articleId}/history`);
  redirect(`/admin/articles/${articleId}?restored=1`);
}

// Manual prune trigger from the history page. Keeps the latest 50 unnamed
// plus every named revision. The default cap matches the plan; a future
// settings entry can override.
export async function pruneRevisionsAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const articleId = String(formData.get("article_id") ?? "");
  if (!articleId) redirectToArticles({ error: "missing-id" });
  const removed = await pruneRevisions(articleId, 50);
  console.info("[articles action] prune-revisions", { articleId, removed });
  revalidatePath(`/admin/articles/${articleId}/history`);
  redirect(`/admin/articles/${articleId}/history?pruned=${removed}`);
}

export async function deleteArticleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) redirectToArticles({ error: "missing-id" });
  const article = await getArticle(id);
  if (!article) redirectToArticles({ error: "not-found" });
  // Hard delete is only allowed on archived rows. Anything else is a
  // soft-delete (status='archived') via setArticleStatusAction, matching how
  // the segments delete guards against accidental data loss.
  if (article.status !== "archived") {
    redirectToArticle(id, { error: "not-archived" });
  }
  await deleteArticle(id);
  console.info("[articles action] delete", { id });
  revalidatePath("/admin/articles");
  redirectToArticles({ deleted: id });
}

// --- Article scenes from short_render (2026-06-15) ---------------------------
// Plan: _plans/2026-06-15-shorts-to-article-media.md
//
// Seven actions back the "borrow scene images from the linked story's short"
// feature: one link/unlink, three promote-frame (hero / og / gallery), three
// revert (the 10 s undo affordance the panel surfaces after each promote).
//
// Security pattern: promote-frame actions take a frame_id (not a URL) and
// resolve the URL server-side via getLinkedShortFrame. The action refuses any
// frame_id that is not in the linked render's current props, so a client
// cannot inject an arbitrary URL into hero_image / og_image / gallery through
// this surface. The revert actions accept the previous value as-is — they are
// admin-only and the equivalent field is already writable via saveArticleAction,
// so no new attack surface is opened.

export async function setArticleStoryIdAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
  previousStoryId?: string | null;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const rawStoryId = String(formData.get("story_id") ?? "");
  const storyId = rawStoryId.trim() === "" ? null : rawStoryId.trim();
  if (!id) return { ok: false, error: "missing id" };
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  if (storyId !== null) {
    const story = await getStoryRow(storyId);
    if (!story) return { ok: false, error: "story not found" };
  }
  const previousStoryId = article.story_id ?? null;
  await setArticleStoryId(id, storyId);
  console.info("[article-media link-story]", {
    articleId: id,
    storyId,
    previousStoryId,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true, previousStoryId };
}

export async function setArticleHeroFromFrameAction(
  formData: FormData,
): Promise<{
  ok: boolean;
  error?: string;
  frameUrl?: string;
  previousUrl?: string | null;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const frameId = String(formData.get("frame_id") ?? "");
  if (!id) return { ok: false, error: "missing id" };
  if (!frameId) return { ok: false, error: "missing frame_id" };
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  const frame = await getLinkedShortFrame(id, frameId);
  if (!frame) return { ok: false, error: "frame not found in linked short" };
  const previousUrl = article.hero_image ?? null;
  await updateArticle(id, { hero_image: frame.url });
  console.info("[article-media set-hero]", {
    articleId: id,
    frameId: frame.id,
    frameUrl: frame.url,
    previousUrl,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true, frameUrl: frame.url, previousUrl };
}

export async function setArticleOgFromFrameAction(
  formData: FormData,
): Promise<{
  ok: boolean;
  error?: string;
  frameUrl?: string;
  previousUrl?: string | null;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const frameId = String(formData.get("frame_id") ?? "");
  if (!id) return { ok: false, error: "missing id" };
  if (!frameId) return { ok: false, error: "missing frame_id" };
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  const frame = await getLinkedShortFrame(id, frameId);
  if (!frame) return { ok: false, error: "frame not found in linked short" };
  const previousUrl = article.og_image ?? null;
  await updateArticle(id, { og_image: frame.url });
  console.info("[article-media set-og]", {
    articleId: id,
    frameId: frame.id,
    frameUrl: frame.url,
    previousUrl,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true, frameUrl: frame.url, previousUrl };
}

export async function addArticleGalleryImageFromFrameAction(
  formData: FormData,
): Promise<{
  ok: boolean;
  error?: string;
  frameUrl?: string;
  previousDocument?: string | null;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const frameId = String(formData.get("frame_id") ?? "");
  const rawAlt = String(formData.get("alt") ?? "").trim();
  if (!id) return { ok: false, error: "missing id" };
  if (!frameId) return { ok: false, error: "missing frame_id" };
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  const frame = await getLinkedShortFrame(id, frameId);
  if (!frame) return { ok: false, error: "frame not found in linked short" };
  const previousDocument = article.document ?? null;
  let parsed: unknown = null;
  if (previousDocument) {
    try {
      parsed = JSON.parse(previousDocument);
    } catch {
      // A malformed document can't be safely appended to without losing data.
      // The admin should fix it via the editor first.
      console.warn("[article-media add-gallery] doc-unparseable", {
        articleId: id,
      });
      return { ok: false, error: "article document is unparseable" };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    // No document yet — refuse rather than seed a brand-new doc; the editor's
    // own first-save flow owns initial document creation.
    return { ok: false, error: "article has no document to append to" };
  }
  const next = appendArticleGalleryItem(parsed, {
    src: frame.url,
    alt: rawAlt,
    caption: "",
  });
  await updateArticle(id, { document: JSON.stringify(next) });
  console.info("[article-media add-gallery]", {
    articleId: id,
    frameId: frame.id,
    frameUrl: frame.url,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true, frameUrl: frame.url, previousDocument };
}

export async function revertArticleHeroAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const raw = formData.get("previous_url");
  if (!id) return { ok: false, error: "missing id" };
  const previousUrl =
    raw === null || raw === "" ? null : String(raw);
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  await updateArticle(id, { hero_image: previousUrl });
  console.info("[article-media revert-hero]", {
    articleId: id,
    restoredTo: previousUrl,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true };
}

export async function revertArticleOgAction(formData: FormData): Promise<{
  ok: boolean;
  error?: string;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const raw = formData.get("previous_url");
  if (!id) return { ok: false, error: "missing id" };
  const previousUrl =
    raw === null || raw === "" ? null : String(raw);
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  await updateArticle(id, { og_image: previousUrl });
  console.info("[article-media revert-og]", {
    articleId: id,
    restoredTo: previousUrl,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true };
}

export async function revertArticleDocumentAction(
  formData: FormData,
): Promise<{
  ok: boolean;
  error?: string;
}> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const previousDocument = formData.get("previous_document");
  if (!id) return { ok: false, error: "missing id" };
  if (typeof previousDocument !== "string") {
    return { ok: false, error: "missing previous_document" };
  }
  // Parse to confirm the supplied document is at least valid JSON — defense
  // in depth even though this surface is admin-only. A malformed revert would
  // brick the editor.
  try {
    JSON.parse(previousDocument);
  } catch {
    return { ok: false, error: "previous_document is not valid JSON" };
  }
  const article = await getArticle(id);
  if (!article) return { ok: false, error: "article not found" };
  await updateArticle(id, { document: previousDocument });
  console.info("[article-media revert-gallery]", {
    articleId: id,
    docLength: previousDocument.length,
  });
  revalidatePath(`/admin/articles/${id}`);
  return { ok: true };
}

// --- Reddit sources (2026-06-14 Reddit DB sync) ------------------------------
// Three actions back the import / browse flow:
//
//   syncRedditSourceCsvAction   — upload a CSV, parse, upsert (or preview).
//   skipRedditSourcesAction     — flip selected rows to status='skipped'.
//   reopenRedditSourcesAction   — flip selected rows back to status='imported'.
//
// The bulk "process N selected" trigger lands in Phase 3 alongside the
// pipeline worker entry. Keeping the surface small here means each action
// has a single auth + single mutation + revalidate shape; the more involved
// processing path gets its own observability story.

const REDDIT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB; current sheet is 512 KB

export interface RedditSyncResult {
  ok: boolean;
  parsed?: number;
  new?: number;
  updated?: number;
  unchanged?: number;
  errors?: number;
  warnings?: string[];
  sample_new?: string[];
  apply_ms?: number;
  error?: string;
}

export async function syncRedditSourceCsvAction(
  _prev: RedditSyncResult | null,
  formData: FormData,
): Promise<RedditSyncResult> {
  await requireAdmin();

  const file = formData.get("csv");
  const dryRun = String(formData.get("dry_run") ?? "") === "1";

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "no file uploaded" };
  }
  if (file.size > REDDIT_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: `file too large (${Math.round(file.size / 1024)} KB, max ${REDDIT_UPLOAD_MAX_BYTES / 1024 / 1024} MB)`,
    };
  }
  // Cheap content-sniff: header should be the canonical 9 fields. We don't
  // strictly require text/csv MIME — some browsers send application/vnd.ms-excel
  // for .csv. The actual parser is the source of truth on header shape.

  const text = await file.text();

  const t0 = performance.now();
  const { parseCsvText, applyParsed } = await import("@/lib/reddit-source");
  let parsedResult: ReturnType<typeof parseCsvText>;
  try {
    parsedResult = parseCsvText(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[reddit-sync parse-failed]", { error: msg });
    return { ok: false, error: msg };
  }
  const parseMs = Math.round(performance.now() - t0);

  console.info("[reddit-sync parse]", {
    rows: parsedResult.rows.length,
    warnings: parsedResult.warnings.length,
    parse_ms: parseMs,
  });

  const diff = await applyParsed(parsedResult.rows, parsedResult.warnings, {
    dryRun,
  });

  console.info("[reddit-sync apply]", {
    mode: dryRun ? "dry-run" : "live",
    new: diff.new,
    updated: diff.updated,
    unchanged: diff.unchanged,
    errors: diff.errors,
    apply_ms: diff.apply_ms,
  });

  if (!dryRun) {
    revalidatePath("/admin/reddit-sources");
  }

  return {
    ok: diff.errors === 0,
    parsed: diff.parsed,
    new: diff.new,
    updated: diff.updated,
    unchanged: diff.unchanged,
    errors: diff.errors,
    warnings: diff.warnings,
    sample_new: diff.sample_new,
    apply_ms: diff.apply_ms,
  };
}

export async function skipRedditSourcesAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const ids = formData.getAll("reddit_id").map(String).filter(Boolean);
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (ids.length === 0) return;
  const { bulkSetRedditSourceStatus } = await import("@/lib/reddit-source");
  const count = await bulkSetRedditSourceStatus(ids, "skipped", { notes });
  console.info("[reddit-sync skip]", { count, ids: ids.slice(0, 10) });
  revalidatePath("/admin/reddit-sources");
}

export async function reopenRedditSourcesAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const ids = formData.getAll("reddit_id").map(String).filter(Boolean);
  if (ids.length === 0) return;
  const { bulkSetRedditSourceStatus } = await import("@/lib/reddit-source");
  const count = await bulkSetRedditSourceStatus(ids, "imported", { notes: null });
  console.info("[reddit-sync reopen]", { count, ids: ids.slice(0, 10) });
  revalidatePath("/admin/reddit-sources");
}

// Phase 7: daily-budget cap for the story_jobs queue.
// See _plans/2026-06-14-story-jobs-followups.md Phase 7.
// Stored as integer cents in the settings table so the Python worker and
// the TS read path share a single, unit-explicit number — no floating-
// point round-trips, no dollar/cent confusion.
export async function setDailyBudgetCapAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const raw = String(formData.get("cap_usd") ?? "").trim();
  // Empty input → unset → unlimited.
  if (raw === "") {
    await setSetting("pipeline.story_jobs.daily_cap_cents", "");
    console.info("[story-jobs budget] cap-cleared");
    revalidatePath("/admin/reddit-sources");
    redirect("/admin/reddit-sources?budget_cap=cleared");
  }
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) {
    redirect("/admin/reddit-sources?error=bad-cap-value");
  }
  // A cap of exactly $0 is rejected (instead of silently becoming
  // "unlimited" via getDailyBudgetCapCents's `<= 0 → null` rule). If the
  // admin actually wants to halt all processing they should use a
  // small-but-positive cap like $0.01 — that's unambiguous and the
  // gate's `projected + next_estimate > cap` math handles it cleanly.
  if (dollars === 0) {
    redirect("/admin/reddit-sources?error=cap-must-be-positive-or-blank");
  }
  // Round to whole cents and clamp at zero. Admin types "10" or "10.50";
  // either gets normalized.
  const cents = Math.max(0, Math.round(dollars * 100));
  await setSetting("pipeline.story_jobs.daily_cap_cents", String(cents));
  console.info("[story-jobs budget] cap-set", { cents });
  revalidatePath("/admin/reddit-sources");
  redirect(`/admin/reddit-sources?budget_cap=${cents}`);
}

// Stop button. Cancels every active (queued or processing) story_job for
// the selected reddit_ids and resets their source rows to 'imported'.
// The worker keeps running its current LLM/image call (no IPC interrupt
// yet), but its eventual finish/fail will no-op against the 'cancelled'
// status guard. Spend already incurred is non-refundable — the confirm
// dialog says so.
export async function cancelActiveStoryJobsAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const ids = formData.getAll("reddit_id").map(String).filter(Boolean);
  if (ids.length === 0) {
    redirect("/admin/reddit-sources?error=no-selection");
  }
  const { bulkCancelActiveStoryJobs } = await import("@/lib/story-jobs");
  const result = await bulkCancelActiveStoryJobs(ids);
  console.info("[story-jobs cancel]", {
    requested: ids.length,
    cancelled: result.cancelled,
    reset_to_imported: result.reset_to_imported,
    sample_ids: result.cancelled_reddit_ids.slice(0, 10),
  });
  revalidatePath("/admin/reddit-sources");
  const qs = new URLSearchParams();
  qs.set("status", "imported");
  qs.set("cancelled", String(result.cancelled));
  redirect(`/admin/reddit-sources?${qs.toString()}`);
}

// Phase 6: bulk version of the per-row Re-process action. The per-row
// affordance on the review page stays permissive (the admin is being
// deliberate when they open one row's surface); this bulk path is more
// conservative — it only resets rows in status='used', skipping
// queued/processing so a worker mid-execution isn't disrupted.
// See _plans/2026-06-14-story-jobs-followups.md Phase 6.
export async function bulkReprocessRedditSourcesAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const ids = formData.getAll("reddit_id").map(String).filter(Boolean);
  if (ids.length === 0) {
    redirect("/admin/reddit-sources?error=no-selection");
  }
  const { bulkReprocessRedditSources } = await import("@/lib/reddit-source");
  const result = await bulkReprocessRedditSources(ids);
  console.info("[reddit-sync bulk-reprocess]", {
    requested: ids.length,
    reset: result.reset,
    skipped_active: result.skipped_active,
    skipped_other: result.skipped_other,
    not_found: result.not_found,
  });
  revalidatePath("/admin/reddit-sources");
  // Land back on the imported view so the freshly-reset rows are visible
  // for the next Process N click.
  const qs = new URLSearchParams();
  qs.set("status", "imported");
  qs.set("reset", String(result.reset));
  if (result.skipped_active > 0)
    qs.set("skipped_active", String(result.skipped_active));
  redirect(`/admin/reddit-sources?${qs.toString()}`);
}

// Phase 4: publish gate.
//
// Three actions back the per-row review page at /admin/reddit-sources/[reddit_id]:
//
//   publishReviewedStoryAction       — checks readiness, flips story to 'published'.
//   rejectReviewedStoryAction        — archives the story (reddit_source stays 'used').
//   reprocessRedditSourceAction      — discards the generated story and resets the
//                                      reddit_source row to 'imported' so it can be
//                                      re-enqueued via Process N. Useful when the
//                                      LLM came back with a weak rewrite.
//
// Each action revalidates the per-row review page, the list, and the home
// dashboard so the change is visible everywhere immediately.

const REVIEW_ROUTE = (rid: string) => `/admin/reddit-sources/${rid}`;

export async function publishReviewedStoryAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const redditId = String(formData.get("reddit_id") ?? "");
  if (!redditId) redirect("/admin/reddit-sources?error=missing-reddit-id");

  const { getRedditSource, evaluatePublishReadiness } = await import(
    "@/lib/reddit-source"
  );
  const source = await getRedditSource(redditId);
  if (!source) {
    redirect(`/admin/reddit-sources?error=source-not-found&id=${redditId}`);
  }
  const story = source!.story_id
    ? await getStoryRow(source!.story_id)
    : null;
  const readiness = evaluatePublishReadiness(story, {
    status: source!.status,
    story_id: source!.story_id,
  });
  if (!readiness.ready) {
    // Encode the missing-list as a single string so the review page can
    // surface it without a separate state shape. URL-safe; the page splits
    // by `|` to render line items.
    const reason = encodeURIComponent(readiness.missing.join(" | "));
    console.warn("[reddit-review publish-blocked]", {
      reddit_id: redditId,
      missing: readiness.missing,
    });
    redirect(`${REVIEW_ROUTE(redditId)}?publish_blocked=${reason}`);
  }

  await setStatus(story!.id, "published");
  console.info("[reddit-review published]", {
    reddit_id: redditId,
    story_id: story!.id,
  });
  revalidatePath(REVIEW_ROUTE(redditId));
  revalidatePath("/admin/reddit-sources");
  revalidatePath(`/admin/stories/${story!.id}`);
  revalidatePath("/admin");
  redirect(`${REVIEW_ROUTE(redditId)}?published=1`);
}

export async function rejectReviewedStoryAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const redditId = String(formData.get("reddit_id") ?? "");
  if (!redditId) redirect("/admin/reddit-sources?error=missing-reddit-id");

  const { getRedditSource } = await import("@/lib/reddit-source");
  const source = await getRedditSource(redditId);
  if (!source) {
    redirect(`/admin/reddit-sources?error=source-not-found&id=${redditId}`);
  }
  if (!source!.story_id) {
    redirect(`${REVIEW_ROUTE(redditId)}?error=no-story`);
  }
  await setStatus(source!.story_id!, "archived");
  console.info("[reddit-review rejected]", {
    reddit_id: redditId,
    story_id: source!.story_id,
  });
  revalidatePath(REVIEW_ROUTE(redditId));
  revalidatePath("/admin/reddit-sources");
  revalidatePath(`/admin/stories/${source!.story_id}`);
  redirect(`${REVIEW_ROUTE(redditId)}?rejected=1`);
}

export async function reprocessRedditSourceAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const redditId = String(formData.get("reddit_id") ?? "");
  if (!redditId) redirect("/admin/reddit-sources?error=missing-reddit-id");

  const { getRedditSource, setRedditSourceStatus } = await import(
    "@/lib/reddit-source"
  );
  const source = await getRedditSource(redditId);
  if (!source) {
    redirect(`/admin/reddit-sources?error=source-not-found&id=${redditId}`);
  }
  // Archive the previous story (if any) so the public list doesn't carry
  // the stale draft; the LIVE story will be re-created by the next worker
  // run. We deliberately don't delete — the prior body is sometimes useful
  // to diff against the new one, and undo is one click away from /admin/stories.
  if (source!.story_id) {
    await setStatus(source!.story_id, "archived");
  }
  await setRedditSourceStatus(redditId, "imported", { story_id: null });
  console.info("[reddit-review reprocess]", {
    reddit_id: redditId,
    archived_story: source!.story_id,
  });
  revalidatePath(REVIEW_ROUTE(redditId));
  revalidatePath("/admin/reddit-sources");
  redirect(`${REVIEW_ROUTE(redditId)}?reprocess=1`);
}

// Phase 3: bulk-enqueue selected reddit_source rows into the story_jobs
// queue. The local pipeline/story_jobs_worker.py drains the queue and runs
// the existing scrape→idea→research→article→media→video stages against
// each row's full_text. We deliberately don't shell out to Python here —
// the action just flips status and inserts queue rows; the worker runs
// out of band on the user's machine (mirroring image_render_worker /
// render_worker patterns).
export async function processRedditSourcesAction(
  formData: FormData,
): Promise<void> {
  const session = await requireAdmin();
  const ids = formData.getAll("reddit_id").map(String).filter(Boolean);
  const withMedia = String(formData.get("with_media") ?? "1") === "1";
  if (ids.length === 0) {
    redirect("/admin/reddit-sources?error=no-selection");
  }
  // Server-side budget gate. The browse page disables the Process button
  // when budget.exhausted, but a hand-crafted POST (or a stale-tab click
  // after the cap was lowered) could bypass that. The worker would
  // silently no-op every claim, which leaves the user wondering why
  // nothing's happening — better to reject the enqueue up front with a
  // clear message.
  const { getBudgetSummary } = await import("@/lib/story-jobs-budget");
  const budget = await getBudgetSummary();
  if (budget.exhausted) {
    console.warn("[story-jobs enqueue-blocked]", {
      reason: "daily-budget-exhausted",
      cap_cents: budget.capCents,
      spent_cents: budget.spentCents,
      requested: ids.length,
    });
    redirect("/admin/reddit-sources?error=daily-budget-exhausted");
  }
  const { bulkEnqueueStoryJobs } = await import("@/lib/story-jobs");
  const result = await bulkEnqueueStoryJobs(ids, {
    with_media: withMedia,
    requested_by: session.email,
  });
  console.info("[story-jobs enqueue]", {
    requested: ids.length,
    enqueued: result.enqueued,
    skipped_active: result.skipped_active,
    skipped_status: result.skipped_status,
    not_found: result.not_found,
    with_media: withMedia,
    requested_by: session.email,
  });
  revalidatePath("/admin/reddit-sources");
  // Land back on the queue view so the admin sees the newly-queued rows
  // (status filter pre-selected to queued + processing).
  redirect(
    `/admin/reddit-sources?status=queued&status=processing&enqueued=${result.enqueued}` +
      (result.skipped_active ? `&skipped_active=${result.skipped_active}` : ""),
  );
}

// 2026-06-16 per-row event timeline. The StoryJobEventTimeline client
// component polls this every 2s while the source row is queued/processing
// and once on mount otherwise. Read-only; admin-gated.
// Plan: _plans/2026-06-16-story-job-event-timeline.md.
export async function listStoryJobEventsForRedditAction(
  redditId: string,
): Promise<
  Awaited<
    ReturnType<typeof import("@/lib/story-jobs").listStoryJobEventsForReddit>
  >
> {
  await requireAdmin();
  if (!redditId) return [];
  const { listStoryJobEventsForReddit } = await import("@/lib/story-jobs");
  return listStoryJobEventsForReddit(redditId);
}

// --- Bulk content actions (2026-06-19) --------------------------------------
// Plan: _plans/2026-06-19-content-bulk-actions.md.
//
// The /admin/content list is a client island that lets the operator tick
// rows and run a bulk action (publish, unpublish, set-status, set-category,
// delete). These actions are the server-side entry points. Both stories and
// articles flow through one of two actions:
//
//   bulkUpdateContentAction(items, op)
//     - status change (any STATUSES value), works on both kinds
//     - category change (Story CATEGORIES), stories only — article items in
//       the same batch are recorded as failures with reason "kind-mismatch"
//
//   bulkDeleteContentAction(items)
//     - hard delete. Stories: deleteStory + deleteStoryMedia (the GCS
//       cleanup is best-effort and never blocks the row delete). Articles:
//       deleteArticle (cascades to revisions per the repo function).
//
// Both actions:
//   - require admin via requireAdmin() at entry,
//   - re-read each row from the database before mutating to defend against
//     a client that lies about the `kind` of an id,
//   - catch and record per-item errors so a batch keeps going past one
//     bad row,
//   - return a BulkActionResult the client uses to render success counts,
//     failure lists, and the inline undo banner (status / category undo
//     uses the `prev` map; delete is not undoable).
//
// Security note: input validation runs at the boundary (status / category
// against the closed enums) BEFORE any DB call, so a forged client payload
// can't land an arbitrary string in a column. Hard cap of MAX_BULK_ITEMS
// protects against accidental "select all 200" runaway operations.

const MAX_BULK_ITEMS = 200;

const STORY_CATEGORIES = new Set([
  "Drama",
  "Entitled",
  "Humor",
  "Wholesome",
  "Dating",
  "Roommate",
]);

const STORY_STATUSES = new Set<StoryStatus>([
  "draft",
  "review",
  "scripted",
  "rendering",
  "ready",
  "published",
  "archived",
]);

const ARTICLE_STATUSES_SET = new Set<ArticleStatus>([
  "draft",
  "review",
  "published",
  "archived",
]);

export type BulkContentKind = "story" | "article";

export interface BulkContentItem {
  kind: BulkContentKind;
  id: string;
}

export type BulkUpdateOp =
  | { type: "status"; status: string }
  | { type: "category"; category: string };

export interface BulkActionFailure {
  kind: BulkContentKind;
  id: string;
  reason: string;
}

export interface BulkActionResult {
  ok: BulkContentItem[];
  failed: BulkActionFailure[];
  // Previous values, keyed by `${kind}:${id}`. For status ops the value is
  // the old status; for category ops the value is the old category (stories
  // only). The client uses this to drive the inline undo banner — it calls
  // bulkUpdateContentAction again with the previous values to reverse.
  prev: Record<string, string | null>;
}

function isBulkContentKind(v: unknown): v is BulkContentKind {
  return v === "story" || v === "article";
}

function validateItems(items: unknown): BulkContentItem[] {
  if (!Array.isArray(items)) {
    throw new Error("bulk-action: items is not an array");
  }
  if (items.length === 0) {
    throw new Error("bulk-action: items is empty");
  }
  if (items.length > MAX_BULK_ITEMS) {
    throw new Error(`bulk-action: exceeds ${MAX_BULK_ITEMS} items`);
  }
  const out: BulkContentItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") {
      throw new Error("bulk-action: item is not an object");
    }
    const kind = (raw as { kind?: unknown }).kind;
    const id = (raw as { id?: unknown }).id;
    if (!isBulkContentKind(kind)) {
      throw new Error("bulk-action: invalid kind");
    }
    if (typeof id !== "string" || !id) {
      throw new Error("bulk-action: invalid id");
    }
    out.push({ kind, id });
  }
  return out;
}

export async function bulkUpdateContentAction(
  itemsInput: BulkContentItem[],
  op: BulkUpdateOp,
): Promise<BulkActionResult> {
  await requireAdmin();
  const items = validateItems(itemsInput);
  if (!op || typeof op !== "object" || typeof op.type !== "string") {
    throw new Error("bulk-action: invalid op");
  }
  if (op.type === "status") {
    // Closed-enum check: status string must be in at least one of the two
    // kind-specific sets. Per-item validation below narrows further so a
    // story-only status like "scripted" can't be applied to an article row.
    if (
      !STORY_STATUSES.has(op.status as StoryStatus) &&
      !ARTICLE_STATUSES_SET.has(op.status as ArticleStatus)
    ) {
      throw new Error("bulk-action: invalid status");
    }
  } else if (op.type === "category") {
    if (!STORY_CATEGORIES.has(op.category)) {
      throw new Error("bulk-action: invalid category");
    }
  } else {
    throw new Error("bulk-action: unknown op type");
  }

  console.info("[content bulk action] start", {
    type: op.type,
    count: items.length,
  });

  const ok: BulkContentItem[] = [];
  const failed: BulkActionFailure[] = [];
  const prev: Record<string, string | null> = {};

  for (const item of items) {
    try {
      if (item.kind === "story") {
        const story = await getStoryRow(item.id);
        if (!story) {
          failed.push({ ...item, reason: "not-found" });
          continue;
        }
        if (op.type === "status") {
          if (!STORY_STATUSES.has(op.status as StoryStatus)) {
            failed.push({ ...item, reason: "invalid-status-for-story" });
            continue;
          }
          const prevStatus = story.status;
          await setStatus(item.id, op.status as StoryStatus);
          // Mirror the side-effect from changeStatus(): a story that
          // transitions to published gets an auto-drafted poll if it has
          // enough body text. Failures are swallowed so a poll-draft
          // problem can't make the batch publish look broken.
          if (op.status === "published" && prevStatus !== "published") {
            const body = (story.body ?? "").trim();
            if (body.length >= 50) {
              try {
                const { autoDraftPollForSubject } = await import(
                  "@/lib/poll-autodraft"
                );
                await autoDraftPollForSubject({
                  kind: "story",
                  storyId: item.id,
                  title: story.title,
                  body,
                  category: story.category,
                });
              } catch (err) {
                console.warn("[content bulk action] poll-autodraft failed", {
                  id: item.id,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          prev[`${item.kind}:${item.id}`] = prevStatus;
        } else {
          // category — story only
          const prevCategory = story.category;
          await setStoryCategory(item.id, op.category);
          prev[`${item.kind}:${item.id}`] = prevCategory;
        }
      } else {
        // article
        const article = await getArticle(item.id);
        if (!article) {
          failed.push({ ...item, reason: "not-found" });
          continue;
        }
        if (op.type === "category") {
          // Category bulk action is stories-only by design: articles don't
          // carry a writable category column, their `type` is the badge and
          // type is set-at-creation per repo.ts:651-656.
          failed.push({ ...item, reason: "kind-mismatch-category" });
          continue;
        }
        if (!ARTICLE_STATUSES_SET.has(op.status as ArticleStatus)) {
          failed.push({ ...item, reason: "invalid-status-for-article" });
          continue;
        }
        // Mirror the publish guard from setArticleStatusAction: every
        // image must carry alt text before the article is allowed to go
        // public. Failing rows are recorded with a precise reason so the
        // modal can show "3 images missing alt text" rather than a vague
        // "publish failed".
        if (op.status === "published") {
          let doc: unknown = null;
          try {
            doc = article.document ? JSON.parse(article.document) : null;
          } catch {
            doc = null;
          }
          const missing =
            countImagesMissingAlt(doc) + countGalleryImagesMissingAlt(doc);
          if (missing > 0) {
            failed.push({ ...item, reason: `alt-missing-${missing}` });
            continue;
          }
        }
        const prevStatus = article.status;
        await setArticleStatus(item.id, op.status as ArticleStatus);
        prev[`${item.kind}:${item.id}`] = prevStatus;
      }
      ok.push(item);
      console.info("[content bulk item]", {
        id: item.id,
        kind: item.kind,
        ok: true,
        op: op.type,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ ...item, reason });
      console.error("[content bulk action] failed", {
        id: item.id,
        kind: item.kind,
        error: reason,
      });
    }
  }

  // Revalidate the list page once, and any per-item editor page that might
  // be open in another tab so it doesn't show stale state after the action.
  revalidatePath("/admin/content");
  for (const item of ok) {
    if (item.kind === "story") {
      revalidatePath(`/admin/stories/${item.id}`);
    } else {
      revalidatePath(`/admin/articles/${item.id}`);
    }
  }

  console.info("[content bulk action] done", {
    type: op.type,
    ok: ok.length,
    failed: failed.length,
  });
  return { ok, failed, prev };
}

export async function bulkDeleteContentAction(
  itemsInput: BulkContentItem[],
): Promise<BulkActionResult> {
  await requireAdmin();
  const items = validateItems(itemsInput);

  console.info("[content bulk action] start", {
    type: "delete",
    count: items.length,
  });

  const ok: BulkContentItem[] = [];
  const failed: BulkActionFailure[] = [];

  for (const item of items) {
    try {
      if (item.kind === "story") {
        const removed = await deleteStory(item.id);
        if (!removed) {
          failed.push({ ...item, reason: "not-found" });
          continue;
        }
        // GCS cleanup is best-effort: a transient bucket error must not
        // leave the DB row half-deleted. The row is already gone at this
        // point; we log media failures but don't push to `failed` because
        // the user-visible outcome (story gone from the inbox) succeeded.
        try {
          const { deleteStoryMedia } = await import("@/lib/gcs");
          const media = await deleteStoryMedia(
            removed.audio_url,
            removed.video_url,
          );
          console.info("[content bulk item]", {
            id: item.id,
            kind: item.kind,
            ok: true,
            op: "delete",
            mediaAttempted: media.attempted,
            mediaSkipped: media.skipped,
          });
        } catch (mediaErr) {
          console.warn("[content bulk action] media cleanup failed", {
            id: item.id,
            error:
              mediaErr instanceof Error ? mediaErr.message : String(mediaErr),
          });
        }
      } else {
        const article = await getArticle(item.id);
        if (!article) {
          failed.push({ ...item, reason: "not-found" });
          continue;
        }
        await deleteArticle(item.id);
        console.info("[content bulk item]", {
          id: item.id,
          kind: item.kind,
          ok: true,
          op: "delete",
        });
      }
      ok.push(item);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ ...item, reason });
      console.error("[content bulk action] failed", {
        id: item.id,
        kind: item.kind,
        op: "delete",
        error: reason,
      });
    }
  }

  revalidatePath("/admin/content");
  revalidatePath("/admin/stories");
  revalidatePath("/admin/articles");

  console.info("[content bulk action] done", {
    type: "delete",
    ok: ok.length,
    failed: failed.length,
  });
  return { ok, failed, prev: {} };
}

// --- Bulk LLM reclassify (2026-06-21) ---------------------------------------
// Plan: _plans/2026-06-21-category-classifier-and-pills.md.
//
// Thin auth + revalidate wrapper around `reclassifyDramaAndNullStories`.
// The actual SQL + classifier loop lives in `lib/reclassify-stories.ts`
// so it stays unit-testable without the "use server" gate.

export type {
  ReclassifyChange,
  ReclassifyFailure,
  ReclassifyResult,
} from "@/lib/reclassify-stories";

export async function bulkReclassifyStoriesAction() {
  await requireAdmin();
  const { reclassifyDramaAndNullStories } = await import(
    "@/lib/reclassify-stories"
  );
  const result = await reclassifyDramaAndNullStories({ limit: MAX_BULK_ITEMS });
  // Refresh the admin list and the public homepage. The live catalog
  // reads category from the DB on every render, so the public site picks
  // up the new tags on the next request.
  revalidatePath("/admin/content");
  revalidatePath("/");
  return result;
}
