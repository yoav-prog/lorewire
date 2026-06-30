// Fetch the bytes of a poster / cover image so the social publishers
// (FB multipart `thumb`, YT `videos/thumbnails/set`) can attach them
// to their upload calls.
//
// Why this helper exists — the 2026-06-30 19:40 production incident:
// the public MEDIA_PUBLIC_BASE URL (Cloudflare-fronted R2 custom
// domain) returns 403 to Vercel's serverless undici egress while the
// same URL returns 200 to arbitrary curl callers, browsers, and the
// platforms' own backends. We've confirmed it's a Cloudflare WAF /
// bot-fight rule targeting Vercel's egress range, not a User-Agent
// filter. That blocked FB and YT byte-fetches; IG was unaffected (IG
// fetches the cover_url from its own backend).
//
// Fix: when R2 is the active media writer (production), bypass the
// Cloudflare custom domain entirely and read the bytes through the
// authenticated R2 S3 API. The S3 endpoint goes to R2 origin, not
// through Cloudflare's edge filter. We have the credentials in env
// already (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY).
//
// When R2 is NOT active (dev, tests, legacy GCS-only deploys), fall
// back to a plain public-URL GET via the caller's fetchImpl. This
// keeps the dev / test surface unchanged.

import "server-only";
import {
  getR2ObjectBytesWithMime,
  isR2MediaActive,
  mediaBucket,
  mediaUrlToKey,
} from "@/lib/r2";

export interface PosterBytes {
  bytes: Uint8Array;
  mime: string;
}

/** Minimal Response-like shape so the test stubs in
 *  publish-to-facebook.test / publish-to-youtube.test can satisfy
 *  this without pulling in undici types. */
export interface FetchedResp {
  ok: boolean;
  status: number;
}

export type PosterBytesFetchImpl = (
  url: string,
  init?: { method?: string },
) => Promise<FetchedResp>;

function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[poster bytes ${event}]`, JSON.stringify(fields));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid-url>";
  }
}

/** Fetch the bytes of a poster URL, preferring R2 direct (S3, signed)
 *  when R2 is active. Returns null on any failure — caller decides
 *  whether that's a hard fail (no thumb attached) or a soft fallback. */
export async function fetchPosterBytes(
  publicUrl: string,
  fetchImpl: PosterBytesFetchImpl,
): Promise<PosterBytes | null> {
  // Production path: R2 direct via signed S3 GET. Bypasses Cloudflare.
  if (isR2MediaActive()) {
    const base = (process.env.MEDIA_PUBLIC_BASE ?? "").replace(/\/+$/, "");
    const key = mediaUrlToKey(publicUrl, base);
    if (!key) {
      log("not_on_media_base", { url_host: hostOf(publicUrl) });
      // Don't return null yet — fall through to public-URL fetch as a
      // last resort so a non-R2 URL (e.g., a hot-linked external image)
      // still has a chance.
    } else {
      try {
        const { bytes, mime } = await getR2ObjectBytesWithMime(
          mediaBucket(),
          key,
        );
        if (bytes.byteLength === 0) {
          log("r2_direct_zero_bytes", { key });
          return null;
        }
        log("r2_direct_ok", { key, bytes: bytes.byteLength, mime });
        return { bytes: new Uint8Array(bytes), mime };
      } catch (e) {
        log("r2_direct_failed", {
          key,
          reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
        // Fall through to public-URL fetch.
      }
    }
  }

  // Fallback: public URL via the caller's fetchImpl. Used in:
  //   - dev / tests where R2_MEDIA_WRITE_ENABLED is unset
  //   - legacy GCS-only deploys (R2 not configured)
  //   - last-resort recovery when R2 direct failed
  try {
    const resp = await fetchImpl(publicUrl, { method: "GET" });
    if (!resp.ok) {
      log("public_fetch_failed", {
        url_host: hostOf(publicUrl),
        http_status: resp.status,
      });
      return null;
    }
    // The real undici Response has arrayBuffer + headers.get; test stubs
    // typically don't. Cast pragmatically — same pattern as the
    // pre-existing FB / YT byte-fetch code that this helper replaces.
    const r = resp as unknown as Response;
    let buf: ArrayBuffer;
    try {
      buf = await r.arrayBuffer();
    } catch (e) {
      log("public_fetch_no_buffer", {
        url_host: hostOf(publicUrl),
        reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
      return null;
    }
    if (buf.byteLength === 0) {
      log("public_fetch_zero_bytes", { url_host: hostOf(publicUrl) });
      return null;
    }
    const ct =
      (typeof r.headers?.get === "function" && r.headers.get("content-type")) ||
      "";
    const mime = ct.startsWith("image/") ? ct : "image/png";
    log("public_fetch_ok", {
      url_host: hostOf(publicUrl),
      bytes: buf.byteLength,
      mime,
    });
    return { bytes: new Uint8Array(buf), mime };
  } catch (e) {
    log("public_fetch_error", {
      url_host: hostOf(publicUrl),
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
    return null;
  }
}
