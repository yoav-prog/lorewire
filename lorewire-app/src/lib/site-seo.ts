// Sitewide SEO settings, resolved with safe fallbacks.
//
// The /admin/seo page persists each value to `settings_kv` under
// `seo.<key>`; this helper reads them all in one round-trip and returns a
// fully-typed object so callers (the article reader, the root layout, the
// list pages) never deal with nulls or empty strings.
//
// The defaults here are the same values that used to be hardcoded in
// `app/layout.tsx` and the article reader's generateMetadata. Persisting
// them in settings_kv is the migration target — the defaults stay as the
// floor so a fresh install still ships with sensible chrome before the
// admin touches anything.

import "server-only";
import { getSettingsByPrefix } from "@/lib/repo";

export interface SiteSeoSettings {
  siteName: string;
  siteUrl: string;
  titleTemplate: string;
  defaultMetaDescription: string;
  themeColor: string;
  defaultOgImage: string;
  twitterCardType: "summary_large_image" | "summary";
  twitterHandle: string;
  organizationName: string;
  organizationLogoUrl: string;
  organizationSameAs: string[];
  googleVerification: string;
  bingVerification: string;
  sitemapMaxAgeDays: number;
}

const DEFAULTS: SiteSeoSettings = {
  siteName: "LoreWire",
  // siteUrl falls back to the NEXT_PUBLIC_SITE_ORIGIN env var at usage
  // sites where the origin actually matters (canonical/OG). Empty string
  // here keeps the type clean.
  siteUrl: "",
  titleTemplate: "%s · LoreWire",
  defaultMetaDescription:
    "Every internet story ends with your verdict. Watch a 60-second short, decide who's right, see what the crowd said.",
  themeColor: "#0A0A0C",
  defaultOgImage: "",
  twitterCardType: "summary_large_image",
  twitterHandle: "",
  organizationName: "LoreWire",
  organizationLogoUrl: "",
  organizationSameAs: [],
  googleVerification: "",
  bingVerification: "",
  sitemapMaxAgeDays: 0,
};

function parseTwitterCard(
  raw: string | undefined,
): SiteSeoSettings["twitterCardType"] {
  return raw === "summary" ? "summary" : "summary_large_image";
}

function parseSameAs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getSiteSeo(): Promise<SiteSeoSettings> {
  const map = await getSettingsByPrefix("seo.");
  // strip the "seo." prefix once so callers can read by short key
  const v: Record<string, string> = {};
  for (const [k, val] of Object.entries(map)) v[k.slice(4)] = val;

  return {
    siteName: v.site_name || DEFAULTS.siteName,
    siteUrl: v.site_url || DEFAULTS.siteUrl,
    titleTemplate: v.title_template || DEFAULTS.titleTemplate,
    defaultMetaDescription:
      v.default_meta_description || DEFAULTS.defaultMetaDescription,
    themeColor: v.theme_color || DEFAULTS.themeColor,
    defaultOgImage: v.default_og_image || DEFAULTS.defaultOgImage,
    twitterCardType: parseTwitterCard(v.twitter_card_type),
    twitterHandle: v.twitter_handle || DEFAULTS.twitterHandle,
    organizationName: v.organization_name || DEFAULTS.organizationName,
    organizationLogoUrl:
      v.organization_logo_url || DEFAULTS.organizationLogoUrl,
    organizationSameAs: parseSameAs(v.organization_same_as),
    googleVerification: v.google_verification || DEFAULTS.googleVerification,
    bingVerification: v.bing_verification || DEFAULTS.bingVerification,
    sitemapMaxAgeDays: parseNonNegInt(
      v.sitemap_max_age_days,
      DEFAULTS.sitemapMaxAgeDays,
    ),
  };
}

// Compose a page title using the configured template. The template should
// contain `%s` where the per-page title goes. If the template lacks the
// token (admin typed something weird), append a separator + brand.
export function buildPageTitle(
  pageTitle: string,
  template: string,
  siteName: string,
): string {
  if (!pageTitle) return siteName;
  if (template.includes("%s")) return template.replace("%s", pageTitle);
  // Defensive fallback so a malformed template still produces a sensible
  // title — never an empty string.
  return `${pageTitle} · ${siteName}`;
}
