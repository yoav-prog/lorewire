// Collapsible Settings section. Originally the inline `Section` in
// settings/socials/page.tsx; promoted to a shared component on 2026-06-25
// so every Settings sub-page (General, Models, Voiceovers, SEO, Socials,
// Intros & outros) renders the same accordion UI.
//
// Native <details>/<summary> on purpose: stays server-rendered (no client
// JS), accessible by default, the browser handles keyboard navigation,
// and on first paint nothing flickers. All sections default to closed —
// long pages with many sections become a quick scan of titles you can
// expand one at a time. Pass `defaultOpen` to keep a section expanded
// on first paint.
//
// The optional `status` pill in the summary lets the operator see at a
// glance whether a section needs attention (e.g. Configured / Env missing
// on Socials) without expanding it.

export type SettingsSectionStatus = {
  ok: boolean;
  label: string;
};

export default function SettingsSection({
  title,
  description,
  status,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  status?: SettingsSectionStatus;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-line bg-surface"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
            {title}
          </h2>
          {status && (
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                status.ok
                  ? "bg-accent/10 text-accent"
                  : "bg-warn/10 text-warn"
              }`}
            >
              {status.ok ? "✓" : "✗"} {status.label}
            </span>
          )}
        </div>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 shrink-0 text-muted transition-transform group-open:rotate-180"
        >
          <path
            d="M2 4l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-4">
        {description && (
          <p className="text-[13px] text-muted">{description}</p>
        )}
        {children}
      </div>
    </details>
  );
}
