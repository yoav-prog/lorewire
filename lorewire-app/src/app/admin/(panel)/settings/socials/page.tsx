import { requireCapability } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import SettingsShell from "@/app/admin/SettingsShell";
import {
  SettingChipGroup,
  SettingText,
  SettingToggle,
} from "../_components/SettingControls";
import { type ChipOption } from "@/components/ui";
import {
  DEFAULT_POLL_HOOK_TEMPLATES,
  pollHookSettingKey,
  PUBLISHER_PLATFORMS,
} from "@/lib/publisher-poll-hook";
import {
  DEFAULT_CAPTION_TEMPLATE as FB_DEFAULT_CAPTION_TEMPLATE,
  SETTING_AUTO_PUBLISH as FB_SETTING_AUTO_PUBLISH,
  SETTING_CAPTION_TEMPLATE as FB_SETTING_CAPTION_TEMPLATE,
} from "@/lib/publish-to-facebook";
import {
  DEFAULT_CAPTION_TEMPLATE as IG_DEFAULT_CAPTION_TEMPLATE,
  SETTING_AUTO_PUBLISH as IG_SETTING_AUTO_PUBLISH,
  SETTING_CAPTION_TEMPLATE as IG_SETTING_CAPTION_TEMPLATE,
} from "@/lib/publish-to-instagram";
import {
  DEFAULT_CATEGORY_ID as YT_DEFAULT_CATEGORY_ID,
  DEFAULT_DESCRIPTION_TEMPLATE as YT_DEFAULT_DESCRIPTION_TEMPLATE,
  DEFAULT_PRIVACY as YT_DEFAULT_PRIVACY,
  DEFAULT_TAGS_BASE as YT_DEFAULT_TAGS_BASE,
  DEFAULT_TAGS_BY_CATEGORY as YT_DEFAULT_TAGS_BY_CATEGORY,
  DEFAULT_TITLE_TEMPLATE as YT_DEFAULT_TITLE_TEMPLATE,
  SETTING_AUTO_PUBLISH as YT_SETTING_AUTO_PUBLISH,
  SETTING_CATEGORY_ID as YT_SETTING_CATEGORY_ID,
  SETTING_DESCRIPTION_TEMPLATE as YT_SETTING_DESCRIPTION_TEMPLATE,
  SETTING_MADE_FOR_KIDS as YT_SETTING_MADE_FOR_KIDS,
  SETTING_PRIVACY_DEFAULT as YT_SETTING_PRIVACY_DEFAULT,
  SETTING_SYNTHETIC_MEDIA as YT_SETTING_SYNTHETIC_MEDIA,
  SETTING_TAGS_BASE as YT_SETTING_TAGS_BASE,
  SETTING_TITLE_TEMPLATE as YT_SETTING_TITLE_TEMPLATE,
  SETTING_UPLOAD_CAPTIONS as YT_SETTING_UPLOAD_CAPTIONS,
  settingTagsCategoryKey as ytTagsCategoryKey,
} from "@/lib/publish-to-youtube";
import {
  DEFAULT_CAPTION_TEMPLATE as TT_DEFAULT_CAPTION_TEMPLATE,
  DEFAULT_HASHTAGS_BASE as TT_DEFAULT_HASHTAGS_BASE,
  DEFAULT_HASHTAGS_BY_CATEGORY as TT_DEFAULT_HASHTAGS_BY_CATEGORY,
  DEFAULT_PRIVACY_LEVEL as TT_DEFAULT_PRIVACY_LEVEL,
  SETTING_AUTO_PUBLISH as TT_SETTING_AUTO_PUBLISH,
  SETTING_CAPTION_TEMPLATE as TT_SETTING_CAPTION_TEMPLATE,
  SETTING_DISABLE_COMMENT as TT_SETTING_DISABLE_COMMENT,
  SETTING_DISABLE_DUET as TT_SETTING_DISABLE_DUET,
  SETTING_DISABLE_STITCH as TT_SETTING_DISABLE_STITCH,
  SETTING_HASHTAGS_BASE as TT_SETTING_HASHTAGS_BASE,
  SETTING_IS_AIGC as TT_SETTING_IS_AIGC,
  SETTING_POST_MODE as TT_SETTING_POST_MODE,
  SETTING_PRIVACY_DEFAULT as TT_SETTING_PRIVACY_DEFAULT,
  settingHashtagsCategoryKey as ttHashtagsCategoryKey,
} from "@/lib/publish-to-tiktok";

// Settings / Socials. One shell per platform: Facebook, Instagram,
// YouTube, TikTok, plus a cross-platform "caption hooks" section that
// covers the poll-hook suffix appended when a short with an enabled
// poll is published.
//
// Per-platform credentials (FB_PAGE_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID,
// YOUTUBE_REFRESH_TOKEN, TIKTOK_REFRESH_TOKEN, etc.) intentionally do
// NOT live here — they're server env vars, never in the DB (rule 13).
// The page reads each platform's env-presence flag and surfaces it as
// a status line so admin can see at a glance whether publishing will
// fire on the next render or skip.
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.

const SHORT_CATEGORIES = [
  "Dating",
  "Drama",
  "Entitled",
  "Humor",
  "Roommate",
  "Wholesome",
] as const;

const YT_PRIVACY_OPTIONS: ChipOption<string>[] = [
  {
    id: "public",
    label: "Public",
    hint: "Visible to everyone, indexed by search.",
  },
  {
    id: "unlisted",
    label: "Unlisted",
    hint: "Anyone with the link can view; not surfaced in search or the channel page.",
  },
  {
    id: "private",
    label: "Private",
    hint: "Only the channel owner can view. Useful for staging.",
  },
];

const TT_POST_MODE_OPTIONS: ChipOption<string>[] = [
  {
    id: "inbox",
    label: "Drafts (inbox)",
    hint: "Lands in the TikTok app inbox; you publish from the app. Works without app audit.",
  },
  {
    id: "direct",
    label: "Direct (live)",
    hint: "Posts live immediately. Requires TikTok app audit approval.",
  },
];

const TT_PRIVACY_OPTIONS: ChipOption<string>[] = [
  {
    id: "PUBLIC_TO_EVERYONE",
    label: "Public",
    hint: "Visible on the public For You feed.",
  },
  {
    id: "MUTUAL_FOLLOW_FRIENDS",
    label: "Friends",
    hint: "Mutual follows only.",
  },
  {
    id: "FOLLOWER_OF_CREATOR",
    label: "Followers",
    hint: "Followers only.",
  },
  {
    id: "SELF_ONLY",
    label: "Self only",
    hint: "Visible to nobody but the account owner — staging mode.",
  },
];

// Helper: a setting stored as "1"/"0"/"true"/"false"/"" is considered
// ON unless it's explicitly OFF. Matches the existing pipeline-side
// convention.
function readToggle(raw: string | null, defaultOn = false): boolean {
  if (raw === null || raw === "") return defaultOn;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export default async function SocialsSettingsPage() {
  await requireCapability("settings.manage");

  // Facebook block.
  const [fbAutoPublishRaw, fbCaptionTemplateRaw] = await Promise.all([
    getSetting(FB_SETTING_AUTO_PUBLISH),
    getSetting(FB_SETTING_CAPTION_TEMPLATE),
  ]);
  const fbPageIdDisplay = process.env.FB_PAGE_ID ?? "";
  const fbTokenConfigured = Boolean(process.env.FB_PAGE_ACCESS_TOKEN);

  // Instagram block.
  const [igAutoPublishRaw, igCaptionTemplateRaw] = await Promise.all([
    getSetting(IG_SETTING_AUTO_PUBLISH),
    getSetting(IG_SETTING_CAPTION_TEMPLATE),
  ]);
  const igAccountIdDisplay = process.env.IG_BUSINESS_ACCOUNT_ID ?? "";
  const igTokenConfigured = fbTokenConfigured;

  // YouTube block.
  const [
    ytAutoPublishRaw,
    ytTitleTemplate,
    ytDescriptionTemplate,
    ytTagsBase,
    ytCategoryId,
    ytPrivacy,
    ytMadeForKidsRaw,
    ytSyntheticRaw,
    ytUploadCaptionsRaw,
  ] = await Promise.all([
    getSetting(YT_SETTING_AUTO_PUBLISH),
    getSetting(YT_SETTING_TITLE_TEMPLATE),
    getSetting(YT_SETTING_DESCRIPTION_TEMPLATE),
    getSetting(YT_SETTING_TAGS_BASE),
    getSetting(YT_SETTING_CATEGORY_ID),
    getSetting(YT_SETTING_PRIVACY_DEFAULT),
    getSetting(YT_SETTING_MADE_FOR_KIDS),
    getSetting(YT_SETTING_SYNTHETIC_MEDIA),
    getSetting(YT_SETTING_UPLOAD_CAPTIONS),
  ]);
  const ytChannelIdDisplay = process.env.YOUTUBE_CHANNEL_ID ?? "";
  const ytTokenConfigured = Boolean(process.env.YOUTUBE_REFRESH_TOKEN);
  const ytTagsByCat: Record<string, string> = {};
  await Promise.all(
    SHORT_CATEGORIES.map(async (c) => {
      ytTagsByCat[c] = (await getSetting(ytTagsCategoryKey(c))) ?? "";
    }),
  );

  // TikTok block.
  const [
    ttAutoPublishRaw,
    ttPostModeRaw,
    ttCaptionTemplate,
    ttHashtagsBase,
    ttPrivacy,
    ttIsAigcRaw,
    ttDisableDuetRaw,
    ttDisableStitchRaw,
    ttDisableCommentRaw,
  ] = await Promise.all([
    getSetting(TT_SETTING_AUTO_PUBLISH),
    getSetting(TT_SETTING_POST_MODE),
    getSetting(TT_SETTING_CAPTION_TEMPLATE),
    getSetting(TT_SETTING_HASHTAGS_BASE),
    getSetting(TT_SETTING_PRIVACY_DEFAULT),
    getSetting(TT_SETTING_IS_AIGC),
    getSetting(TT_SETTING_DISABLE_DUET),
    getSetting(TT_SETTING_DISABLE_STITCH),
    getSetting(TT_SETTING_DISABLE_COMMENT),
  ]);
  const ttOpenIdDisplay = process.env.TIKTOK_OPEN_ID ?? "";
  const ttTokenConfigured = Boolean(process.env.TIKTOK_REFRESH_TOKEN);
  const ttHashtagsByCat: Record<string, string> = {};
  await Promise.all(
    SHORT_CATEGORIES.map(async (c) => {
      ttHashtagsByCat[c] = (await getSetting(ttHashtagsCategoryKey(c))) ?? "";
    }),
  );

  // Cross-platform poll-hook suffixes.
  const pollHookOverrides: Record<
    (typeof PUBLISHER_PLATFORMS)[number],
    string
  > = {
    youtube: (await getSetting(pollHookSettingKey("youtube"))) ?? "",
    tiktok: (await getSetting(pollHookSettingKey("tiktok"))) ?? "",
    instagram: (await getSetting(pollHookSettingKey("instagram"))) ?? "",
    facebook: (await getSetting(pollHookSettingKey("facebook"))) ?? "",
  };

  return (
    <SettingsShell
      active="socials"
      title="Socials"
      description="Per-platform auto-publish defaults. Each platform has its own toggle, caption / title template, and per-category overrides. Credentials live in server env vars, never in the database."
    >
      <div className="space-y-8">
        {/* ── Facebook ──────────────────────────────────────────────── */}
        <Section
          title="Facebook"
          description="Auto-publish every freshly rendered short to the LoreWire Facebook Page. Plan: _plans/2026-06-23-facebook-auto-publish.md."
        >
          <StatusLine
            label="Target page"
            value={fbPageIdDisplay || "(FB_PAGE_ID env var not set)"}
            credentialLabel="Page Access Token"
            credentialOk={fbTokenConfigured}
            credentialMissingHint="FB_PAGE_ACCESS_TOKEN not set — publishing will skip until it lands in Vercel env vars"
          />
          <SettingToggle
            settingKey={FB_SETTING_AUTO_PUBLISH}
            label="Auto-publish on render"
            hint="When on, every short that finishes rendering is posted to the LoreWire Facebook Page. Story-level dedup prevents re-renders from creating duplicate posts. Manual publish from the short editor bypasses this toggle."
            initialOn={readToggle(fbAutoPublishRaw, false)}
          />
          <SettingText
            settingKey={FB_SETTING_CAPTION_TEMPLATE}
            label="Caption template"
            hint={`Tokens: {{hook}}, {{title}}, {{article_url}}. Empty falls back to the default: ${FB_DEFAULT_CAPTION_TEMPLATE.replace(/\n/g, "\\n")}`}
            initial={fbCaptionTemplateRaw ?? ""}
            placeholder="Leave empty to use the default template"
          />
        </Section>

        {/* ── Instagram ─────────────────────────────────────────────── */}
        <Section
          title="Instagram"
          description="Auto-publish every freshly rendered short to the LoreWire Instagram account as a Reel. Reuses the Facebook Page Access Token (IG is linked to the Page). Plan: _plans/2026-06-24-instagram-auto-publish.md."
        >
          <StatusLine
            label="Target IG account"
            value={
              igAccountIdDisplay || "(IG_BUSINESS_ACCOUNT_ID env var not set)"
            }
            credentialLabel="Page Access Token (shared with Facebook)"
            credentialOk={igTokenConfigured}
            credentialMissingHint="FB_PAGE_ACCESS_TOKEN not set — publishing will skip until it lands in Vercel env vars"
          />
          <SettingToggle
            settingKey={IG_SETTING_AUTO_PUBLISH}
            label="Auto-publish on render"
            hint="When on, every short that finishes rendering is posted as a Reel to the LoreWire Instagram account. Independent from the Facebook toggle — you can have one on and the other off. Story-level dedup prevents re-renders from creating duplicate Reels. Manual publish from the short editor bypasses this toggle."
            initialOn={readToggle(igAutoPublishRaw, false)}
          />
          <SettingText
            settingKey={IG_SETTING_CAPTION_TEMPLATE}
            label="Caption template (Instagram-specific)"
            hint={`Tokens: {{hook}}, {{title}}, {{article_url}}. Empty falls back to the default: ${IG_DEFAULT_CAPTION_TEMPLATE.replace(/\n/g, "\\n")}. Instagram caps captions at 2200 characters — anything longer gets truncated with an ellipsis automatically.`}
            initial={igCaptionTemplateRaw ?? ""}
            placeholder="Leave empty to use the default template"
          />
        </Section>

        {/* ── YouTube ───────────────────────────────────────────────── */}
        <Section
          title="YouTube"
          description="Auto-publish every freshly rendered short to the LoreWire YouTube channel (@LoreWireHQ). Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md."
        >
          <StatusLine
            label="Target channel"
            value={
              ytChannelIdDisplay || "(YOUTUBE_CHANNEL_ID env var not set)"
            }
            credentialLabel="OAuth refresh token"
            credentialOk={ytTokenConfigured}
            credentialMissingHint="YOUTUBE_REFRESH_TOKEN not set — publishing will skip until it lands in Vercel env vars. Run scripts/get-youtube-refresh-token.ts once locally to mint one."
          />
          <SettingToggle
            settingKey={YT_SETTING_AUTO_PUBLISH}
            label="Auto-publish on render"
            hint="When on, every short that finishes rendering is uploaded to YouTube with the title / description / tags rendered from the templates below. Story-level dedup prevents re-renders from creating duplicates. Manual publish from the short editor bypasses this toggle."
            initialOn={readToggle(ytAutoPublishRaw, false)}
          />
          <SettingText
            settingKey={YT_SETTING_TITLE_TEMPLATE}
            label="Title template"
            hint={`Tokens: {{hook}}, {{title}}, {{category}}, {{article_url}}. Empty falls back to ${YT_DEFAULT_TITLE_TEMPLATE}. Trimmed to 100 chars with an ellipsis if longer.`}
            initial={ytTitleTemplate ?? ""}
            placeholder={YT_DEFAULT_TITLE_TEMPLATE}
          />
          <SettingText
            settingKey={YT_SETTING_DESCRIPTION_TEMPLATE}
            label="Description template"
            hint={`Tokens: {{hook}}, {{title}}, {{category}}, {{article_url}}. Empty falls back to the default. Hashtags inline. Trimmed to 5000 chars.`}
            initial={ytDescriptionTemplate ?? ""}
            placeholder={YT_DEFAULT_DESCRIPTION_TEMPLATE}
          />
          <SettingText
            settingKey={YT_SETTING_TAGS_BASE}
            label="Tags — base set (every short)"
            hint={`Comma-separated. The tags here are merged with the per-category tags below; dupes are dropped (case-insensitive); the merged list is capped at 8 tags and 500 chars total per YouTube's limits. Empty falls back to: ${YT_DEFAULT_TAGS_BASE}`}
            initial={ytTagsBase ?? ""}
            placeholder={YT_DEFAULT_TAGS_BASE}
          />
          {SHORT_CATEGORIES.map((c) => (
            <SettingText
              key={c}
              settingKey={ytTagsCategoryKey(c)}
              label={`Tags — ${c}`}
              hint={`Comma-separated. Appended to the base set on shorts in this category. Empty falls back to: ${YT_DEFAULT_TAGS_BY_CATEGORY[c] ?? "(none)"}`}
              initial={ytTagsByCat[c] ?? ""}
              placeholder={YT_DEFAULT_TAGS_BY_CATEGORY[c] ?? ""}
            />
          ))}
          <SettingChipGroup<string>
            settingKey={YT_SETTING_PRIVACY_DEFAULT}
            label="Privacy default"
            hint="Applied to every auto-published short. Set to Unlisted while smoke-testing in production, then flip to Public."
            initial={ytPrivacy ?? YT_DEFAULT_PRIVACY}
            options={YT_PRIVACY_OPTIONS}
          />
          <SettingText
            settingKey={YT_SETTING_CATEGORY_ID}
            label="YouTube category id"
            hint="The numeric YouTube category id. 24 = Entertainment (LoreWire default). 22 = People & Blogs. 25 = News & Politics (don't use — it flags Reddit-source content as commentary)."
            initial={ytCategoryId ?? YT_DEFAULT_CATEGORY_ID}
            placeholder={YT_DEFAULT_CATEGORY_ID}
          />
          <SettingToggle
            settingKey={YT_SETTING_MADE_FOR_KIDS}
            label="Self-declare as made for kids"
            hint="Maps to YouTube's COPPA gate. Off (default) is the right answer for LoreWire — our content is not directed at children under 13."
            initialOn={readToggle(ytMadeForKidsRaw, false)}
          />
          <SettingToggle
            settingKey={YT_SETTING_SYNTHETIC_MEDIA}
            label="Self-declare as altered / synthetic media"
            hint="Maps to status.containsSyntheticMedia in the YouTube API — the 'AI-generated or altered content' gate. On (default) is the truthful answer for LoreWire shorts."
            initialOn={readToggle(ytSyntheticRaw, true)}
          />
          <SettingToggle
            settingKey={YT_SETTING_UPLOAD_CAPTIONS}
            label="Upload SRT captions alongside the video"
            hint="When on, the rendered SRT is attached via captions.insert after the video upload succeeds. Best-effort: a captions failure won't roll back the video upload. Uploaded captions outrank auto-generated for indexing."
            initialOn={readToggle(ytUploadCaptionsRaw, true)}
          />
        </Section>

        {/* ── TikTok ───────────────────────────────────────────────── */}
        <Section
          title="TikTok"
          description="Auto-publish every freshly rendered short to the LoreWire TikTok account. Until TikTok approves our Content Posting API audit, the post lands as a draft in the LoreWire TikTok app's Inbox — flip Post mode to Direct after audit clears."
        >
          <StatusLine
            label="Target open_id"
            value={ttOpenIdDisplay || "(TIKTOK_OPEN_ID env var not set)"}
            credentialLabel="OAuth refresh token"
            credentialOk={ttTokenConfigured}
            credentialMissingHint="TIKTOK_REFRESH_TOKEN not set — publishing will skip until it lands in Vercel env vars. Run scripts/get-tiktok-refresh-token.ts once locally to mint one."
          />
          <SettingToggle
            settingKey={TT_SETTING_AUTO_PUBLISH}
            label="Auto-publish on render"
            hint="When on, every short that finishes rendering is posted to TikTok. Story-level dedup prevents re-renders from creating duplicates. Manual publish from the short editor bypasses this toggle."
            initialOn={readToggle(ttAutoPublishRaw, false)}
          />
          <SettingChipGroup<string>
            settingKey={TT_SETTING_POST_MODE}
            label="Post mode"
            hint="Drafts goes to the TikTok app Inbox; you publish from the app. Direct posts live immediately and requires the TikTok app audit to have cleared the video.publish scope."
            initial={ttPostModeRaw === "direct" ? "direct" : "inbox"}
            options={TT_POST_MODE_OPTIONS}
          />
          <SettingText
            settingKey={TT_SETTING_CAPTION_TEMPLATE}
            label="Caption template"
            hint={`Tokens: {{hook}}, {{title}}, {{category}}, {{article_url}}. Hashtags inline (TikTok has no separate hashtags field). Empty falls back to the default: ${TT_DEFAULT_CAPTION_TEMPLATE.replace(/\n/g, "\\n")}. Trimmed to 2200 chars.`}
            initial={ttCaptionTemplate ?? ""}
            placeholder={TT_DEFAULT_CAPTION_TEMPLATE}
          />
          <SettingText
            settingKey={TT_SETTING_HASHTAGS_BASE}
            label="Hashtags — base set (every short)"
            hint={`Space- or comma-separated. Appended to the rendered caption, deduplicated against any tags already in the caption. Empty falls back to: ${TT_DEFAULT_HASHTAGS_BASE || "(none — template carries the hashtags)"}`}
            initial={ttHashtagsBase ?? ""}
            placeholder={TT_DEFAULT_HASHTAGS_BASE}
          />
          {SHORT_CATEGORIES.map((c) => (
            <SettingText
              key={c}
              settingKey={ttHashtagsCategoryKey(c)}
              label={`Hashtags — ${c}`}
              hint={`Space- or comma-separated. Appended to the base set on shorts in this category. Empty falls back to: ${TT_DEFAULT_HASHTAGS_BY_CATEGORY[c] || "(none)"}`}
              initial={ttHashtagsByCat[c] ?? ""}
              placeholder={TT_DEFAULT_HASHTAGS_BY_CATEGORY[c] ?? ""}
            />
          ))}
          <SettingChipGroup<string>
            settingKey={TT_SETTING_PRIVACY_DEFAULT}
            label="Privacy default (Direct mode only)"
            hint="The publisher validates the requested level against the account's allowed list at publish time (TikTok dynamically restricts what each account can use). Falls back to Self only if the requested level is disallowed."
            initial={ttPrivacy ?? TT_DEFAULT_PRIVACY_LEVEL}
            options={TT_PRIVACY_OPTIONS}
          />
          <SettingToggle
            settingKey={TT_SETTING_IS_AIGC}
            label="Label as AI-generated"
            hint="Maps to post_info.is_aigc. On (default) is the truthful answer for LoreWire shorts and surfaces TikTok's 'Creator labeled as AI-generated' tag on the video."
            initialOn={readToggle(ttIsAigcRaw, true)}
          />
          <SettingToggle
            settingKey={TT_SETTING_DISABLE_DUET}
            label="Disable duets"
            hint="When on, other TikTok users cannot duet this post."
            initialOn={readToggle(ttDisableDuetRaw, false)}
          />
          <SettingToggle
            settingKey={TT_SETTING_DISABLE_STITCH}
            label="Disable stitches"
            hint="When on, other TikTok users cannot stitch this post."
            initialOn={readToggle(ttDisableStitchRaw, false)}
          />
          <SettingToggle
            settingKey={TT_SETTING_DISABLE_COMMENT}
            label="Disable comments"
            hint="When on, comments are closed on this post."
            initialOn={readToggle(ttDisableCommentRaw, false)}
          />
        </Section>

        {/* ── Cross-platform ───────────────────────────────────────── */}
        <Section
          title="Cross-platform — Publisher caption hooks"
          description="Per-platform caption suffix appended when a short with an enabled poll is published. Empty = use the default for that platform. Substitution tokens: {question} and {slug}."
        >
          {PUBLISHER_PLATFORMS.map((platform) => (
            <SettingText
              key={platform}
              settingKey={pollHookSettingKey(platform)}
              label={`${platform[0].toUpperCase()}${platform.slice(1)} caption hook`}
              hint={`Default: ${DEFAULT_POLL_HOOK_TEMPLATES[platform].replace(/\n/g, "\\n")}`}
              initial={pollHookOverrides[platform]}
              placeholder="Leave empty to use the platform default"
            />
          ))}
        </Section>
      </div>
    </SettingsShell>
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

function StatusLine({
  label,
  value,
  credentialLabel,
  credentialOk,
  credentialMissingHint,
}: {
  label: string;
  value: string;
  credentialLabel: string;
  credentialOk: boolean;
  credentialMissingHint: string;
}) {
  return (
    <div className="rounded-md border border-rule bg-paper-soft px-3 py-2 text-[13px] leading-snug">
      <div className="font-medium text-ink">
        {label}: <span className="font-mono">{value}</span>
      </div>
      <div className="mt-0.5 text-muted">
        {credentialLabel}:{" "}
        {credentialOk
          ? "✓ configured (server env var)"
          : `✗ ${credentialMissingHint}`}
      </div>
    </div>
  );
}
