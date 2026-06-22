// POST /api/user/avatar — upload and set the signed-in user's profile picture.
//
// The platform's FIRST user-generated-content endpoint, so it is a security
// gate before it is a feature: authenticated (lw_user), origin-checked, per-user
// rate limited, size + magic-byte validated, and every byte re-encoded to WebP
// (lib/avatar-image) before anything is written public. The WebP lands in the
// ISOLATED usercontent bucket served from usercontent.lorewire.com — a different
// origin than the app — so even a slipped-through file can't script the site.
//
// sharp requires the Node runtime (not Edge); pinned below.
//
// Plan: _plans/2026-06-22-r2-media-migration-and-avatar-upload.md.

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { readUserSession } from "@/lib/user-session";
import { getUserById, updateUserProfile } from "@/lib/users";
import { checkAndRecord } from "@/lib/poll-rate-limit";
import {
  AvatarValidationError,
  MAX_UPLOAD_BYTES,
  processAvatar,
} from "@/lib/avatar-image";
import {
  deleteR2Object,
  isR2Configured,
  putR2Object,
  userContentBucket,
  userContentKeyFromUrl,
} from "@/lib/r2";

export const runtime = "nodejs";

let warnedAboutMissingSiteOriginInProd = false;

// Mirrors the origin guard on /api/user/profile.
function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const expected = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() ?? "";
  if (expected) return origin === expected.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") {
    return (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    );
  }
  if (!warnedAboutMissingSiteOriginInProd) {
    warnedAboutMissingSiteOriginInProd = true;
    console.warn(
      "[avatar upload] NEXT_PUBLIC_SITE_ORIGIN unset in production — every upload will be rejected.",
    );
  }
  return false;
}

function publicBase(): string {
  return process.env.USERCONTENT_PUBLIC_BASE?.trim().replace(/\/+$/, "") ?? "";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const session = await readUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const base = publicBase();
  if (!isR2Configured() || !base) {
    console.error("[avatar upload] storage not configured", {
      r2: isR2Configured(),
      base: Boolean(base),
    });
    return NextResponse.json(
      { error: "Photo upload isn't available right now." },
      { status: 503 },
    );
  }

  // Per-user rate limit — a handful of avatar changes an hour is plenty, and it
  // stops a script from filling the public bucket.
  const rl = checkAndRecord(`avatar:${session.userId}`, {
    perMinute: 3,
    perHour: 15,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Try again in a moment." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // Parse the multipart body.
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "No image provided." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "That image is too large. Max 4 MB." },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Validate + re-encode — the security gate. Output is fresh WebP pixels with
  // no metadata, never the bytes the user sent.
  let webp: Buffer;
  try {
    ({ webp } = await processAvatar(bytes));
  } catch (err) {
    if (err instanceof AvatarValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[avatar upload process-failed]", {
      user: session.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't process that image. Try again." },
      { status: 500 },
    );
  }

  // Content-addressed key: a changed avatar busts cache, identical re-uploads
  // dedupe, and the userId prefix scopes objects to their owner.
  const hash = createHash("sha256").update(webp).digest("hex").slice(0, 16);
  const key = `avatars/${session.userId}-${hash}.webp`;
  const bucket = userContentBucket();

  try {
    await putR2Object(bucket, key, webp, {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
  } catch (err) {
    console.error("[avatar upload put-failed]", {
      user: session.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Upload failed. Try again." },
      { status: 502 },
    );
  }

  const url = `${base}/${key}`;

  // Read the prior avatar BEFORE overwriting so we can reap the old object.
  const existing = await getUserById(session.userId);
  const prevUrl = existing?.picture_url ?? null;

  try {
    await updateUserProfile(session.userId, { pictureUrl: url });
  } catch (err) {
    // Uploaded but the DB write failed — reap the just-uploaded object so we
    // don't leak storage, then surface the failure.
    await deleteR2Object(bucket, key).catch(() => {});
    console.error("[avatar upload db-failed]", {
      user: session.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't save your photo. Try again." },
      { status: 500 },
    );
  }

  // Reap the previous avatar if it was one of ours (never touch a DiceBear or
  // OAuth URL). Best-effort: a failed delete is logged, never fails the request.
  const prevKey = userContentKeyFromUrl(prevUrl, base);
  if (prevKey && prevKey !== key) {
    deleteR2Object(bucket, prevKey).catch((e) =>
      console.warn("[avatar upload old-reap-failed]", {
        user: session.userId,
        prevKey,
        e: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  console.info("[avatar upload ok]", {
    user: session.userId,
    key,
    bytes: webp.length,
  });
  return NextResponse.json({ ok: true, pictureUrl: url });
}
