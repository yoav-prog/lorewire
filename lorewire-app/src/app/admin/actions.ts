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
  await setArticleStatus(id, status);
  console.info("[articles action] status", { id, status });
  revalidatePath(`/admin/articles/${id}`);
  revalidatePath("/admin/articles");
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
