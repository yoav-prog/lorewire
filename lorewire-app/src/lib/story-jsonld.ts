// JSON-LD builders for the public story reader (/v/[slug]) —
// _plans/2026-07-05-seo-structured-data.md.
//
// Every published story gets an Article block (headline, dates, publisher);
// stories with a rendered short additionally get a VideoObject, which is
// what makes them eligible for Google's video rich results and gives AI
// answer engines structured facts (upload date, duration, canonical URL)
// instead of prose to guess from.
//
// Pure module: takes a structural slice of StoryRow so tests never touch
// the DB, and the reader page passes the row it already loaded.

import { maybe } from "@/lib/jsonld";

export interface StoryJsonLdInput {
  title: string | null;
  summary: string | null;
  hero_image: string | null;
  thumbnail_image_landscape: string | null;
  video_url: string | null;
  /** "M:SS" as written by the pipeline (media.py _format_duration_ms). */
  duration: string | null;
  published_at: string | null;
  updated_at: string | null;
}

export interface StoryJsonLdContext {
  story: StoryJsonLdInput;
  /** Absolute canonical URL of the story page. */
  canonicalUrl: string;
  /** Publisher brand for the Organization block. */
  siteName: string;
}

// "M:SS" (or a defensive "H:MM:SS") to ISO 8601, e.g. "0:50" -> "PT50S",
// "2:14" -> "PT2M14S". Anything unparseable returns undefined so the
// duration field drops instead of lying.
export function durationToIso8601(
  duration: string | null,
): string | undefined {
  if (!duration) return undefined;
  const parts = duration.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  if (parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const nums = parts.map((p) => parseInt(p, 10));
  const [h, m, s] =
    nums.length === 3 ? nums : [0, nums[0], nums[1]];
  if (s > 59 || (nums.length === 3 && m > 59)) return undefined;
  if (h === 0 && m === 0 && s === 0) return undefined;
  let out = "PT";
  if (h > 0) out += `${h}H`;
  if (m > 0) out += `${m}M`;
  if (s > 0) out += `${s}S`;
  return out;
}

function publisherBlock(siteName: string): Record<string, unknown> {
  return { "@type": "Organization", name: siteName };
}

export function buildStoryJsonLd(
  ctx: StoryJsonLdContext,
): Record<string, unknown>[] {
  const { story, canonicalUrl, siteName } = ctx;
  // Same preference order as the story page's og:image chain: the titled
  // landscape thumbnail first, the clean hero as fallback.
  const image = story.thumbnail_image_landscape ?? story.hero_image ?? "";

  const blocks: Record<string, unknown>[] = [
    maybe({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: story.title ?? undefined,
      description: story.summary ?? undefined,
      image: image || undefined,
      datePublished: story.published_at ?? undefined,
      dateModified: story.updated_at ?? undefined,
      mainEntityOfPage: canonicalUrl,
      publisher: publisherBlock(siteName),
    }),
  ];

  if (story.video_url) {
    blocks.push(
      maybe({
        "@context": "https://schema.org",
        "@type": "VideoObject",
        name: story.title ?? undefined,
        description: story.summary ?? undefined,
        thumbnailUrl: image || undefined,
        uploadDate: story.published_at ?? undefined,
        duration: durationToIso8601(story.duration),
        contentUrl: story.video_url,
        mainEntityOfPage: canonicalUrl,
        publisher: publisherBlock(siteName),
      }),
    );
  }

  return blocks;
}
