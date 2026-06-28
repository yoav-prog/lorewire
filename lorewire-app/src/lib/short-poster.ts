// Resolve-or-render the per-story social poster image. Shared by the
// IG / FB / YouTube publishers; TikTok stays on its timestamp-based
// cover (see _plans/2026-06-28-explicit-thumbnail-uploads.md).
//
// Architecture (per _plans/2026-06-28-phase-2-social-poster-render.md):
//
//   1. Read scene_1_url + (poster_text OR hook) from the freshest
//      `done` row in short_renders.props. If either is missing, return
//      null — caller falls back to PR #137's scene-1-as-cover.
//   2. Brand-safety + glyph + RTL guards on the source text. Any
//      failure returns null with a logged reason.
//   3. Compute cache hash = sha256(scene_1_url + "\n" + text + "\n" +
//      POSTER_VERSION).slice(0,16). POSTER_VERSION bumps invalidate
//      every cached poster on the next publish (e.g. when the design
//      tokens change in PosterStill.tsx).
//   4. Compute deterministic GCS / R2 URL. HEAD it with 2s timeout —
//      cache hit returns immediately.
//   5. On cache miss: POST to Cloud Run /render-poster with 8s
//      timeout. Cloud Run renders the still + uploads to GCS / R2 at
//      the deterministic URL and returns it.
//   6. Any failure (network, 4xx, 5xx, glyph reject, RTL reject)
//      logs and returns null. The function NEVER throws.
//
// Returns a structured shape (not a bare URL) so the Phase 3 OG /
// email / homepage-rail consumers can reuse the helper without
// re-deriving paths.

import "server-only";
import { createHash } from "node:crypto";
import { Agent, fetch as undiciFetch } from "undici";
import { mediaPublicBase } from "@/lib/media-url";
import { one } from "@/lib/db";

/** Bump this whenever the visual contract in
 *  `video/src/PosterStill.tsx` changes (band height, fonts, colors,
 *  layout). The hash incorporates this constant so a design-token
 *  change automatically invalidates every cached poster on the next
 *  publish — no backfill script needed. Per the council's POSTER_VERSION
 *  fix in the revised _plans/2026-06-28-phase-2-social-poster-render.md. */
const POSTER_VERSION = "v1";

/** Caps so a malformed input (or a runaway LLM line) can't blow the
 *  cache-key or the Cloud Run request body. Mirrored on the server
 *  side at video/server/index.ts::parseRenderPosterBody. */
const HOOK_MAX_CHARS = 280;
const URL_MAX_CHARS = 2000;

const HEAD_TIMEOUT_MS = 2000;
const RENDER_TIMEOUT_MS = 8000;

/** Setting key for the kill switch (default ON). When OFF, this
 *  function returns null for every call without doing any I/O —
 *  publishers fall back to the PR #137 scene-1-as-cover path. */
const SETTING_ENABLED = "publisher.short_poster.enabled";

/** Conservative English profanity list — duplicated from
 *  `pipeline/shorts_safety.py::PROFANITY`. The LLM-generated text has
 *  already been brand-safety-checked at script generation time, so this
 *  is a defense-in-depth check (also covers the `hook` fallback path
 *  for legacy stories rendered before the safety check existed). */
const PROFANITY = new Set([
  "fuck", "fucking", "fucked", "shit", "shitty", "bullshit",
  "asshole", "bitch", "cunt", "dick", "pussy", "cock",
  "bastard", "damn", "goddamn", "hell",
]);

/** Substantive all-caps runs (3+ chars) — re-renders as SHOUTING since
 *  PosterStill uppercases the text anyway. Same pattern as
 *  `pipeline/shorts_safety.py::_ALL_CAPS_RUN`. Acronyms 1-2 chars (OK,
 *  FBI, etc.) pass through. */
const ALL_CAPS_RUN = /\b[A-Z]{3,}\b/;

/** Allowed character set: Basic Latin + Latin-1 Supplement +
 *  Latin Extended-A. Covers English plus accented Latin (é, ñ, ü,
 *  etc.). Hebrew, Arabic, CJK, etc. all reject — PosterStill loads
 *  Bebas Neue (Latin-only) so anything outside would render as tofu.
 *  RTL guard piggybacks on this. */
const SUPPORTED_GLYPH_RE = /^[ -~ -ÿĀ-ſ‐-’“-”…]*$/;

export type PosterSource = "cached" | "rendered";

export interface ShortPoster {
  /** Public URL of the poster PNG, ready to hand to a social publisher
   *  as a thumbnail / cover. */
  url: string;
  /** Short brand-safe description suitable for OG `alt` / a11y. */
  alt: string;
  /** 16-char hex cache key (sha256 prefix of scene_1 + text + POSTER_VERSION). */
  hash: string;
  /** Whether the URL came from the HEAD cache hit or a fresh Cloud Run render. */
  source: PosterSource;
}

interface SettingLike {
  getSetting: (key: string) => Promise<string | null | undefined>;
}

interface PosterFetchLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

export interface EnsureShortPosterDeps {
  fetch?: PosterFetchLike;
  /** Test override for the settings reader. Production uses
   *  @/lib/repo's getSetting. */
  settings?: SettingLike;
}

interface StoryProps {
  scene_1_url: string;
  text: string;
  text_source: "poster_text" | "hook";
}

/** Surface used by the dispatcher's existing log channel so failures
 *  thread back into the same `[publish ...]` log line operators already
 *  watch. */
function log(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[poster ensure] ${event}`, JSON.stringify(fields));
}

/** Defense: a 30s undici Agent so a hung Cloud Run dial doesn't pin
 *  the publisher. Per-request AbortSignals enforce the per-step
 *  budgets (HEAD_TIMEOUT_MS / RENDER_TIMEOUT_MS) below this floor. */
const posterAgent = new Agent({
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
  keepAliveTimeout: 10_000,
});

const defaultFetch: PosterFetchLike = async (url, init) => {
  const r = await undiciFetch(url, {
    ...init,
    dispatcher: posterAgent,
  } as Parameters<typeof undiciFetch>[1]);
  return {
    ok: r.ok,
    status: r.status,
    json: () => r.json(),
    text: () => r.text(),
  };
};

/** Read scene_1_url + (poster_text || hook) from the freshest done
 *  row in short_renders.props. Returns null if the story has never
 *  been rendered OR the row predates Part 0 (no hook field). */
async function loadStoryProps(storyId: string): Promise<StoryProps | null> {
  if (!storyId) return null;
  const row = await one<{ props: unknown }>(
    `SELECT props FROM short_renders
     WHERE story_id = ? AND status = 'done' AND props IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1`,
    [storyId],
  );
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed =
      typeof row.props === "string" ? JSON.parse(row.props) : row.props;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const frames = obj.doodle_frames;
  const scene_1_url =
    Array.isArray(frames) && frames[0] && typeof frames[0] === "object"
      ? (frames[0] as { url?: unknown }).url
      : null;
  if (typeof scene_1_url !== "string" || !scene_1_url) return null;
  // Prefer the climax-revealing poster_text (Part 1.5 prompt update)
  // over the spoken cold-open hook (Part 0). Both are stripped from
  // the video Remotion props by the dispatcher before /render fires;
  // we read them directly from the persisted row.
  const posterText = obj.poster_text;
  if (typeof posterText === "string" && posterText.trim().length > 0) {
    return { scene_1_url, text: posterText.trim(), text_source: "poster_text" };
  }
  const hook = obj.hook;
  if (typeof hook === "string" && hook.trim().length > 0) {
    return { scene_1_url, text: hook.trim(), text_source: "hook" };
  }
  return null;
}

/** Pre-render guards. Returns the reason string if rejected, null if OK. */
function guardText(text: string): string | null {
  if (text.length > HOOK_MAX_CHARS) return "text_too_long";
  if (!SUPPORTED_GLYPH_RE.test(text)) return "glyph_unsupported";
  if (ALL_CAPS_RUN.test(text)) return "all_caps_shock";
  const lower = text.toLowerCase();
  for (const word of PROFANITY) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return "profanity";
  }
  return null;
}

/** Compute the deterministic cache hash. Bumping POSTER_VERSION
 *  cascades through every cached poster on the next publish. */
export function computePosterHash(scene_1_url: string, text: string): string {
  return createHash("sha256")
    .update(scene_1_url)
    .update("\n")
    .update(text)
    .update("\n")
    .update(POSTER_VERSION)
    .digest("hex")
    .slice(0, 16);
}

/** Build the deterministic public URL for the poster PNG. Mirrors the
 *  GCS key Cloud Run writes to in video/server/render.ts. */
function posterUrlForKey(storyId: string, hash: string): string {
  const key = `${sanitizeStoryId(storyId)}-short/poster-${hash}.png`;
  const base = mediaPublicBase();
  if (base) return `${base}/${key}`;
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return "";
  return `https://storage.googleapis.com/${bucket}/${key}`;
}

function sanitizeStoryId(storyId: string): string {
  const cleaned = storyId.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/** Build the OG-style alt text for a11y / share cards. Keep brief and
 *  brand-safe: a stranger reading just the alt should know it's a
 *  Lorewire short + the topic in plain words. */
function buildAlt(text: string): string {
  return `Lorewire short: ${text}`;
}

/** Single AbortSignal helper since Node 22's AbortSignal.timeout is
 *  available everywhere we run. */
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

export async function ensureShortPoster(
  storyId: string,
  deps: EnsureShortPosterDeps = {},
): Promise<ShortPoster | null> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const settings = deps.settings ?? (await import("@/lib/repo"));

  const t0 = Date.now();
  // Kill switch — admin can flip OFF without code change if Cloud Run
  // becomes flaky or the design needs a redo. Default ON.
  const enabledRaw = (await settings.getSetting(SETTING_ENABLED)) ?? "1";
  if (enabledRaw === "0") {
    log("skipped", { story_id: storyId, reason: "setting_off" });
    return null;
  }

  const props = await loadStoryProps(storyId);
  if (!props) {
    log("skipped", { story_id: storyId, reason: "missing_props" });
    return null;
  }
  if (props.scene_1_url.length > URL_MAX_CHARS) {
    log("skipped", {
      story_id: storyId,
      reason: "scene_1_url_too_long",
    });
    return null;
  }

  const guard = guardText(props.text);
  if (guard) {
    log("skipped", {
      story_id: storyId,
      reason: guard,
      text_source: props.text_source,
    });
    return null;
  }

  const hash = computePosterHash(props.scene_1_url, props.text);
  const url = posterUrlForKey(storyId, hash);
  if (!url) {
    log("skipped", { story_id: storyId, reason: "no_media_base" });
    return null;
  }

  // 1) Cache HEAD with a short budget. The cache miss is the common
  // path on first publish per story; subsequent platforms hit warm.
  try {
    const head = await fetchImpl(url, {
      method: "HEAD",
      signal: timeoutSignal(HEAD_TIMEOUT_MS),
    });
    if (head.ok) {
      log("cached", {
        story_id: storyId,
        hash,
        elapsed_ms: Date.now() - t0,
        text_source: props.text_source,
      });
      return {
        url,
        alt: buildAlt(props.text),
        hash,
        source: "cached",
      };
    }
  } catch (e) {
    // HEAD network error / timeout: assume not cached, fall through to
    // render. We still log so a flaky HEAD layer is observable.
    log("head_failed", {
      story_id: storyId,
      hash,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }

  // 2) Render via Cloud Run. Same env vars the existing dispatcher
  // uses; if either is missing we can't render and fall back to null.
  const cloudRunUrl = process.env.CLOUD_RUN_RENDER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!cloudRunUrl || !cronSecret) {
    log("skipped", {
      story_id: storyId,
      hash,
      reason: "cloud_run_env_missing",
    });
    return null;
  }
  const renderUrl = `${cloudRunUrl.replace(/\/$/, "")}/render-poster`;
  const renderBody = JSON.stringify({
    storyId,
    hash,
    inputProps: {
      scene_1_url: props.scene_1_url,
      // Send both fields — the composition prefers poster_text, but
      // sending hook too means a legacy story (no poster_text) still
      // gets the same payload shape.
      hook: props.text_source === "hook" ? props.text : "",
      poster_text:
        props.text_source === "poster_text" ? props.text : undefined,
      brand_text: "LORE WIRE",
    },
  });
  let renderResp;
  const tRender = Date.now();
  try {
    renderResp = await fetchImpl(renderUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: renderBody,
      signal: timeoutSignal(RENDER_TIMEOUT_MS),
    });
  } catch (e) {
    log("render_failed", {
      story_id: storyId,
      hash,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      elapsed_ms: Date.now() - tRender,
    });
    return null;
  }
  if (!renderResp.ok) {
    const bodyText = await renderResp.text().catch(() => "");
    log("render_failed", {
      story_id: storyId,
      hash,
      http_status: renderResp.status,
      reason: bodyText.slice(0, 200),
      elapsed_ms: Date.now() - tRender,
    });
    return null;
  }
  const data = (await renderResp.json().catch(() => null)) as
    | { url?: unknown; hash?: unknown }
    | null;
  if (!data || typeof data.url !== "string" || data.url.length === 0) {
    log("render_failed", {
      story_id: storyId,
      hash,
      reason: "200 but missing url",
      elapsed_ms: Date.now() - tRender,
    });
    return null;
  }
  log("rendered", {
    story_id: storyId,
    hash,
    elapsed_ms: Date.now() - t0,
    render_elapsed_ms: Date.now() - tRender,
    text_source: props.text_source,
  });
  return {
    url: data.url,
    alt: buildAlt(props.text),
    hash,
    source: "rendered",
  };
}
