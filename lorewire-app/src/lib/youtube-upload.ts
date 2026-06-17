// YouTube upload engine: resolve a valid access token (refreshing on demand),
// stream the rendered MP4 from GCS, and run videos.insert via the two-step
// resumable protocol. Network + DB, so it is integration-tested in Slice 4
// rather than unit-tested. Mirrors the working reference
// (_reference/youtubestudio/src/lib/publishing.ts), adapted to Lorewire: raw
// fetch, tokenCipher-sealed tokens, social_accounts. Plan sections 7.1, 8 (N4).

import "server-only";
import { tokenCipher } from "@/lib/token-cipher";
import { refreshAccessToken } from "@/lib/social-oauth";
import {
  markSocialAccountNeedsReauth,
  updateSocialAccountAccessToken,
  type SocialAccountRow,
} from "@/lib/social-accounts";
import { redact } from "@/lib/redact";
import type { VideosInsertBody } from "@/lib/youtube-publish";

const RESUMABLE_INIT_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable";

// Refresh this many ms before the token actually expires, so a publish that
// starts just before expiry does not get a 401 mid-upload.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// Return a usable access token for the account, refreshing if it is at or near
// expiry. Phase 1 does a plain refresh; the single-flight advisory lock
// (plan N4) is a deferred Phase 2 hardening. At roughly 6 publishes/day a
// refresh race is rare and benign: Google issues a fresh access token per call
// and leaves the refresh token unchanged, so the only cost of a race is one
// wasted refresh. On refresh failure the row is marked needs_reauth and we
// return null, so the caller fails the publish cleanly with a reconnect hint.
export async function getValidYoutubeAccessToken(
  account: SocialAccountRow,
): Promise<string | null> {
  const cipher = tokenCipher();

  const expiresAt = account.token_expires_at
    ? Date.parse(account.token_expires_at)
    : 0;
  const stillValid =
    Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS > Date.now();

  if (stillValid && account.access_token_enc) {
    try {
      return cipher.decrypt(account.access_token_enc);
    } catch {
      // Fall through to refresh on a decrypt failure (e.g. a key-rotation gap).
    }
  }

  if (!account.refresh_token_enc) {
    await markSocialAccountNeedsReauth(account.id);
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = cipher.decrypt(account.refresh_token_enc);
  } catch {
    await markSocialAccountNeedsReauth(account.id);
    return null;
  }

  try {
    const refreshed = await refreshAccessToken({ refreshToken });
    const newExpiry = new Date(
      Date.now() + refreshed.expires_in * 1000,
    ).toISOString();
    await updateSocialAccountAccessToken(
      account.id,
      cipher.encrypt(refreshed.access_token),
      newExpiry,
    );
    console.info("[social oauth refresh]", {
      platform: account.platform,
      accountId: account.id,
      expiresIn: refreshed.expires_in,
    });
    return refreshed.access_token;
  } catch (e) {
    console.error(
      "[social oauth refresh] failed",
      redact({
        accountId: account.id,
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    await markSocialAccountNeedsReauth(account.id);
    return null;
  }
}

interface SourceVideo {
  body: ReadableStream<Uint8Array>;
  size: number;
  mimeType: string;
}

// Open the rendered MP4 for streaming into the YouTube PUT. The source is our
// own GCS public object (short_renders.output_url), so we require https and the
// Google Storage host as a lightweight SSRF guard rather than fetching an
// arbitrary URL. GCS returns Content-Length, which the resumable protocol needs
// up front.
async function openSourceVideo(url: string): Promise<SourceVideo> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("source url is not a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "storage.googleapis.com") {
    throw new Error("source url must be an https storage.googleapis.com object");
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`source fetch failed: ${res.status}`);
  }
  const size = Number(res.headers.get("content-length") ?? "0");
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("source did not return a Content-Length header");
  }
  return {
    body: res.body,
    size,
    mimeType: res.headers.get("content-type") || "video/mp4",
  };
}

export interface UploadResult {
  videoId: string;
}

interface VideosInsertResponse {
  id?: string;
  error?: { code: number; message: string };
}

// Two-step resumable videos.insert. Init posts the JSON metadata and the byte
// size; YouTube returns the per-upload session URL in the Location header. The
// PUT then streams the bytes straight through (duplex: "half", no in-memory
// buffering) so an 80 MB short never materializes in the function's heap.
export async function uploadShortToYoutube(input: {
  accessToken: string;
  sourceUrl: string;
  body: VideosInsertBody;
}): Promise<UploadResult> {
  const source = await openSourceVideo(input.sourceUrl);

  const initRes = await fetch(RESUMABLE_INIT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(source.size),
      "X-Upload-Content-Type": source.mimeType,
    },
    body: JSON.stringify(input.body),
  });
  if (!initRes.ok) {
    const err = (await initRes.json().catch(() => ({}))) as VideosInsertResponse;
    throw new Error(
      err.error?.message || `videos.insert init returned ${initRes.status}`,
    );
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) {
    throw new Error("videos.insert init returned no upload session Location");
  }

  const uploadRes = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": source.mimeType,
      "Content-Length": String(source.size),
    },
    body: source.body,
    // duplex is required by Node's fetch when the body is a stream; it is not
    // yet present in the lib's RequestInit types.
    // @ts-expect-error Node fetch streaming option missing from lib types
    duplex: "half",
  });
  const json = (await uploadRes.json().catch(() => ({}))) as VideosInsertResponse;
  if (!uploadRes.ok) {
    throw new Error(
      json.error?.message || `videos.insert upload returned ${uploadRes.status}`,
    );
  }
  if (!json.id) {
    throw new Error("videos.insert succeeded without returning a video id");
  }
  return { videoId: json.id };
}
