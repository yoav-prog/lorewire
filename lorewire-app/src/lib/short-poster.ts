// Resolve-or-render the per-story social poster image. Shared by the
// IG / FB / YouTube publishers; TikTok stays on its timestamp-based
// cover (see _plans/2026-06-28-explicit-thumbnail-uploads.md).
//
// Architecture (per _plans/2026-06-28-phase-2-social-poster-render.md):
//
//   1. Read scene_1_url from the freshest `done` row in
//      short_renders.props. Read poster_text from short_config (the
//      cached LLM output). If poster_text is missing, fire a DEDICATED
//      LLM call to generate it from the story body + existing hook,
//      then persist it back to short_config so the next publish hits
//      cache. This LLM call is SEPARATE from the script generation
//      pipeline so the video script + MP4 + hero stay byte-identical
//      to a pre-Phase-2 run (the social-only invariant).
//   2. Brand-safety + glyph + RTL guards on the resolved text. Any
//      failure returns null with a logged reason.
//   3. Compute cache hash =
//      sha256(scene_1_url + "\n" + text + "\n" + POSTER_VERSION).slice(0,16).
//      POSTER_VERSION bumps invalidate every cached poster on the next
//      publish (e.g. when the design tokens change in PosterStill.tsx).
//   4. Compute deterministic GCS / R2 URL. HEAD it with 2s timeout —
//      cache hit returns immediately.
//   5. On cache miss: POST to Cloud Run /render-poster with 8s
//      timeout. Cloud Run renders the still + uploads at the
//      deterministic URL and returns it.
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
import { chatCompletion } from "@/lib/llm";
import { selected as selectedModel } from "@/lib/models";
import {
  parseShortConfig,
  type ShortConfig,
} from "@/lib/short-config";
import { getStory, setStoryShortConfigJson } from "@/lib/repo";
import { rewriteStoredMediaUrl } from "@/lib/media-url";

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
const LLM_TIMEOUT_MS = 30_000;

/** Post-render readiness verify budget. After Cloud Run uploads the
 *  PNG and returns, the freshly-PUT object can take a beat to be
 *  reliably readable through the Cloudflare-fronted MEDIA_PUBLIC_BASE
 *  (eventual visibility through the custom-domain binding, edge-cache
 *  miss timing). The publishers (FB multipart, YT thumbnails.set, IG
 *  cover_url) all silently fall back when the URL 404s, which produces
 *  the "first post has no thumbnail, second post does" symptom because
 *  the second publish hits HEAD cache and never re-races. We verify
 *  before handing the URL to the publisher: HEAD with a few short
 *  retries against the versioned URL (?v=<hash>), succeed on the first
 *  200, log + return null on timeout so the publisher's scene-1
 *  fallback kicks in instead of a broken cover. */
const VERIFY_TIMEOUT_MS = 1500;
const VERIFY_BACKOFFS_MS = [0, 400, 1200, 2500];

/** Setting key for the kill switch (default ON). When OFF, this
 *  function returns null for every call without doing any I/O —
 *  publishers fall back to the PR #137 scene-1-as-cover path. */
const SETTING_ENABLED = "publisher.short_poster.enabled";

/** Conservative English profanity list — duplicated from
 *  `pipeline/shorts_safety.py::PROFANITY`. The dedicated poster-text
 *  LLM call has its own brand-safety instructions, but this defense-
 *  in-depth check catches anything that slips through (and also covers
 *  the `hook` fallback path for legacy stories). */
const PROFANITY = new Set([
  "fuck", "fucking", "fucked", "shit", "shitty", "bullshit",
  "asshole", "bitch", "cunt", "dick", "pussy", "cock",
  "bastard", "damn", "goddamn", "hell",
]);

/** Allowed character set: Basic Latin + Latin-1 Supplement +
 *  Latin Extended-A. Covers English plus accented Latin (é, ñ, ü,
 *  etc.). Hebrew, Arabic, CJK, etc. all reject — PosterStill loads
 *  Bebas Neue (Latin-only) so anything outside would render as tofu.
 *  RTL guard piggybacks on this. */
const SUPPORTED_GLYPH_RE = /^[ -~ -ÿĀ-ſ‐-’“-”…]*$/;

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

/** Test seam for the LLM call inside generatePosterText. Production
 *  wires `chatCompletion` from @/lib/llm; tests pass a fake that
 *  returns a deterministic string without touching OpenAI. */
export type ChatCompletionFn = typeof chatCompletion;
export type SelectedModelFn = typeof selectedModel;

export interface EnsureShortPosterDeps {
  fetch?: PosterFetchLike;
  /** Test override for the settings reader. Production uses
   *  @/lib/repo's getSetting. */
  settings?: SettingLike;
  /** Test override for the LLM call inside generatePosterText. */
  chat?: ChatCompletionFn;
  /** Test override for the model picker. */
  pickModel?: SelectedModelFn;
  /** Test override for the post-render readiness verify backoffs (ms
   *  before each HEAD attempt). Production uses
   *  `VERIFY_BACKOFFS_MS`; tests pass an all-zeros array so the suite
   *  doesn't actually sleep on retry coverage. */
  verifyBackoffsMs?: readonly number[];
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

interface StoryInputs {
  /** Doodle scene-1 GCS URL — the poster's background image. */
  scene_1_url: string;
  /** Spoken cold-open line from the script, if present in props.
   *  Used as context for the LLM call AND as a last-ditch text
   *  fallback when the LLM call itself fails. */
  hook: string | null;
}

/** Read scene_1_url + hook from the freshest `done` short_renders row.
 *  scene_1_url is required (no scene = no poster); hook is optional. */
async function loadStoryInputsFromRender(
  storyId: string,
): Promise<StoryInputs | null> {
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
  // Resolve the stored URL onto the live delivery base. Old stories persist a
  // legacy `storage.googleapis.com/<bucket>/<key>` URL whose object was migrated
  // to R2 — the GCS URL now 404s, so the Cloud Run render fails to load the
  // scene. rewriteStoredMediaUrl flips a legacy GCS URL onto MEDIA_PUBLIC_BASE
  // (query preserved) and is inert for already-on-base / external URLs.
  const resolvedScene = rewriteStoredMediaUrl(scene_1_url);
  const hookRaw = obj.hook;
  const hook =
    typeof hookRaw === "string" && hookRaw.trim().length > 0
      ? hookRaw.trim()
      : null;
  return { scene_1_url: resolvedScene, hook };
}

/** Read the cached poster_text off short_config. Returns null when
 *  the story has no short_config OR the field is missing/empty (the
 *  signal to lazy-generate via LLM). */
async function loadCachedPosterText(storyId: string): Promise<{
  text: string;
  config: ShortConfig;
} | null> {
  const story = await getStory(storyId);
  if (!story?.short_config) return null;
  let parsed;
  try {
    parsed = parseShortConfig(JSON.parse(story.short_config));
  } catch {
    return null;
  }
  if (!parsed.ok) return null;
  const text = parsed.config.poster_text;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return { text: text.trim(), config: parsed.config };
}

/** Persist a freshly-generated poster_text back to short_config so the
 *  next publish hits the cache. Best-effort: a failure logs + skips
 *  the persist (the in-memory text still gets used for THIS publish).
 *  We read the existing short_config to preserve all other fields. */
async function persistPosterText(
  storyId: string,
  text: string,
): Promise<void> {
  const story = await getStory(storyId);
  if (!story) return;
  let config: Record<string, unknown> = {};
  if (story.short_config) {
    try {
      config = JSON.parse(story.short_config);
    } catch {
      // Existing short_config is malformed JSON. Don't clobber it —
      // bail and let a fresh generation run on the next publish.
      log("persist_failed", {
        story_id: storyId,
        reason: "existing short_config is not valid JSON",
      });
      return;
    }
  }
  config.poster_text = text;
  try {
    await setStoryShortConfigJson(storyId, JSON.stringify(config));
  } catch (e) {
    log("persist_failed", {
      story_id: storyId,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }
}

/** Dedicated LLM call that produces the climax-revealing poster line.
 *  Separate from the script generation in pipeline/shorts_narration.py
 *  so the video script + MP4 + hero stay byte-identical to a pre-
 *  Phase-2 run (the social-only invariant). Per
 *  _plans/2026-06-28-phase-2-social-poster-render.md. */
export async function generatePosterText(
  storyId: string,
  deps: { chat?: ChatCompletionFn; pickModel?: SelectedModelFn } = {},
): Promise<string | null> {
  const story = await getStory(storyId);
  if (!story) return null;
  const title = (story.title ?? "").trim();
  const body = (story.body ?? "").trim();
  if (!body && !title) return null;
  // Cap body so a 12 kb article doesn't blow the prompt budget. Same
  // window the category classifier uses for the same reason.
  const bodyForPrompt = body.length > 2000 ? body.slice(0, 2000) : body;

  // Load the spoken hook from the latest render row (if present) so
  // the LLM sees what the script said and writes the poster line in
  // the same emotional register without contradicting it.
  const inputs = await loadStoryInputsFromRender(storyId);
  const hookHint = inputs?.hook
    ? `\nThe spoken cold-open line (for tone alignment only — do NOT copy):\n"""${inputs.hook}"""\n`
    : "";

  const chat = deps.chat ?? chatCompletion;
  const pickModel = deps.pickModel ?? selectedModel;
  const modelId = await pickModel("llm");

  const system =
    "You write social-media cover tile lines for Lorewire shorts. " +
    "Each line goes on a STATIC poster image a stranger sees in the IG / " +
    "FB / YouTube grid BEFORE the video plays. Goal: stop the scroll by " +
    "naming the dramatic moment CLEARLY so the stranger instantly " +
    "understands the stakes and clicks.\n\n" +
    "RULES (every line must obey):\n" +
    "  - Length: 8-14 words. One or two short sentences. Renders in " +
    "ALL CAPS — avoid idioms that lose meaning in caps.\n" +
    "  - Name the dramatic event SPECIFICALLY (who, what happened). " +
    "Do NOT spoil the resolution (keep curiosity intact).\n" +
    "  - BAD (abstract metaphor): \"Everything changed.\" \"Nothing was " +
    "the same.\"\n" +
    "  - GOOD (concrete event): \"Her wedding dress was destroyed the " +
    "morning of the ceremony.\" \"She refused. He emptied their joint " +
    "account by morning.\"\n" +
    "  - No all-caps shock words inside the line, no profanity, no PII.\n" +
    "  - Defendable against the source story — never invent facts.\n\n" +
    "Output ONLY the line itself. No prose before or after, no quotes, " +
    "no markdown, no JSON.";

  const user =
    `Title: ${title || "(untitled)"}\n` +
    `Source story:\n"""${bodyForPrompt}"""\n${hookHint}\n` +
    `Write the poster line now.`;

  const result = await chat({
    modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.6,
    maxCompletionTokens: 80,
  });
  if (!result.ok) {
    log("llm_failed", {
      story_id: storyId,
      reason: result.error.slice(0, 200),
    });
    return null;
  }
  // Strip wrapping quotes / whitespace; the model sometimes returns
  // "Her wedding dress was destroyed." with explicit quotes despite
  // the prompt asking for raw text. Also strip a trailing newline.
  let text = result.content.trim();
  text = text.replace(/^["“']+|["”']+$/g, "").trim();
  // Truncate to the cap as defense in depth — if the LLM ignores the
  // 8-14 word budget, we don't ship a 300-word run-on.
  if (text.length > HOOK_MAX_CHARS) text = text.slice(0, HOOK_MAX_CHARS);
  if (text.length === 0) {
    log("llm_failed", {
      story_id: storyId,
      reason: "empty completion",
    });
    return null;
  }
  return text;
}

/** Pre-render guards. Returns the reason string if rejected, null if OK. */
function guardText(text: string): string | null {
  if (text.length > HOOK_MAX_CHARS) return "text_too_long";
  if (!SUPPORTED_GLYPH_RE.test(text)) return "glyph_unsupported";
  // No all-caps guard: PosterStill / PosterStillLandscape uppercase the text
  // for display (`text.trim().toUpperCase()`), so all-caps and mixed-case
  // inputs render identically. Rejecting all-caps only blocked LoreWire's
  // house-style (all-caps) hooks for zero visual change.
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

  const inputs = await loadStoryInputsFromRender(storyId);
  if (!inputs) {
    log("skipped", { story_id: storyId, reason: "missing_render_props" });
    return null;
  }
  if (inputs.scene_1_url.length > URL_MAX_CHARS) {
    log("skipped", {
      story_id: storyId,
      reason: "scene_1_url_too_long",
    });
    return null;
  }

  // Resolve the poster text: prefer the cached short_config.poster_text;
  // if missing, generate via dedicated LLM call + persist back so the
  // next publish hits cache; if the LLM call also fails, fall back to
  // the spoken hook for legacy / first-publish failure cases.
  let text: string;
  let textSource: "config" | "generated" | "hook" = "config";
  const cached = await loadCachedPosterText(storyId);
  if (cached) {
    text = cached.text;
  } else {
    const generated = await generatePosterText(storyId, {
      chat: deps.chat,
      pickModel: deps.pickModel,
    });
    if (generated) {
      text = generated;
      textSource = "generated";
      // Persist for next publish. Best-effort — a failure here doesn't
      // block this publish.
      await persistPosterText(storyId, generated);
    } else if (inputs.hook) {
      text = inputs.hook;
      textSource = "hook";
    } else {
      log("skipped", {
        story_id: storyId,
        reason: "no_text_source",
      });
      return null;
    }
  }

  const guard = guardText(text);
  if (guard) {
    log("skipped", {
      story_id: storyId,
      reason: guard,
      text_source: textSource,
    });
    return null;
  }

  const hash = computePosterHash(inputs.scene_1_url, text);
  const baseUrl = posterUrlForKey(storyId, hash);
  if (!baseUrl) {
    log("skipped", { story_id: storyId, reason: "no_media_base" });
    return null;
  }
  // The URL we hand to publishers carries `?v=<hash>` for two reasons:
  // (a) on re-publish the Twitter/IG/FB share-card crawlers re-fetch
  //     a fresh URL instead of a stale cached one (mirrors the OG path
  //     at ogPosterUrlForKey + versionedUrl);
  // (b) each unique URL is a fresh CDN cache key, so a brief negative-
  //     cache 404 from a pre-render HEAD can't poison the post-render
  //     verify or the publisher's subsequent GET.
  const url = versionedUrl(baseUrl, hash);

  // 1) Cache HEAD with a short budget. Probe the versioned URL so
  //    both the cache check and the publisher fetch hit the same
  //    cache key — important once the object exists, since we want
  //    every retry on the same story to land on a warm cache entry.
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
        text_source: textSource,
      });
      return {
        url,
        alt: buildAlt(text),
        hash,
        source: "cached",
      };
    }
  } catch (e) {
    log("head_failed", {
      story_id: storyId,
      hash,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }

  // 2) Render via Cloud Run.
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
  // The helper already resolved which text to use (cached
  // short_config.poster_text → freshly-generated LLM line → spoken
  // hook fallback). PosterStill takes a single `text` prop — no
  // dual-field precedence in the composition, no upstream-vs-
  // downstream picking. Same payload shape regardless of text_source
  // so the Cloud Run validator stays simple.
  const renderBody = JSON.stringify({
    storyId,
    hash,
    inputProps: {
      scene_1_url: inputs.scene_1_url,
      text,
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
    text_source: textSource,
  });
  // Mark the LLM-call latency separately so the operator can tell
  // whether a slow publish was the LLM or the render. (Both are
  // contained in the elapsed_ms above, but split fields help triage.)
  void LLM_TIMEOUT_MS; // placeholder reference — used in future LLM streaming.

  // 3) Readiness verify. Cloud Run has confirmed the PUT to R2/GCS, but
  //    the publishers will fetch the URL through MEDIA_PUBLIC_BASE
  //    (Cloudflare custom domain), and a brand-new object isn't always
  //    immediately visible there. Without this gate, FB's silent thumb
  //    fallback / IG's silent thumb_offset=0 fallback / YT's
  //    thumbnails.set 404 strip the cover on the first publish and the
  //    next publish (HEAD cache hit, no race) restores it. We poll the
  //    versioned URL until it's readable, then hand it off.
  const verified = await verifyPosterReadable(url, fetchImpl, {
    storyId,
    hash,
    backoffsMs: deps.verifyBackoffsMs ?? VERIFY_BACKOFFS_MS,
  });
  if (!verified) {
    log("propagation_timeout", {
      story_id: storyId,
      hash,
      elapsed_ms: Date.now() - t0,
      render_elapsed_ms: Date.now() - tRender,
    });
    return null;
  }

  return {
    url,
    alt: buildAlt(text),
    hash,
    source: "rendered",
  };
}

/** HEAD the freshly-rendered URL until it returns 200 or the retry
 *  budget is exhausted. Each attempt is a fresh HEAD with its own
 *  timeout so a stuck connection on one edge doesn't burn the whole
 *  budget. Returns true on first success, false after all backoffs. */
async function verifyPosterReadable(
  url: string,
  fetchImpl: PosterFetchLike,
  ctx: { storyId: string; hash: string; backoffsMs: readonly number[] },
): Promise<boolean> {
  for (let attempt = 0; attempt < ctx.backoffsMs.length; attempt++) {
    const delay = ctx.backoffsMs[attempt];
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const resp = await fetchImpl(url, {
        method: "HEAD",
        signal: timeoutSignal(VERIFY_TIMEOUT_MS),
      });
      if (resp.ok) {
        log("verify_ok", {
          story_id: ctx.storyId,
          hash: ctx.hash,
          attempt: attempt + 1,
        });
        return true;
      }
      log("verify_miss", {
        story_id: ctx.storyId,
        hash: ctx.hash,
        attempt: attempt + 1,
        http_status: resp.status,
      });
    } catch (e) {
      log("verify_error", {
        story_id: ctx.storyId,
        hash: ctx.hash,
        attempt: attempt + 1,
        reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
  }
  return false;
}

// ─── Phase 3: OG / Twitter landscape poster ───────────────────────────────────
//
// _plans/2026-06-29-phase-3-og-poster-cards.md.
//
// `ensureOgPoster` is a SECOND, parallel helper to ensureShortPoster.
// Same LLM call (`generatePosterText`), same brand-safety / glyph /
// RTL guards, same Cloud Run /render-poster endpoint — but:
//   - Requests `aspect: "landscape"` (1200×630, not 1080×1920).
//   - Reads / writes its OWN cached state on short_config
//     (`og_poster_landscape_url`, `og_poster_disabled`, `og_poster_attempted_at`)
//     so the Phase 2 portrait path stays byte-identical (no regression
//     for the IG / FB / YT publishers).
//   - Embeds a query-string version (`?v={hash}`) in the returned URL.
//     Twitter's Card Validator was deprecated in 2025; query-string
//     change is the only working cache-busting mechanism for X. Other
//     crawlers (FB, LinkedIn, Slack, Discord, iMessage, WhatsApp) also
//     treat a different query string as a different resource.
//   - Stamps `og_poster_attempted_at` on EVERY attempt (success or
//     guarded failure) so the one-shot backfill script can skip
//     stories that just failed instead of re-attempting them every
//     run (per the council Contrarian's Failure Mode #1).
//
// Returns a shape that maps cleanly into Next.js metadata:
// `{ url, width, height, alt, hash, source }`.

/** Setting key for the OG kill switch (default ON). Independent from
 *  the Phase 2 publisher kill switch so an OG-specific issue (a
 *  crawler bug, a viral takedown) can revert ONLY the OG path. */
const SETTING_OG_ENABLED = "og.short_poster.enabled";

/** How long after a guarded failure (profanity / glyph / RTL / missing
 *  scene_1) we wait before re-attempting the same story. 7 days lets
 *  an admin edit / re-publish recover lazily, but stops the backfill
 *  script from burning Cloud Run cycles on the same broken stories
 *  every hour. Per Contrarian Failure Mode #1. */
const OG_REATTEMPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Landscape dimensions — duplicated here from `video/src/PosterStill.tsx`'s
 *  `LANDSCAPE_WIDTH` / `LANDSCAPE_HEIGHT` to avoid pulling the Remotion
 *  composition file into the Next bundle. The values are baked into the
 *  composition contract; if you change them, change both places (a unit
 *  test pins parity). */
export const OG_POSTER_WIDTH = 1200;
export const OG_POSTER_HEIGHT = 630;

export interface OgPoster {
  /** Public URL of the landscape poster PNG, query-string-versioned
   *  (`...png?v={hash}`) for platform cache-busting. */
  url: string;
  alt: string;
  hash: string;
  width: typeof OG_POSTER_WIDTH;
  height: typeof OG_POSTER_HEIGHT;
  source: PosterSource;
}

export interface EnsureOgPosterDeps {
  fetch?: PosterFetchLike;
  settings?: SettingLike;
  chat?: ChatCompletionFn;
  pickModel?: SelectedModelFn;
  /** Test seam for the persistence call. Production uses
   *  `setStoryShortConfigJson` from @/lib/repo; tests pass a fake
   *  that records what was written. */
  persistConfig?: (storyId: string, configJson: string) => Promise<void>;
  /** Test seam for `now()` so the attempted_at window math is
   *  deterministic. Defaults to `Date.now`. */
  now?: () => number;
}

function ogLog(event: string, fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console -- rule 14: namespaced observability
  console.info(`[og poster ${event}]`, JSON.stringify(fields));
}

/** Compute the landscape cache hash. Includes the literal "landscape"
 *  string so portrait and landscape can't collide on the same
 *  scene_1+text — even if a future POSTER_VERSION bump happens to land
 *  on the same hash. */
export function computeOgPosterHash(scene_1_url: string, text: string): string {
  return createHash("sha256")
    .update(scene_1_url)
    .update("\n")
    .update(text)
    .update("\n")
    .update("landscape")
    .update("\n")
    .update(POSTER_VERSION)
    .digest("hex")
    .slice(0, 16);
}

/** Build the deterministic public URL for the landscape poster PNG.
 *  Mirrors the GCS key Cloud Run writes to in video/server/render.ts
 *  for `aspect: "landscape"`. The returned URL does NOT yet carry the
 *  `?v={hash}` query string — that's added by the caller (so the HEAD
 *  cache check can probe the raw bytes without the query string, which
 *  most CDNs ignore for object lookup). */
function ogPosterUrlForKey(storyId: string, hash: string): string {
  const key = `${sanitizeStoryId(storyId)}-short/poster-landscape-${hash}.png`;
  const base = mediaPublicBase();
  if (base) return `${base}/${key}`;
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return "";
  return `https://storage.googleapis.com/${bucket}/${key}`;
}

/** Append the cache-busting query string. Per the crawler-doc audit:
 *  Twitter's Card Validator is deprecated (2025) and there's no API
 *  purge mechanism; query-string change is the only working cache-
 *  busting method. Other platforms also accept it. */
function versionedUrl(baseUrl: string, hash: string): string {
  return `${baseUrl}?v=${hash}`;
}

/** Read the cached OG poster state off short_config. Returns:
 *   - { url, disabled, attemptedAtIso, config } when the row has a
 *     short_config we can parse;
 *   - null when the row / short_config is missing or unparseable.
 *
 *  Caller decides what to do with each field. Disabled stories get
 *  short-circuited before any I/O. */
async function loadCachedOgPosterState(storyId: string): Promise<{
  url: string | undefined;
  disabled: boolean;
  attemptedAtIso: string | undefined;
  config: Record<string, unknown>;
} | null> {
  const story = await getStory(storyId);
  if (!story?.short_config) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(story.short_config);
  } catch {
    return null;
  }
  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    return null;
  }
  const config = parsedJson as Record<string, unknown>;
  const url =
    typeof config.og_poster_landscape_url === "string"
      ? config.og_poster_landscape_url
      : undefined;
  const disabled = config.og_poster_disabled === true;
  const attemptedAtIso =
    typeof config.og_poster_attempted_at === "string"
      ? config.og_poster_attempted_at
      : undefined;
  return { url, disabled, attemptedAtIso, config };
}

/** Persist the OG poster state back to short_config. Writes whichever
 *  of `og_poster_landscape_url` / `og_poster_attempted_at` are passed
 *  (skip with `undefined` to leave a field untouched). Best-effort:
 *  a failure logs + skips so the in-memory result still flows to the
 *  caller for THIS request. */
async function persistOgPosterState(
  storyId: string,
  patch: {
    url?: string;
    attemptedAtIso?: string;
  },
  deps: { persistConfig?: (storyId: string, configJson: string) => Promise<void> },
): Promise<void> {
  const cached = await loadCachedOgPosterState(storyId);
  const config: Record<string, unknown> = cached?.config ?? {};
  if (patch.url !== undefined) {
    config.og_poster_landscape_url = patch.url;
  }
  if (patch.attemptedAtIso !== undefined) {
    config.og_poster_attempted_at = patch.attemptedAtIso;
  }
  try {
    if (deps.persistConfig) {
      await deps.persistConfig(storyId, JSON.stringify(config));
    } else {
      await setStoryShortConfigJson(storyId, JSON.stringify(config));
    }
  } catch (e) {
    ogLog("persist_failed", {
      story_id: storyId,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }
}

export async function ensureOgPoster(
  storyId: string,
  deps: EnsureOgPosterDeps = {},
): Promise<OgPoster | null> {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const settings = deps.settings ?? (await import("@/lib/repo"));
  const now = deps.now ?? Date.now;

  const t0 = now();

  // Kill switch — admin can flip OFF without code change if a 2026
  // crawler bug or a viral takedown demands reverting the OG path
  // without touching the publisher cover path. Default ON.
  const enabledRaw = (await settings.getSetting(SETTING_OG_ENABLED)) ?? "1";
  if (enabledRaw === "0") {
    ogLog("ensure_skipped", { story_id: storyId, reason: "setting_off" });
    return null;
  }

  // Per-story kill switch. The metadata reader respects this too, but
  // checking here saves work when the backfill script revisits a
  // disabled story.
  const cached = await loadCachedOgPosterState(storyId);
  if (cached?.disabled) {
    ogLog("ensure_skipped", {
      story_id: storyId,
      reason: "disabled_per_story",
    });
    return null;
  }

  // Render inputs (scene_1_url + spoken hook fallback) come from the
  // shared portrait-helper loader so both paths see the same picks.
  const inputs = await loadStoryInputsFromRender(storyId);
  if (!inputs) {
    ogLog("ensure_skipped", {
      story_id: storyId,
      reason: "missing_render_props",
    });
    return null;
  }
  if (inputs.scene_1_url.length > URL_MAX_CHARS) {
    ogLog("ensure_skipped", {
      story_id: storyId,
      reason: "scene_1_url_too_long",
    });
    return null;
  }

  // Resolve poster text — same flow as portrait. Cache > LLM generate +
  // persist > spoken hook fallback. Sharing the LLM call means a story's
  // first publish to ANY surface (social or OG) generates the text once,
  // and both surfaces see it.
  const cachedText = await loadCachedPosterText(storyId);
  let text: string;
  let textSource: "config" | "generated" | "hook" = "config";
  if (cachedText) {
    text = cachedText.text;
  } else {
    const generated = await generatePosterText(storyId, {
      chat: deps.chat,
      pickModel: deps.pickModel,
    });
    if (generated) {
      text = generated;
      textSource = "generated";
      await persistPosterText(storyId, generated);
    } else if (inputs.hook) {
      text = inputs.hook;
      textSource = "hook";
    } else {
      ogLog("ensure_skipped", {
        story_id: storyId,
        reason: "no_text_source",
      });
      // Stamp attempted_at so the backfill script doesn't immediately
      // retry this story (we just spent an LLM call to learn it can't
      // be rendered today).
      const nowIso = new Date(now()).toISOString();
      await persistOgPosterState(
        storyId,
        { attemptedAtIso: nowIso },
        { persistConfig: deps.persistConfig },
      );
      return null;
    }
  }

  // Guards. Reuse the portrait helper's text guard (same brand-safety,
  // glyph, RTL rules). On rejection: stamp attempted_at so the
  // backfill script's 7-day window kicks in, then return null.
  const guard = guardText(text);
  if (guard) {
    const nowIso = new Date(now()).toISOString();
    ogLog("ensure_skipped", {
      story_id: storyId,
      reason: guard,
      text_source: textSource,
    });
    await persistOgPosterState(
      storyId,
      { attemptedAtIso: nowIso },
      { persistConfig: deps.persistConfig },
    );
    return null;
  }

  // Hash + URL. The HEAD cache check probes the raw URL (no query
  // string — most CDNs ignore query strings for object lookup, so the
  // bytes-at-URL check is the same with or without `?v=`). The returned
  // URL DOES include `?v=` for platform cache invalidation.
  const hash = computeOgPosterHash(inputs.scene_1_url, text);
  const baseUrl = ogPosterUrlForKey(storyId, hash);
  if (!baseUrl) {
    ogLog("ensure_skipped", { story_id: storyId, reason: "no_media_base" });
    return null;
  }
  const url = versionedUrl(baseUrl, hash);

  // 1) HEAD the raw URL — cache hit returns immediately.
  try {
    const head = await fetchImpl(baseUrl, {
      method: "HEAD",
      signal: timeoutSignal(HEAD_TIMEOUT_MS),
    });
    if (head.ok) {
      const nowIso = new Date(now()).toISOString();
      ogLog("cached", {
        story_id: storyId,
        hash,
        elapsed_ms: now() - t0,
        text_source: textSource,
      });
      // Stamp the URL + attempted_at so the metadata reader picks up
      // the cache hit on the next page load (it would have worked
      // without this stamp because we return the URL, but stamping
      // means a future OG bot fetch reads it O(1) from short_config
      // without re-running ensureOgPoster).
      await persistOgPosterState(
        storyId,
        { url, attemptedAtIso: nowIso },
        { persistConfig: deps.persistConfig },
      );
      return {
        url,
        alt: buildAlt(text),
        hash,
        width: OG_POSTER_WIDTH,
        height: OG_POSTER_HEIGHT,
        source: "cached",
      };
    }
  } catch (e) {
    ogLog("head_failed", {
      story_id: storyId,
      hash,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }

  // 2) Render via Cloud Run with aspect=landscape.
  const cloudRunUrl = process.env.CLOUD_RUN_RENDER_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!cloudRunUrl || !cronSecret) {
    ogLog("ensure_skipped", {
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
    aspect: "landscape",
    inputProps: {
      scene_1_url: inputs.scene_1_url,
      text,
      brand_text: "LORE WIRE",
    },
  });
  let renderResp;
  const tRender = now();
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
    // Stamp attempted_at on render-failure too — a transient Cloud Run
    // outage shouldn't trigger immediate retry on every story in the
    // backfill window.
    const nowIso = new Date(now()).toISOString();
    ogLog("render_failed", {
      story_id: storyId,
      hash,
      reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      elapsed_ms: now() - tRender,
    });
    await persistOgPosterState(
      storyId,
      { attemptedAtIso: nowIso },
      { persistConfig: deps.persistConfig },
    );
    return null;
  }
  if (!renderResp.ok) {
    const bodyText = await renderResp.text().catch(() => "");
    const nowIso = new Date(now()).toISOString();
    ogLog("render_failed", {
      story_id: storyId,
      hash,
      http_status: renderResp.status,
      reason: bodyText.slice(0, 200),
      elapsed_ms: now() - tRender,
    });
    await persistOgPosterState(
      storyId,
      { attemptedAtIso: nowIso },
      { persistConfig: deps.persistConfig },
    );
    return null;
  }
  const data = (await renderResp.json().catch(() => null)) as
    | { url?: unknown; hash?: unknown }
    | null;
  if (!data || typeof data.url !== "string" || data.url.length === 0) {
    const nowIso = new Date(now()).toISOString();
    ogLog("render_failed", {
      story_id: storyId,
      hash,
      reason: "200 but missing url",
      elapsed_ms: now() - tRender,
    });
    await persistOgPosterState(
      storyId,
      { attemptedAtIso: nowIso },
      { persistConfig: deps.persistConfig },
    );
    return null;
  }
  // Cloud Run returns the base URL; we add `?v=` here so the stamped
  // URL is platform-cache-bustable on every share.
  const versioned = versionedUrl(data.url, hash);
  const nowIso = new Date(now()).toISOString();
  ogLog("rendered", {
    story_id: storyId,
    hash,
    elapsed_ms: now() - t0,
    render_elapsed_ms: now() - tRender,
    text_source: textSource,
  });
  await persistOgPosterState(
    storyId,
    { url: versioned, attemptedAtIso: nowIso },
    { persistConfig: deps.persistConfig },
  );
  return {
    url: versioned,
    alt: buildAlt(text),
    hash,
    width: OG_POSTER_WIDTH,
    height: OG_POSTER_HEIGHT,
    source: "rendered",
  };
}

/** The one-shot backfill script's gate: should this story be
 *  re-attempted right now? Returns true when the story has never
 *  been attempted OR the last attempt is older than
 *  `OG_REATTEMPT_WINDOW_MS`. The script reads `og_poster_attempted_at`
 *  off short_config and feeds it here, so we don't re-query the DB. */
export function shouldReattemptOgPoster(
  attemptedAtIso: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!attemptedAtIso) return true;
  const attemptedAt = Date.parse(attemptedAtIso);
  if (!Number.isFinite(attemptedAt)) return true;
  return now - attemptedAt >= OG_REATTEMPT_WINDOW_MS;
}
