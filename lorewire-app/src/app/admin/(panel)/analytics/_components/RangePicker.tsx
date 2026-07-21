import Link from "next/link";
import { ANALYTICS_RANGES } from "@/lib/analytics-shared";

// Range chips (7 / 30 / 90 days / all time). Plain links that rewrite
// ?range= on the current path, so the selection is shareable, survives
// refresh, and the pages stay server components.
export default function RangePicker({
  basePath,
  active,
}: {
  basePath: string;
  active: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ANALYTICS_RANGES.map((r) => {
        const isActive = r.param === active;
        return (
          <Link
            key={r.param}
            href={`${basePath}?range=${r.param}`}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded-full bg-accent px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-bg"
                : "rounded-full border border-line px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
            }
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}
