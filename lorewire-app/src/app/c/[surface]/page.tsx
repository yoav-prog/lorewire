// /c/[surface] — public rail pages for engagement-poll surfaces.
// `surface` ∈ "divisive" | "agreed" | "unpopular". Each renders a list
// of story cards computed live from poll_aggregates. Standalone routes
// (no homepage curation involved) so they can be linked from the
// post-vote follow-up, social posts, or a future header nav.
//
// Phase 4 of _plans/2026-06-17-engagement-polls.md.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  RAIL_DEFAULT_LIMIT,
  topAgreed,
  topDivisive,
  topUnpopular,
  type RailCardRow,
} from "@/lib/polls";
import { readVoteToken } from "@/lib/poll-cookie";
import { getSiteSeo, buildPageTitle } from "@/lib/site-seo";

const SURFACES = ["divisive", "agreed", "unpopular"] as const;
type RailSurface = (typeof SURFACES)[number];

function isRailSurface(v: string): v is RailSurface {
  return (SURFACES as readonly string[]).includes(v);
}

interface SurfaceMeta {
  title: string;
  description: string;
  /** Copy under the H1; describes WHY a card landed on this rail so
   *  the reader understands what they're looking at. */
  blurb: string;
  /** Empty-state copy when the rail returns zero cards. Different per
   *  surface so the message stays honest (Unpopular without enough
   *  vote history is a real fallback case, not "broken"). */
  emptyCopy: string;
}

const SURFACE_META: Record<RailSurface, SurfaceMeta> = {
  divisive: {
    title: "Most divisive stories",
    description:
      "Lorewire stories where the audience is most evenly split. Closest to 50/50 first.",
    blurb:
      "Every story below ended up nearly tied. The vote you'd cast probably puts you in the majority by a single point.",
    emptyCopy:
      "No divisive stories yet. As more readers vote, the closest splits will surface here.",
  },
  agreed: {
    title: "Community agreed",
    description:
      "Lorewire stories where the audience overwhelmingly picked the same side.",
    blurb:
      "Every story below ended up lopsided. If you disagree with the majority, you'll know within one vote.",
    emptyCopy:
      "No clear consensus yet. Once enough stories have votes, the most lopsided ones will land here.",
  },
  unpopular: {
    title: "Unpopular opinions",
    description:
      "Lorewire stories where the side you picked was in the minority — or, for first-time visitors, stories with a near-unanimous landslide.",
    blurb:
      "Stories below either contradicted your previous votes, or have a clear majority opinion you might want to push back on.",
    emptyCopy:
      "Nothing to surface here yet. Vote on a few stories and your minority picks will show up.",
  },
};

interface Params {
  surface: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { surface } = await params;
  const seo = await getSiteSeo();
  if (!isRailSurface(surface)) {
    return {
      title: buildPageTitle("Not found", seo.titleTemplate, seo.siteName),
    };
  }
  const meta = SURFACE_META[surface];
  return {
    title: buildPageTitle(meta.title, seo.titleTemplate, seo.siteName),
    description: meta.description,
    alternates: {
      canonical: `/c/${surface}`,
    },
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: "website",
      url: `/c/${surface}`,
      siteName: seo.siteName,
    },
  };
}

export default async function RailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { surface } = await params;
  if (!isRailSurface(surface)) notFound();
  const meta = SURFACE_META[surface];

  let rows: RailCardRow[];
  if (surface === "divisive") {
    rows = await topDivisive({ limit: RAIL_DEFAULT_LIMIT });
  } else if (surface === "agreed") {
    rows = await topAgreed({ limit: RAIL_DEFAULT_LIMIT });
  } else {
    // Unpopular: pass the cookie token so the personalized variant
    // fires when the visitor has vote history; readVoteToken() returns
    // null for fresh visitors and we fall back to the public landslide
    // rule automatically.
    const cookieToken = await readVoteToken();
    rows = await topUnpopular({
      cookieToken,
      limit: RAIL_DEFAULT_LIMIT,
    });
  }

  console.info("[c rail page]", {
    surface,
    result_count: rows.length,
  });

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10">
      <header className="space-y-3">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            ← lorewire.com
          </Link>
          <Link
            href={`/c/articles/${surface}`}
            className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            Article polls →
          </Link>
        </div>
        <h1 className="font-display text-[34px] font-extrabold leading-tight tracking-tightest text-ink">
          {meta.title}
        </h1>
        <p className="text-[15px] leading-relaxed text-muted">{meta.blurb}</p>
      </header>

      {rows.length === 0 ? (
        <div
          className="mt-10 rounded-xl border border-dashed border-line bg-surface p-8 text-center"
          data-testid="rail-empty-state"
        >
          <p className="text-[14px] text-ink">{meta.emptyCopy}</p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {rows.map((row) => (
            <li key={row.storyId}>
              <RailCard surface={surface} row={row} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function RailCard({
  surface,
  row,
}: {
  surface: RailSurface;
  row: RailCardRow;
}) {
  const href = row.slug ? `/v/${row.slug}` : `/v/${row.storyId}`;
  const pctA = Math.round((row.votesA / Math.max(1, row.totalVotes)) * 100);
  const pctB = 100 - pctA;
  return (
    <Link
      href={href}
      className="block overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-accent"
    >
      {row.heroImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.heroImage}
          alt=""
          className="aspect-[4/3] w-full object-cover"
        />
      )}
      <div className="space-y-3 p-4">
        {row.category && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
            {row.category}
          </span>
        )}
        <h2 className="font-display text-[18px] font-bold leading-snug text-ink">
          {row.title ?? "Untitled"}
        </h2>
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 font-mono text-[12px]">
            <span className="text-ink">{row.optionAText}</span>
            <span className="text-ink">{pctA}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bg">
            <div
              aria-hidden
              className="h-full bg-accent"
              style={{ width: `${pctA}%` }}
            />
          </div>
          <div className="flex items-baseline justify-between gap-3 font-mono text-[12px]">
            <span className="text-ink">{row.optionBText}</span>
            <span className="text-ink">{pctB}%</span>
          </div>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {row.totalVotes.toLocaleString()} votes
          {surface === "divisive" && (
            <span> · divisiveness {row.divisiveness.toFixed(2)}</span>
          )}
          {surface === "agreed" && (
            <span> · agreement {(1 - row.divisiveness).toFixed(2)}</span>
          )}
        </p>
      </div>
    </Link>
  );
}
