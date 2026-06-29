// Phase 5 of _plans/2026-06-17-engagement-polls.md. Per-platform
// caption suffix that hooks the social-platform viewer back to
// lorewire.com when the short's story has an enabled poll. The
// burnt-in card (Phase 3) is the muted-scroll path; this caption
// hook is the caption-reader path. Both routes lead to the same
// /v/<slug> reader where the on-site PollWidget pays off the
// question.
//
// This module is INTENTIONALLY pure — no DB, no settings load, no
// server-only mark. The caller (the future
// mapShortToPlatformPayload in app/api/social/...) is responsible
// for resolving the poll + the admin's per-platform template
// override and passing them in. Keeping it pure lets every test
// run on plain inputs and makes the same function callable from
// any TS surface (server action, route handler, scheduled job).
//
// The publisher's per-platform caption transformer is still being
// built (the publisher plan's Phase 0 is in flight — review-
// application work). When it lands, the integration is one line:
//
//     const hook = buildPollHook({ question, slug, platform, templateOverride });
//     return baseCaption + hook;  // length-capped by the caller
//
// Cross-plan reference: see _plans/2026-06-16-multi-platform-shorts-publisher.md
// §3.F2 + §12 for the surrounding caption-template architecture.

/** The four publisher platforms from the multi-platform-shorts-publisher
 *  plan (§7). Order is stable: future per-platform iteration uses this
 *  array so adding/removing a platform is a one-line change.
 *
 *  Living here (not in polls-shared) because no client component
 *  reads it today — the publisher is entirely server-side. If a
 *  client surface ever needs the enum (e.g. a settings UI checkbox
 *  per platform), split this into a -shared module like the polls
 *  pattern. */
export const PUBLISHER_PLATFORMS = [
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
] as const;
export type PublisherPlatform = (typeof PUBLISHER_PLATFORMS)[number];

/** Per-platform default templates. Mirror the plan §F4 exactly so
 *  reviewers reading the plan find the same strings in code.
 *  Substitution tokens: `{question}` and `{slug}`. The leading
 *  `\n\n` is intentional — the hook is meant to be APPENDED to a
 *  caption, and the double newline visually separates it from the
 *  preceding text. Callers that want the hook elsewhere in the
 *  caption (between description and hashtags, etc.) can override
 *  the template per platform via the settings key returned by
 *  pollHookSettingKey(). */
export const DEFAULT_POLL_HOOK_TEMPLATES: Record<
  PublisherPlatform,
  string
> = {
  youtube: "\n\n👉 {question} Vote at lorewire.com/v/{slug}",
  tiktok: "\n\n{question} 👉 lorewire.com/v/{slug}",
  instagram: "\n\n{question} 👉 lorewire.com/v/{slug}",
  facebook: "\n\n{question} 👉 lorewire.com/v/{slug}",
};

/** Settings key per platform for the admin's template override.
 *  Reading null / empty string from settings → use the platform
 *  default. Stays consistent with the polls.rail.*_enabled naming
 *  pattern from Phase 4.5. */
export function pollHookSettingKey(platform: PublisherPlatform): string {
  return `publisher.caption.${platform}.poll_hook_template`;
}

export interface BuildPollHookArgs {
  /** Poll question (typically polls.question after Phase 1's validation
   *  trim). Empty string → returns an empty hook (caller should also
   *  skip when no live poll exists, but this guards the edge). */
  question: string;
  /** Story slug used in the URL fragment. When the story has no slug
   *  the caller falls back to the story id (mirrors the burnt-in
   *  card's slug-or-id rule in pipeline/shorts_render.py). */
  slug: string;
  /** Which platform's template to use. */
  platform: PublisherPlatform;
  /** Optional admin-supplied template override (resolved from
   *  pollHookSettingKey()). Falsy values fall back to the platform
   *  default — empty string and null both count as "no override." */
  templateOverride?: string | null;
}

/** Returns the caption suffix to append for this platform, or an
 *  empty string when the question is empty / whitespace-only. The
 *  result is NOT length-capped — the caller is responsible for
 *  fitting the combined caption under each platform's limit
 *  (YouTube ≤ 5000, TikTok ≤ 2200, IG ≤ 2200, FB ≤ 63206 per the
 *  publisher plan §3.F2).
 *
 *  Substitution rules:
 *    - `{question}` and `{slug}` are replaced verbatim. Both are
 *      pre-trimmed so a trailing space the admin saved doesn't
 *      slip into the caption.
 *    - All other `{...}` tokens stay literal. The template might
 *      come from a future template-substitution layer in the
 *      publisher that handles more tokens; we don't pre-mangle
 *      them here.
 *    - Slug is NOT URL-encoded. Slugs are already kebab-case at the
 *      DB level (see lib/articles slugify + the stories slug
 *      contract), so they're safe in a URL path segment. If a
 *      legacy slug somehow carries a space it'll surface as a
 *      double-space in the caption — visible but not broken.
 */
export function buildPollHook(args: BuildPollHookArgs): string {
  const question = args.question.trim();
  const slug = args.slug.trim();
  if (!question || !slug) return "";
  const template =
    args.templateOverride && args.templateOverride.trim().length > 0
      ? args.templateOverride
      : DEFAULT_POLL_HOOK_TEMPLATES[args.platform];
  // Replace globally so a template like "{question} ... {question}"
  // works as expected. We don't expect that shape but the cost of
  // supporting it is zero.
  return template.replaceAll("{question}", question).replaceAll("{slug}", slug);
}
