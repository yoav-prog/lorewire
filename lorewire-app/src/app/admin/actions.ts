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
