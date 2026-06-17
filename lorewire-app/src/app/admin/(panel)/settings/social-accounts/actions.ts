"use server";

// Server actions for the social-accounts settings panel.
//
// Disconnect revokes the grant at the platform (best effort, needs the
// decrypted token first) and then drops the local cipher fields and marks the
// row revoked. Auth is re-checked inside the action: server actions are
// reachable by direct POST, not only through our UI. Plan section 8.

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import { tokenCipher } from "@/lib/token-cipher";
import { revokeGoogleToken } from "@/lib/social-oauth";
import {
  getSocialAccountById,
  revokeSocialAccount,
} from "@/lib/social-accounts";

const SETTINGS_PATH = "/admin/settings/social-accounts";

export async function disconnectSocialAccount(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = formData.get("id");
  if (typeof id !== "string" || !id) return;

  const row = await getSocialAccountById(id);
  if (row?.access_token_enc) {
    try {
      // Revoking the access token revokes the whole Google grant (including the
      // refresh token). Best effort: the token may be unreadable after a key
      // rotation, or already revoked. Either way we drop the local row below.
      await revokeGoogleToken(tokenCipher().decrypt(row.access_token_enc));
    } catch {
      // swallow; local revoke still proceeds
    }
  }

  await revokeSocialAccount(id);
  console.info("[social oauth revoke]", { id, platform: row?.platform });
  revalidatePath(SETTINGS_PATH);
}
