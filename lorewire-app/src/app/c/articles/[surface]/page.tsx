// /c/articles/[surface] — public rail pages for article-attached
// polls. Mirrors /c/[surface] for story polls. Surface ∈
// "divisive" | "agreed" | "unpopular". Standalone routes so they
// can be deep-linked from social, the post-vote follow-up (when we
// add one for articles), or a future header nav.
//
// 2026-06-18 standalone-article polls (plan §15) + article-only
// divisive/agreed/unpopular surface follow-up.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  RAIL_DEFAULT_LIMIT,
  topArticleAgreed,
  topArticleDivisive,
  topArticleUnpopular,
  type ArticleRailCardRow,
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
  blurb: string;
  emptyCopy: string;
}

const SURFACE_META: Record<RailSurface, SurfaceMeta> = {
  divisive: {
    title: "Most divisive articles",
    description:
      "Lorewire articles where the audience is most evenly split. Closest to 50/50 first.",
    blurb:
      "Every article below ended up nearly tied. The vote you'd cast probably puts you in the majority by a single point.",
    emptyCopy:
      "No divisive articles yet. As more readers vote, the closest splits will surface here.",
  },
  agreed: {
    title: "Articles the community agreed on",
    description:
      "Lorewire articles where the audience overwhelmingly picked the same side.",
    blurb:
      "Every article below ended up lopsided. If you disagree with the majority, you'll know within one vote.",
    emptyCopy:
      "No clear consensus yet. Once enough articles have votes, the most lopsided ones will land here.",
  },
  unpopular: {
    title: "Unpopular opinions (articles)",
    description:
      "Lorewire articles where the side you picked was in the minority — or, for first-time visitors, articles with a near-unanimous landslide.",
    blurb:
      "Articles below either contradicted your previous votes, or have a clear majority opinion you might want to push back on.",
    emptyCopy:
      "Nothing to surface here yet. Vote on a few articles and your minority picks will show up.",
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
      canonical: `/c/articles/${surface}`,
    },
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: "website",
      url: `/c/articles/${surface}`,
      siteName: seo.siteName,
    },
  };
}

export default async function ArticleRailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { surface } = await params;
  if (!isRailSurface(surface)) notFound();
  const meta = SURFACE_META[surface];

  let rows: ArticleRailCardRow[];
  if (surface === "divisive") {
    rows = await topArticleDivisive({ limit: RAIL_DEFAULT_LIMIT });
  } else if (surface === "agreed") {
    rows = await topArticleAgreed({ limit: RAIL_DEFAULT_LIMIT });
  } else {
    // Unpopular: cookie token drives the personalized variant; null
    // (fresh visitor) hits the public landslide fallback.
    const cookieToken = await readVoteToken();
    rows = await topArticleUnpopular({
      cookieToken,
      limit: RAIL_DEFAULT_LIMIT,
    });
  }

  console.info("[c articles rail page]", {
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
            href={`/c/${surface}`}
            className="font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink"
          >
            ← Story polls
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
          data-testid="article-rail-empty-state"
        >
          <p className="text-[14px] text-ink">{meta.emptyCopy}</p>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
          {rows.map((row) => (
            <li key={row.pollId}>
              <ArticleRailCard surface={surface} row={row} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ArticleRailCard({
  surface,
  row,
}: {
  surface: RailSurface;
  row: ArticleRailCardRow;
}) {
  // Article cards are text-first (no poster art the way story cards
  // have). The hero image, if present, sits small on the left so the
  // title + question + split stay the visual focus.
  const language = row.language ?? "en";
  const href = row.slug
    ? `/articles/${language}/${row.slug}`
    : `/articles/${language}/${row.articleId}`;
  const pctA = Math.round((row.votesA / Math.max(1, row.totalVotes)) * 100);
  const pctB = 100 - pctA;
  return (
    <Link
      href={href}
      className="group flex items-stretch gap-4 overflow-hidden rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
    >
      {row.heroImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.heroImage}
          alt=""
          aria-hidden
          className="hidden h-[88px] w-[88px] flex-shrink-0 rounded-lg object-cover sm:block"
        />
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-baseline gap-2">
          {row.category && (
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              {row.category}
            </span>
          )}
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            · {row.totalVotes.toLocaleString()} votes
          </span>
          {surface === "divisive" && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              · divisiveness {row.divisiveness.toFixed(2)}
            </span>
          )}
          {surface === "agreed" && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
              · agreement {(1 - row.divisiveness).toFixed(2)}
            </span>
          )}
        </div>
        <h2 className="font-display text-[17px] font-bold leading-snug text-ink group-hover:text-accent">
          {row.title ?? "Untitled article"}
        </h2>
        <p className="text-[13px] text-muted">{row.question}</p>
        <div className="flex items-center gap-3 text-[12px]">
          <span className="flex items-baseline gap-1.5 text-ink">
            <span className="truncate">{row.optionAText}</span>
            <span className="font-mono">{pctA}%</span>
          </span>
          <span
            aria-hidden
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg"
          >
            <span
              className="block h-full bg-accent"
              style={{ width: `${pctA}%` }}
            />
          </span>
          <span className="flex items-baseline gap-1.5 text-ink">
            <span className="font-mono">{pctB}%</span>
            <span className="truncate">{row.optionBText}</span>
          </span>
        </div>
      </div>
    </Link>
  );
}
