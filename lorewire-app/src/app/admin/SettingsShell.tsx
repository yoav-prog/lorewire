import Link from "next/link";

// Settings hub layout. Each of the three settings sub-pages
// (Settings/General, Models, Intros & outros) renders inside this shell
// so the user sees a stable two-column page with the same sticky left
// sub-nav. Captions intentionally do NOT have a sub-nav entry — they
// belong inside the video editor (see _plans/2026-06-12-admin-reorg-phase2.md
// §"Captions are intentionally not a Settings sub-nav category").

export type SettingsCategory =
  | "general"
  | "models"
  | "seo"
  | "intros"
  | "social";

type CategoryDef = {
  key: SettingsCategory;
  label: string;
  href: string;
  description: string;
};

const CATEGORIES: CategoryDef[] = [
  {
    key: "general",
    label: "General",
    href: "/admin/settings",
    description: "Pipeline, voice, video look, and splice settings.",
  },
  {
    key: "models",
    label: "Models",
    href: "/admin/models",
    description: "Pick the AI model used at each pipeline stage.",
  },
  {
    key: "seo",
    label: "SEO",
    href: "/admin/seo",
    description: "Site identity, social cards, and search engine defaults.",
  },
  {
    key: "intros",
    label: "Intros & outros",
    href: "/admin/segments",
    description: "Branded clips spliced onto every rendered video.",
  },
  {
    key: "social",
    label: "Social accounts",
    href: "/admin/settings/social-accounts",
    description: "Accounts Lorewire publishes finished shorts to.",
  },
];

export default function SettingsShell({
  active,
  title,
  description,
  children,
}: {
  active: SettingsCategory;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
          Settings
        </p>
        <h1 className="mt-1 font-display text-[22px] font-extrabold tracking-tightest">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-[14px] text-muted">{description}</p>
        )}
      </header>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside className="md:sticky md:top-[68px] md:self-start">
          <nav aria-label="Settings categories">
            <ul className="space-y-1">
              {CATEGORIES.map((c) => {
                const isActive = c.key === active;
                return (
                  <li key={c.key}>
                    <Link
                      href={c.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`block rounded-lg border px-3 py-2 transition-colors ${
                        isActive
                          ? "border-accent/40 bg-accent/10 text-ink"
                          : "border-line bg-surface text-muted hover:border-line hover:bg-surface2 hover:text-ink"
                      }`}
                    >
                      <span
                        className={`block font-mono text-[12px] uppercase tracking-wider ${
                          isActive ? "text-ink" : ""
                        }`}
                      >
                        {c.label}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted">
                        {c.description}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <section className="min-w-0">{children}</section>
      </div>
    </div>
  );
}
