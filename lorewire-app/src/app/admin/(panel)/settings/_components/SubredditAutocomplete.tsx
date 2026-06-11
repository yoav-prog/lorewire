"use client";

// Thin wrapper around <SettingAutocomplete> that hardcodes the
// /api/admin/subreddit-suggest endpoint and the Reddit response shape. Lives
// here (next to the Settings page) instead of inside SettingControls because
// the response-mapping function would need to cross the server/client
// boundary if it were passed as a prop from the server page — easier to
// just colocate the wrapper.

import {
  SettingAutocomplete,
  type AutocompleteSuggestion,
} from "./SettingControls";

interface SubredditRow {
  name?: string;
  subscribers?: number;
  over18?: boolean;
}

function mapResponse(json: unknown): AutocompleteSuggestion[] {
  if (!json || typeof json !== "object") return [];
  const subs = (json as { subreddits?: SubredditRow[] }).subreddits;
  if (!Array.isArray(subs)) return [];
  return subs
    .filter((s): s is SubredditRow & { name: string } =>
      Boolean(s && typeof s.name === "string" && s.name.length > 0),
    )
    .map((s) => ({
      value: s.name,
      label: `r/${s.name}`,
      meta: formatMeta(s),
    }));
}

function formatMeta(s: SubredditRow): string | undefined {
  const parts: string[] = [];
  if (typeof s.subscribers === "number" && s.subscribers > 0) {
    parts.push(`${formatCompact(s.subscribers)} subscribers`);
  }
  if (s.over18) parts.push("NSFW");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function SubredditAutocomplete({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
}) {
  return (
    <SettingAutocomplete
      settingKey={settingKey}
      label={label}
      hint={hint}
      initial={initial}
      placeholder={placeholder}
      endpoint="/api/admin/subreddit-suggest"
      mapResponse={mapResponse}
      minQueryLength={2}
    />
  );
}
