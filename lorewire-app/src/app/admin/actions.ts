"use server";

// Server actions for the admin. Every mutation re-checks authorization at the
// data source (requireAdmin) rather than trusting the proxy alone.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { requireAdmin, ensureSeedAdmin, currentUser } from "@/lib/dal";
import { createSession, deleteSession } from "@/lib/session";
import {
  getUserByEmail,
  updateStory,
  setStatus,
  setSetting,
  getSetting,
  getSegment,
  setSegmentEnabled,
  updateSegmentLabel,
  deleteSegment,
  setStorySegmentOverride,
  createArticle,
  getArticle,
  updateArticle,
  setArticleStatus,
  deleteArticle,
  appendRevision,
  checkSlugAvailable,
  updateArticleSlug,
  type StoryStatus,
  type SegmentKind,
  type ArticleStatus,
  type ArticleLanguage,
} from "@/lib/repo";
import { verifyPassword } from "@/lib/passwords";
import { selectModel, type Stage } from "@/lib/models";
import { run } from "@/lib/db";
import { sanitizeLabel } from "@/lib/segments-upload";
import {
  isArticleType,
  isArticleLanguage,
  slugifyTitle,
} from "@/lib/articles";
import { countImagesMissingAlt } from "@/lib/tiptap-article-image";
import {
  NewsPayloadSchema,
  FeaturePayloadSchema,
  ListiclePayloadSchema,
  ReviewPayloadSchema,
} from "@/lib/article-payload";
import { isValidSlugShape } from "@/lib/article-seo";
import type { ArticleType } from "@/lib/repo";

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
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath("/admin/stories");
}

export async function changeStatus(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as StoryStatus;
  if (!id || !status) return;
  await setStatus(id, status);
  revalidatePath(`/admin/stories/${id}`);
  revalidatePath("/admin/stories");
  revalidatePath("/admin");
}

export async function setModelAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const stage = String(formData.get("stage") ?? "") as Stage;
  const model = String(formData.get("model") ?? "");
  if (!stage || !model) return;
  await selectModel(stage, model);
  revalidatePath("/admin/models");
}

export async function saveSettingAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const key = String(formData.get("key") ?? "");
  if (!key) return;
  await setSetting(key, String(formData.get("value") ?? ""));
  revalidatePath("/admin/settings");
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

export async function saveCaptionTemplateAction(
  formData: FormData,
): Promise<void> {
  await requireAdmin();
  const rawScope = String(formData.get("__scope") ?? "global");
  const cat = String(formData.get("__cat") ?? "") || undefined;
  const story = String(formData.get("__story") ?? "") || undefined;
  // Scope guard: cat-scope without cat, or story-scope without story, is an
  // incomplete selection. Refuse to write — otherwise the writes would land
  // at the global prefix and silently overwrite the wrong tier.
  const scope =
    (rawScope === "cat" && !cat) || (rawScope === "story" && !story)
      ? "global"
      : rawScope;
  const prefix = captionPrefix(scope, cat, story);

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
    changed: changedKeys,
    changedCount: changedKeys.length,
  });
  revalidatePath("/admin/templates");
  // Redirect back to the same scope view with ?saved=1 so the page renders a
  // saved-banner instead of giving the admin no feedback.
  const search = new URLSearchParams();
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

function activeKey(kind: SegmentKind): string {
  return `video.active_${kind}_id`;
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
  await setSetting(activeKey(kind), id);
  console.info(`[admin segments] set-active kind=${kind} id=${id}`);
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
  // Clear the global active pointer if it pointed here, otherwise the next
  // render would try to use a deleted id and fall back to no intro/outro
  // silently. Also clear any per-story override that pinned this id so
  // those stories revert to "use global active".
  const kind = seg!.kind as SegmentKind;
  const currentActive = await getSetting(activeKey(kind));
  if (currentActive === id) {
    await setSetting(activeKey(kind), "");
  }
  const overrideCol =
    kind === "intro" ? "intro_segment_id" : "outro_segment_id";
  await run(
    `UPDATE stories SET ${overrideCol} = NULL WHERE ${overrideCol} = ?`,
    [id],
  );
  await deleteSegment(id);
  console.info(
    `[admin segments] delete kind=${kind} id=${id} cleared_active=${currentActive === id}`,
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
    const missing = countImagesMissingAlt(doc);
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
