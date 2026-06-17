// Pure types, limits, validation, and metadata builders for publishing a short
// to YouTube. No DB or network deps, so it all unit-tests offline. The upload
// engine (network) lives in youtube-upload.ts; the route wires them together.
// Mirrors _reference/youtubestudio/src/lib/publishing-types.ts, adapted to
// Lorewire: no workspace, a Shorts canonical URL, and story-driven defaults.
// Plan: _plans/2026-06-16-multi-platform-shorts-publisher.md sections 3.F2, 7.1.

export type YoutubePrivacy = "private" | "unlisted" | "public";

// YouTube Data API limits. Re-verify against current docs at execution time per
// rule 1; stable through mid-2026. categoryId 22 = "People & Blogs".
export const YOUTUBE_LIMITS = Object.freeze({
  TITLE_MAX: 100,
  DESCRIPTION_MAX: 5000,
  TAGS_TOTAL_LEN_MAX: 500, // sum of all tag char-lengths
  TAG_MAX_LEN: 30,
  TAGS_COUNT_MAX: 15, // plan 3.F2 cap, well under YouTube's own ceiling
});

export const DEFAULT_CATEGORY_ID = "22";

export interface YoutubePublishPayload {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: YoutubePrivacy;
  madeForKids: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateYoutubePayload(p: YoutubePublishPayload): ValidationResult {
  const errors: string[] = [];

  const title = (p.title ?? "").trim();
  if (!title) errors.push("title is required.");
  else if (title.length > YOUTUBE_LIMITS.TITLE_MAX) {
    errors.push(`title must be ${YOUTUBE_LIMITS.TITLE_MAX} chars or fewer.`);
  }

  if ((p.description ?? "").length > YOUTUBE_LIMITS.DESCRIPTION_MAX) {
    errors.push(`description must be ${YOUTUBE_LIMITS.DESCRIPTION_MAX} chars or fewer.`);
  }

  if (p.tags.length > YOUTUBE_LIMITS.TAGS_COUNT_MAX) {
    errors.push(`up to ${YOUTUBE_LIMITS.TAGS_COUNT_MAX} tags allowed.`);
  }
  const totalLen = p.tags.reduce((n, t) => n + t.length, 0);
  if (totalLen > YOUTUBE_LIMITS.TAGS_TOTAL_LEN_MAX) {
    errors.push(`combined tag length must be ${YOUTUBE_LIMITS.TAGS_TOTAL_LEN_MAX} chars or fewer.`);
  }

  if (!["private", "unlisted", "public"].includes(p.privacyStatus)) {
    errors.push('privacyStatus must be "private", "unlisted", or "public".');
  }

  return { ok: errors.length === 0, errors };
}

export interface VideosInsertBody {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
  };
  status: {
    privacyStatus: YoutubePrivacy;
    selfDeclaredMadeForKids: boolean;
  };
}

// Build the videos.insert request body. Defensively clamps to the limits so an
// oversized payload that slipped past validation still produces a legal call.
export function buildVideosInsertBody(p: YoutubePublishPayload): VideosInsertBody {
  return {
    snippet: {
      title: clamp(p.title.trim(), YOUTUBE_LIMITS.TITLE_MAX),
      description: clamp(p.description ?? "", YOUTUBE_LIMITS.DESCRIPTION_MAX),
      tags: dedupeTags(p.tags),
      categoryId: p.categoryId || DEFAULT_CATEGORY_ID,
    },
    status: {
      privacyStatus: p.privacyStatus,
      selfDeclaredMadeForKids: p.madeForKids,
    },
  };
}

// Shorts get their own canonical viewer URL. youtu.be/<id> also resolves, but
// the /shorts/ path keeps the vertical player.
export function buildYoutubeShortUrl(videoId: string): string {
  return `https://www.youtube.com/shorts/${videoId}`;
}

// Map a story into the default YouTube metadata for its short. The operator can
// override these in the Phase 2 customize panel; Phase 1 publishes the defaults.
// Privacy defaults to private: it is the safe choice, and YouTube forces
// API uploads from an unverified app to private anyway until verification
// clears, so this matches reality during Phase 0.
export function mapStoryToYoutubePayload(input: {
  storyTitle: string;
  storySummary?: string | null;
  category?: string | null;
  privacy?: YoutubePrivacy;
  madeForKids?: boolean;
}): YoutubePublishPayload {
  return {
    title: clamp(oneLine(input.storyTitle || "Untitled short"), YOUTUBE_LIMITS.TITLE_MAX),
    description: clamp((input.storySummary ?? "").trim(), YOUTUBE_LIMITS.DESCRIPTION_MAX),
    tags: dedupeTags(input.category ? [input.category] : []),
    categoryId: DEFAULT_CATEGORY_ID,
    privacyStatus: input.privacy ?? "private",
    madeForKids: input.madeForKids ?? false,
  };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

// Normalize, de-duplicate (case-insensitively), per-tag cap, count cap, and
// total-length cap. Mirrors the transformer contract in plan 3.F2.
function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of tags) {
    const tag = oneLine(raw).slice(0, YOUTUBE_LIMITS.TAG_MAX_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= YOUTUBE_LIMITS.TAGS_COUNT_MAX) break;
    if (total + tag.length > YOUTUBE_LIMITS.TAGS_TOTAL_LEN_MAX) break;
    seen.add(key);
    out.push(tag);
    total += tag.length;
  }
  return out;
}
