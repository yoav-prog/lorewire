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
              width: 1080,
              height: 1920,
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

  console.info("[story reader] render", {
    id: story.id,
    slug: story.slug,
    has_video: Boolean(story.video_url),
    has_audio: Boolean(story.audio_url),
    bodyLen: story.body?.length ?? 0,
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
              style={{ aspectRatio: "9 / 16" }}
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
