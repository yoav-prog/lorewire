# SEO PR 2: structured data + visible publish dates

Date: 2026-07-05
Branch: `seo/structured-data` off `seo/crawlability-and-metadata` (stacked on PR #223;
merge #223 first). Base main once #223 lands.
Trigger: second half of the verified external SEO/GEO audit. PR 1 fixed crawlability
and metadata; this PR makes the content machine-legible for rich results and AI
answer engines.

## Goals

Give search engines and AI crawlers structured facts to cite: video rich-result
eligibility for the shorts, FAQ rich results, brand identity (knowledge panel), and
E-E-A-T signals (visible publish date) on story pages.

## What ships

1. **VideoObject + Article JSON-LD on /v/ story pages** (`src/lib/story-jsonld.ts`,
   embedded in `v/[slug]/page.tsx`):
   - Article always: headline, description, image, datePublished/dateModified,
     publisher Organization, mainEntityOfPage (absolute canonical).
   - VideoObject only when `video_url` exists: name, description, thumbnailUrl,
     uploadDate (published_at), duration (ISO 8601 from the "M:SS" stories.duration
     via a tested converter), contentUrl, publisher.
   - Missing fields are DROPPED, not emitted as null — same `maybe()` policy as the
     existing article-seo.ts layer.
   - noindex stories get no JSON-LD (pointless to feed engines a page they must not index).
2. **Organization + WebSite JSON-LD sitewide** (`src/lib/site-jsonld.ts`, embedded in
   the root layout body): Organization from the existing admin settings
   (seo.organization_name / _logo_url / _same_as) + WebSite (siteName, url).
   No SearchAction: the site has no crawlable search results URL (search is a
   client-side tab), and lying about one is worse than omitting it.
3. **FAQPage JSON-LD on /faq**: the Q&A content becomes a single-source array
   (question + answer HTML with plain anchors); the page renders from it and the
   FAQPage schema is derived from it, so the visible copy and the schema can never
   drift. Google allows limited HTML (incl. links) in acceptedAnswer.text.
4. **Visible publish date on /v/ pages**: "Published July 3, 2026" line in the story
   header via `<time dateTime>`, following the inline toLocaleDateString("en-US")
   pattern ContributorCard already uses. Feeds E-E-A-T; matches datePublished in the
   JSON-LD so the visible page and the schema agree.

## Rejected alternatives

- QAPage schema on story pages (audit floated it): the poll is a vote, not a Q&A
  thread with a accepted answer; QAPage would misrepresent it. Article+VideoObject
  is honest.
- llms.txt: unconfirmed signal, zero-dependency to add later; kept out to keep this
  PR reviewable.
- Byline/author on story pages: no author data exists in the model; publisher
  Organization is what we can claim truthfully.

## Security

No new inputs. JSON-LD is serialized from our own DB fields with JSON.stringify
(script-tag injection guarded by escaping `<` in the serializer, same as the
existing article JSON-LD embed). FAQ answer HTML is a hardcoded constant in the
repo, not user data.

## Observability

`[story reader] render` log gains `has_jsonld` / video flags already present; the
FAQ and layout embeds are static. No new logging needed (server-rendered markup).

## Settings audit

Reuses the existing Organization settings in admin (Settings -> SEO). Nothing new
to expose: schema emission is not a user choice (it should always be on), and the
per-story noindex flag already suppresses it.

## Testing

- `story-jsonld.test.ts`: duration conversion ("0:50" -> PT50S, "2:14" -> PT2M14S,
  null/garbage -> undefined), VideoObject gated on video_url, field-drop policy,
  date passthrough, escaping of `<` in the serializer.
- `site-jsonld.test.ts`: Organization built from settings incl. sameAs list,
  WebSite present, empty-origin/empty-logo omission.
- FAQ: schema derives one Question per item, non-empty answers.
- Full vitest run green (except the 4 pre-existing main failures) + `next build` +
  emitted-HTML check of all three JSON-LD blocks.

## Deploy

Stacked PR: base is seo/crawlability-and-metadata until #223 merges, then retarget
to main. Same flow as every PR: preview build only, no manual promotion, merge to
main deploys. Rollback: revert the merge commit.
