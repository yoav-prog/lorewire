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
import {
  aspectDims,
  isVideoAspect,
  resolveAspect,
  type VideoAspect,
} from "@/lib/aspect";
import { PollWidget } from "@/components/PollWidget";
import {
  DEFAULT_PUBLIC_FLOOR,
  getAggregateByStoryId,
  getPollByStoryId,
  getVoteSideForCookie,
  toResultView,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";

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
  const ogImage = story.hero_image ?? seo.defaultOgImage ?? undefined;
  const videoUrl = story.video_url ?? undefined;
  const noindex = story.noindex === 1;
  const videoAspect = await resolveStoryAspect(story.video_config);
  const videoDims = aspectDims(videoAspect);

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
      images: ogImage ? [{ url: ogImage }] : undefined,
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
      card: seo.twitterCardType,
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
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
    ? toResultView(pollAggregate, DEFAULT_PUBLIC_FLOOR)
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
            storyId={story.id}
            question={poll.question}
            optionA={poll.option_a_text}
            optionB={poll.option_b_text}
            initialResult={pollResultView}
            initialVotedSide={initialVotedSide}
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
