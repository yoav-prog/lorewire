// /articles/[locale]/rss.xml
//
// Per-language RSS 2.0 feed of the 30 most recent published articles. The
// body content uses the same server-side renderer as the reader page, so
// subscribed feed readers see the article exactly as it appears on the
// site. We deliberately keep this to RSS 2.0 (not Atom) because RSS reader
// support remains broader and the marginal feature gains from Atom don't
// matter for editorial copy.
//
// Cache. The Cache-Control header keeps feeds fresh within an hour;
// subscribed clients typically poll less often than that anyway, and a
// flexible window means a brand new publish is visible quickly without
// hammering the DB on every poll.

import { NextResponse } from "next/server";
import { listPublishedArticles } from "@/lib/articles-public";
import { renderArticleHtml } from "@/lib/article-html";
import type { ArticleLanguage } from "@/lib/repo";

function isLanguage(v: string): v is ArticleLanguage {
  return v === "he" || v === "en";
}

function siteOrigin(): string {
  return process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "";
}

// XML escape on the host side because every dynamic text we emit lands
// inside a tag's text content. We don't entity-encode the renderer's HTML
// because it's already escaped inside a CDATA section.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// CDATA needs the same `]]>` escape; we replace with a split + reassemble.
function cdataSafe(s: string): string {
  return s.replace(/]]>/g, "]]]]><![CDATA[>");
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await ctx.params;
  if (!isLanguage(locale)) {
    return NextResponse.json({ error: "bad-locale" }, { status: 404 });
  }
  const origin = siteOrigin();
  const items = await listPublishedArticles({ language: locale, limit: 30 });

  // Channel-level fields. The atom:link self-pointer is required for
  // validators to confirm the feed's canonical URL.
  const channelTitle =
    locale === "he" ? "LoreWire — מאמרים" : "LoreWire — Articles";
  const channelDescription =
    locale === "he"
      ? "מאמרים, פיצ׳רים, חדשות, ביקורות וליסטיקלס מ-LoreWire"
      : "Features, news, listicles, and reviews from LoreWire";
  const selfHref = `${origin}/articles/${locale}/rss.xml`;
  const lastBuild =
    items[0]?.published_at ?? items[0]?.updated_at ?? new Date().toISOString();

  // Full-content per item: title, link, guid (the canonical URL), pubDate,
  // and the rendered HTML inside content:encoded. Summary lives in
  // <description>; if the article has no summary we leave it empty rather
  // than duplicate the title.
  const itemBlocks: string[] = [];
  for (const row of items) {
    const link = `${origin}/articles/${locale}/${row.slug ?? row.id}`;
    const title = xmlEscape(row.title ?? "Untitled");
    const description = xmlEscape(row.summary ?? "");
    const pubDate = row.published_at
      ? new Date(row.published_at).toUTCString()
      : new Date().toUTCString();

    // We need the full row's document; the slim list projection drops it.
    // One small extra read per item; with the 30-row cap the total is
    // bounded. If this becomes a hot path we can switch to a single SELECT
    // returning the full rows.
    const html = renderArticleHtml(await fetchDocumentFor(row.id));
    itemBlocks.push(
      `    <item>
      <title>${title}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
      <content:encoded><![CDATA[${cdataSafe(html)}]]></content:encoded>
    </item>`,
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xmlEscape(channelTitle)}</title>
    <link>${xmlEscape(origin + "/articles?language=" + locale)}</link>
    <description>${xmlEscape(channelDescription)}</description>
    <language>${locale}</language>
    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>
    <atom:link href="${xmlEscape(selfHref)}" rel="self" type="application/rss+xml" />
${itemBlocks.join("\n")}
  </channel>
</rss>
`;

  console.info("[articles reader] rss", {
    locale,
    itemCount: items.length,
  });

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

// Small helper so the loop above stays readable. We could pull this into
// articles-public.ts but it would be the only caller — colocating keeps
// the seam clean.
import { one } from "@/lib/db";

async function fetchDocumentFor(id: string): Promise<string | null> {
  const r = await one<{ document: string | null }>(
    "SELECT document FROM articles WHERE id = ?",
    [id],
  );
  return r?.document ?? null;
}
