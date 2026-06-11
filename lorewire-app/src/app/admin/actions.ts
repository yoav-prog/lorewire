"use server";

// Server actions for the admin. Every mutation re-checks authorization at the
// data source (requireAdmin) rather than trusting the proxy alone.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin, ensureSeedAdmin } from "@/lib/dal";
import { createSession, deleteSession } from "@/lib/session";
import {
  getUserByEmail,
  updateStory,
  setStatus,
  setSetting,
  type StoryStatus,
} from "@/lib/repo";
import { verifyPassword } from "@/lib/passwords";
import { selectModel, type Stage } from "@/lib/models";

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
