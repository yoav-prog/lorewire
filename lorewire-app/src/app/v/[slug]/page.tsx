// /v/[slug] — public reader for a single story (video). Companion to the
// /articles/[locale]/[slug] reader for articles.
//
// Server component. Loads the row via stories-public (drafts and archived
// are filtered out), renders the video player when video_url is present,
// falls back to a hero image otherwise. Body text + source attribution
// underneath. Metadata follows the same shape as the article reader:
// reads site-wide seo.* settings, honors the per-row noindex flag, emits
// an OG video card when there's a video URL and a regular article card
// when there isn't.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublishedStoryBySlug } from "@/lib/stories-public";
import { getSiteSeo, buildPageTitle } from "@/lib/site-seo";
import { getSetting } from "@/lib/repo";
import { parseShortConfig } from "@/lib/short-config";
import { OG_POSTER_HEIGHT, OG_POSTER_WIDTH } from "@/lib/short-poster";
import {
  aspectDims,
  isVideoAspect,
  resolveAspect,
  type VideoAspect,
} from "@/lib/aspect";
import { PollWidget } from "@/components/PollWidget";
import {
  getAggregateByStoryId,
  getPollByStoryId,
  getVoteSideForCookie,
  resolvePublicFloor,
  topDivisive,
  toResultView,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";
import { getSubmissionAttribution } from "@/lib/submissions";
import { SubmissionReportLink } from "./SubmissionReportLink";

// Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: resolve the
// rendered aspect for a story so the reader's <video> container CSS
// + the OG video card's width/height match what the renderer produced.
// Goes through the same chain as the pipeline + renderer:
//   per-story video_config.aspect -> global default -> legacy 9:16.
async function resolveStoryAspect(
  videoConfig: string | null | undefined,
): Promise<VideoAspect> {
  let configAspect: VideoAspect | undefined;
  if (videoConfig) {
    try {
      const parsed = JSON.parse(videoConfig);
      if (
        parsed &&
        typeof parsed === "object" &&
        isVideoAspect((parsed as { aspect?: unknown }).aspect)
      ) {
        configAspect = (parsed as { aspect: VideoAspect }).aspect;
      }
    } catch {
      // malformed config column — fall through to the global default
    }
  }
  const globalRaw = await getSetting("video.default_aspect");
  const global = isVideoAspect(globalRaw) ? globalRaw : undefined;
  return resolveAspect(configAspect, global);
}

interface Params {
  slug: string;
}

function resolveOrigin(siteUrlSetting: string): string {
  return (
    siteUrlSetting || process.env.NEXT_PUBLIC_SITE_ORIGIN || ""
  ).replace(/\/$/, "");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const story = await getPublishedStoryBySlug(slug);
  const seo = await getSiteSeo();
  if (!story) {
    return {
      title: buildPageTitle("Not found", seo.titleTemplate, seo.siteName),
    };
  }
  const origin = resolveOrigin(seo.siteUrl);
  const canonical = `${origin}/v/${story.slug}`;
  const pageTitle = story.title ?? "Story";
  const title = buildPageTitle(pageTitle, seo.titleTemplate, seo.siteName);
  const description =
    story.summary ?? seo.defaultMetaDescription;
  const heroImage = story.hero_image ?? seo.defaultOgImage ?? undefined;
  const videoUrl = story.video_url ?? undefined;
  const noindex = story.noindex === 1;
  const videoAspect = await resolveStoryAspect(story.video_config);
  const videoDims = aspectDims(videoAspect);

  // Phase 3 OG-poster surface (_plans/2026-06-29-phase-3-og-poster-cards.md).
  // Reads the stamped landscape URL off short_config — O(1), no
  // request-path render call (OG bots time out at 3-5s; LLM + Cloud Run
  // render takes 6-10s, so generation runs in publisher hook + backfill
  // script only). Respects the per-story kill switch (`og_poster_disabled`)
  // so a bad poster can be removed without bumping POSTER_VERSION globally.
  // When the URL is missing or disabled, falls back to hero_image →
  // defaultOgImage — the pre-Phase-3 chain, unchanged.
  let ogPosterUrl: string | undefined;
  if (story.short_config) {
    try {
      const parsed = parseShortConfig(JSON.parse(story.short_config));
      if (
        parsed.ok &&
        parsed.config.og_poster_landscape_url &&
        !parsed.config.og_poster_disabled
      ) {
        ogPosterUrl = parsed.config.og_poster_landscape_url;
      }
    } catch {
      // malformed short_config — fall through to hero chain
    }
  }
  const ogImage = ogPosterUrl ?? heroImage;
  // og:image:width / og:image:height are non-negotiable per the
  // crawler-doc audit: WhatsApp silently drops the preview on first
  // share without them; Facebook benefits too (synchronous render).
  // Set ONLY when we have a designed poster; the legacy hero fallback
  // has unknown dimensions so we let the crawler sniff bytes.
  const ogImageWidth = ogPosterUrl ? OG_POSTER_WIDTH : undefined;
  const ogImageHeight = ogPosterUrl ? OG_POSTER_HEIGHT : undefined;
  // Force summary_large_image when the poster is present so Twitter
  // renders the 1200×630 designed landscape correctly. Without the
  // override, Twitter would respect seo.twitterCardType (often
  // "summary" by default), which renders as a small square thumb.
  const twitterCardType = ogPosterUrl
    ? "summary_large_image"
    : seo.twitterCardType;
  // twitter:image explicit removes Twitterbot's array-order ambiguity
  // — verified via the crawler-doc audit: Twitter looks for
  // twitter:image first, falls back to og:image, so an explicit
  // setting is the surest way to control what X picks.
  const twitterImage = ogPosterUrl ?? heroImage;

  return {
    title,
    description,
    alternates: { canonical },
    robots: noindex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: videoUrl ? "video.other" : "article",
      url: canonical,
      siteName: seo.siteName,
      images: ogImage
        ? [
            {
              url: ogImage,
              width: ogImageWidth,
              height: ogImageHeight,
              alt: `Lorewire: ${pageTitle}`,
            },
          ]
        : undefined,
      videos: videoUrl
        ? [
            {
              url: videoUrl,
              type: "video/mp4",
              width: videoDims.width,
              height: videoDims.height,
            },
          ]
        : undefined,
    },
    twitter: {
      card: twitterCardType,
      title,
      description,
      images: twitterImage ? [twitterImage] : undefined,
      site: seo.twitterHandle || undefined,
    },
    verification: {
      google: seo.googleVerification || undefined,
      other: seo.bingVerification
        ? { "msvalidate.01": seo.bingVerification }
        : undefined,
    },
  };
}

export default async function StoryReader({
  params,
}: {
  params: Promise<Params>;
}) {
  const { slug } = await params;
  const story = await getPublishedStoryBySlug(slug);
  if (!story) notFound();

  const videoAspect = await resolveStoryAspect(story.video_config);
  const videoCssRatio = aspectDims(videoAspect).cssRatio;

  // User-submitted stories carry no Reddit source; instead we attribute them to
  // the submitter, linking to their public contributor profile (unless they've
  // hidden it or are suspended, in which case the name shows as plain text).
  const attribution = story.submission_id
    ? await getSubmissionAttribution(story.submission_id)
    : null;

  // Phase 2 of _plans/2026-06-17-engagement-polls.md. The widget
  // lives between video and body — high enough that a phone user
  // sees it after the play, low enough that the question doesn't
  // pre-empt the story. We resolve the poll + aggregate + already-
  // voted-side server-side so the first paint is correct (no post-
  // hydration flash from pre-vote to post-vote). `voteToken` is
  // read-only here — the cookie is only ISSUED on the first POST to
  // /api/polls/vote, where a Set-Cookie response can be honored.
  const poll = await getPollByStoryId(story.id);
  const hasLivePoll = poll !== null && poll.enabled === 1;
  const [voteToken, pollAggregate] = hasLivePoll
    ? await Promise.all([
        readVoteToken(),
        getAggregateByStoryId(story.id),
      ])
    : [null, null];
  const initialVotedSide = hasLivePoll
    ? await getVoteSideForCookie(poll!.id, voteToken)
    : null;
  const pollResultView = hasLivePoll
    ? toResultView(pollAggregate, await resolvePublicFloor())
    : null;

  // Phase 4 of _plans/2026-06-17-engagement-polls.md. Resolve a
  // follow-up story for the post-vote reveal — the closest-split
  // story in the same category, excluding the current one. Empty
  // result is fine: the widget hides the link when followUp is null.
  // We only bother resolving when the story HAS a live poll, since
  // the widget is the only consumer.
  const pollFollowUp = hasLivePoll
    ? await resolveFollowUp(story.id, story.category)
    : null;

  console.info("[story reader] render", {
    id: story.id,
    slug: story.slug,
    has_video: Boolean(story.video_url),
    has_audio: Boolean(story.audio_url),
    aspect: videoAspect,
    bodyLen: story.body?.length ?? 0,
    has_poll: hasLivePoll,
    poll_already_voted: Boolean(initialVotedSide),
  });

  // Body is plain text from the Reddit pipeline; render as paragraphs so
  // line breaks survive without dropping HTML support into the schema.
  const paragraphs = (story.body ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <main className="mx-auto max-w-[760px] px-5 py-10">
      <article className="space-y-6">
        <header className="space-y-3">
          {story.category && (
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              {story.category}
            </p>
          )}
          <h1 className="font-display text-[34px] font-extrabold leading-tight tracking-tightest text-ink">
            {story.title}
          </h1>
          {story.summary && (
            <p className="text-[16px] leading-relaxed text-muted">
              {story.summary}
            </p>
          )}
        </header>

        {story.video_url ? (
          <div className="overflow-hidden rounded-2xl border border-line bg-bg">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={story.video_url}
              controls
              playsInline
              preload="metadata"
              poster={story.hero_image ?? undefined}
              className="block w-full"
              style={{ aspectRatio: videoCssRatio }}
            />
          </div>
        ) : story.hero_image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={story.hero_image}
            alt={story.title ?? ""}
            className="block w-full rounded-2xl border border-line"
          />
        ) : null}

        {hasLivePoll && poll && pollResultView && (
          <PollWidget
            pollId={poll.id}
            question={poll.question}
            optionA={poll.option_a_text}
            optionB={poll.option_b_text}
            initialResult={pollResultView}
            initialVotedSide={initialVotedSide}
            followUp={pollFollowUp}
          />
        )}

        {story.audio_url && !story.video_url && (
          <audio
            src={story.audio_url}
            controls
            preload="metadata"
            className="block w-full"
          />
        )}

        {paragraphs.length > 0 && (
          <div className="space-y-4 text-[17px] leading-relaxed text-ink">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}

        {story.submission_id && (
          <footer className="border-t border-line pt-4 text-[13px] text-muted">
            {attribution && (
              <p>
                Submitted by{" "}
                {attribution.profilePublic ? (
                  <Link
                    href={`/u/${attribution.userId}`}
                    className="font-medium text-ink underline decoration-line hover:decoration-accent"
                  >
                    {attribution.displayName}
                  </Link>
                ) : (
                  <span className="font-medium text-ink">
                    {attribution.displayName}
                  </span>
                )}
              </p>
            )}
            <div className={attribution ? "mt-2" : undefined}>
              <SubmissionReportLink storyId={story.id} />
            </div>
          </footer>
        )}

        {story.source_url && (
          <footer className="border-t border-line pt-4 text-[13px] text-muted">
            <span>Source: </span>
            <Link
              href={story.source_url}
              className="text-ink underline decoration-line hover:decoration-accent"
              target="_blank"
              rel="noopener noreferrer"
            >
              {story.source_url}
            </Link>
          </footer>
        )}
      </article>
    </main>
  );
}

// Phase 4 of _plans/2026-06-17-engagement-polls.md. Resolves the
// post-vote follow-up: the closest-split published story in the same
// category, excluding the current one. Returns null when nothing
// qualifies — the widget hides the link gracefully. Best-effort: any
// failure logs and returns null so a busted rail query never crashes
// the reader page.
async function resolveFollowUp(
  currentStoryId: string,
  category: string | null,
): Promise<{ href: string; title: string } | null> {
  try {
    const rows = await topDivisive({
      category,
      excludeStoryId: currentStoryId,
      limit: 1,
    });
    const top = rows[0];
    if (!top || !top.slug || !top.title) return null;
    return { href: `/v/${top.slug}`, title: top.title };
  } catch (err) {
    console.warn("[v reader] follow-up resolve failed", {
      story_id: currentStoryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
