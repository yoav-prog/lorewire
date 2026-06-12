// Sitewide SEO settings. Sets the defaults used by every public reader page
// when its own per-piece SEO fields are empty. Reads/writes via the existing
// settings_kv via saveSettingAction — every key here is namespaced under
// `seo.*`. Two follow-ups still parked:
//
//   1. Per-row no-index toggle on articles / stories (column add + reader
//      respect). See _plans/2026-06-12-seo-and-indexing.md.
//   2. LLM-driven auto-fill from kie.ai. Same plan.
//
// What's shipped here is the surface a robust site needs whether or not an
// AI writes the metadata: site identity, social-card defaults, Schema.org
// organization payload, and the two big-search-engine verification metas.

import { requireAdmin } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import SettingsShell from "@/app/admin/SettingsShell";
import {
  SettingChipGroup,
  SettingColor,
  SettingPresetText,
  SettingSlider,
} from "@/app/admin/(panel)/settings/_components/SettingControls";
import { SettingTextField } from "./_components/SettingTextField";
import type { ChipOption } from "@/components/ui";

type TwitterCardType = "summary_large_image" | "summary";

// Tiny visual previews of the two card layouts. "Large image" stacks a
// wide image rect over text rows; "small image" puts a square thumb
// next to a stack of text rows. Pure CSS — no real image fetched.
const TWITTER_CARD_OPTIONS: ChipOption<TwitterCardType>[] = [
  {
    id: "summary_large_image",
    label: "Large image",
    hint: "Summary card with large image (recommended)",
    preview: (
      <div className="flex w-12 flex-col gap-0.5 rounded border border-line bg-surface2 p-1">
        <div className="h-3 w-full rounded-sm bg-accent/30" />
        <div className="h-0.5 w-full rounded-full bg-muted/60" />
        <div className="h-0.5 w-2/3 rounded-full bg-muted/40" />
      </div>
    ),
  },
  {
    id: "summary",
    label: "Small image",
    hint: "Summary card with small image",
    preview: (
      <div className="flex w-12 gap-1 rounded border border-line bg-surface2 p-1">
        <div className="h-4 w-4 rounded-sm bg-accent/30" />
        <div className="flex flex-1 flex-col justify-center gap-0.5">
          <div className="h-0.5 w-full rounded-full bg-muted/60" />
          <div className="h-0.5 w-2/3 rounded-full bg-muted/40" />
        </div>
      </div>
    ),
  },
];

const TITLE_TEMPLATE_PRESETS = [
  { label: "Page · Site", value: "%s · LoreWire" },
  { label: "Page — Site", value: "%s — LoreWire" },
  { label: "Page | Site", value: "%s | LoreWire" },
  { label: "Just the page title", value: "%s" },
];

export default async function SeoPage() {
  await requireAdmin();

  const [
    siteName,
    siteUrl,
    titleTemplate,
    defaultMetaDescription,
    themeColor,
    defaultOgImage,
    twitterCardType,
    twitterHandle,
    orgName,
    orgLogoUrl,
    orgSameAs,
    googleVerification,
    bingVerification,
    sitemapDrafts,
    sitemapMaxAgeDays,
  ] = await Promise.all([
    getSetting("seo.site_name"),
    getSetting("seo.site_url"),
    getSetting("seo.title_template"),
    getSetting("seo.default_meta_description"),
    getSetting("seo.theme_color"),
    getSetting("seo.default_og_image"),
    getSetting("seo.twitter_card_type"),
    getSetting("seo.twitter_handle"),
    getSetting("seo.organization_name"),
    getSetting("seo.organization_logo_url"),
    getSetting("seo.organization_same_as"),
    getSetting("seo.google_verification"),
    getSetting("seo.bing_verification"),
    getSetting("seo.sitemap_include_drafts"),
    getSetting("seo.sitemap_max_age_days"),
  ]);

  console.info("[admin seo] render");

  return (
    <SettingsShell
      active="seo"
      title="SEO"
      description="Sitewide defaults used by every public page when its own meta fields are empty. Per-piece overrides land on the article or video editor."
    >
      <div className="space-y-8">
        <Section
          title="Site identity"
          description="Used in the title bar, the social card, and every Schema.org JSON-LD blob."
        >
          <SettingTextField
            settingKey="seo.site_name"
            label="Site name"
            hint="Brand name shown in title templates and Schema.org. Defaults to LoreWire if left empty."
            initial={siteName ?? ""}
            placeholder="LoreWire"
          />
          <SettingTextField
            settingKey="seo.site_url"
            label="Canonical site URL"
            hint="Origin used to build absolute URLs for OG tags, JSON-LD, and the sitemap. No trailing slash."
            initial={siteUrl ?? ""}
            placeholder="https://lorewire.com"
            inputType="url"
          />
          <SettingPresetText
            settingKey="seo.title_template"
            label="Page title template"
            hint="Used by every page that doesn't set its own meta title. %s is the page title placeholder."
            initial={titleTemplate ?? ""}
            presets={TITLE_TEMPLATE_PRESETS}
            placeholder="%s · LoreWire"
            rows={1}
          />
          <SettingTextField
            settingKey="seo.default_meta_description"
            label="Default meta description"
            hint="Fallback description for pages without their own. Keep under 160 characters for Google to render the whole thing."
            initial={defaultMetaDescription ?? ""}
            placeholder="Netflix for true internet stories. Watch the short, read the article."
          />
          <SettingColor
            settingKey="seo.theme_color"
            label="Theme color"
            hint="Color the browser uses for the address bar on mobile and PWA install chrome."
            initial={themeColor ?? ""}
            placeholder="#0A0A0C"
          />
        </Section>

        <Section
          title="Social cards"
          description="What Twitter, Facebook, LinkedIn, iMessage, and Slack show when someone shares a link."
        >
          <SettingTextField
            settingKey="seo.default_og_image"
            label="Default OG image"
            hint="Fallback image when a page doesn't set its own og_image. 1200×630 PNG or JPG works for every platform."
            initial={defaultOgImage ?? ""}
            placeholder="https://lorewire.com/og.png"
            inputType="url"
          />
          <SettingChipGroup<TwitterCardType>
            settingKey="seo.twitter_card_type"
            label="Twitter card type"
            hint="Large image cards drive more engagement; small summary is faster to load. Recommended: large image."
            initial={
              (twitterCardType as TwitterCardType) ?? "summary_large_image"
            }
            options={TWITTER_CARD_OPTIONS}
          />
          <SettingTextField
            settingKey="seo.twitter_handle"
            label="Twitter handle"
            hint="With the @, e.g. @LoreWire. Surfaces as the site attribution on the Twitter card."
            initial={twitterHandle ?? ""}
            placeholder="@LoreWire"
          />
        </Section>

        <Section
          title="Organization (Schema.org)"
          description="Identity payload Google uses for the knowledge panel and for tying authored pieces back to your brand."
        >
          <SettingTextField
            settingKey="seo.organization_name"
            label="Organization name"
            hint="Public-facing brand name. Often the same as site name; can differ for legal entities."
            initial={orgName ?? ""}
            placeholder="LoreWire Inc."
          />
          <SettingTextField
            settingKey="seo.organization_logo_url"
            label="Organization logo URL"
            hint="Square PNG with transparent background, ≥ 600×600. Used in JSON-LD and the Google rich result."
            initial={orgLogoUrl ?? ""}
            placeholder="https://lorewire.com/logo.png"
            inputType="url"
          />
          <SettingTextField
            settingKey="seo.organization_same_as"
            label="Same-as URLs"
            hint="Comma-separated social and authority profiles (Twitter, LinkedIn, Wikipedia, etc). Google uses these to verify the brand identity."
            initial={orgSameAs ?? ""}
            placeholder="https://twitter.com/LoreWire, https://www.linkedin.com/company/lorewire"
            multiline
          />
        </Section>

        <Section
          title="Search engine verification"
          description="Verification meta tags so Google Search Console and Bing Webmaster Tools accept the property."
        >
          <SettingTextField
            settingKey="seo.google_verification"
            label="Google site verification"
            hint="Just the content value (not the full <meta> tag). Get it from Search Console → Settings → Ownership verification → HTML tag."
            initial={googleVerification ?? ""}
            placeholder="aBcDeFgHiJkLmNoPqRsTuVwXyZ_1234567890_abcdefg"
          />
          <SettingTextField
            settingKey="seo.bing_verification"
            label="Bing site verification"
            hint="Same shape — just the content value from Bing Webmaster Tools."
            initial={bingVerification ?? ""}
            placeholder="ABCDEF1234567890ABCDEF1234567890"
          />
        </Section>

        <Section
          title="Sitemap"
          description="Controls what /sitemap.xml exposes to crawlers."
        >
          <SitemapToggleHint sitemapDrafts={sitemapDrafts ?? ""} />
          <SettingSlider
            settingKey="seo.sitemap_max_age_days"
            label="Maximum age in sitemap"
            hint="Pieces older than this drop off the sitemap. Set to 0 to keep everything forever. Older content can hurt crawl budget on a small site."
            initial={sitemapMaxAgeDays ?? "0"}
            min={0}
            max={3650}
            step={1}
            unit=" days"
            tickValue={0}
          />
        </Section>
      </div>
    </SettingsShell>
  );
}

function SitemapToggleHint({ sitemapDrafts }: { sitemapDrafts: string }) {
  const isOn = !["", "0", "false", "off", "no"].includes(sitemapDrafts.trim().toLowerCase());
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-[13px] font-semibold text-ink">
        Include drafts in sitemap
      </div>
      <p className="mt-1 text-[12px] text-muted">
        Drafts are <strong className="text-ink">{isOn ? "included" : "excluded"}</strong> by default. Toggling this requires editing the public sitemap route — surfaced here so the policy is one place. Open issue if you need it as a live toggle.
      </p>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-[13px] text-muted">{description}</p>
        )}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
