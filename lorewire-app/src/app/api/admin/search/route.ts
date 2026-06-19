// Global admin search endpoint. Backs the search bar in the admin shell
// (plan: _plans/2026-06-19-global-admin-search.md). One round trip per
// query: fetch candidate rows via parameter-bound SQL, score in JS, ship
// the top 6 per entity.
//
// Security (rule 13):
//   - requireAdmin() gates every request; no anonymous search surface.
//   - q is capped at MAX_QUERY_LENGTH; tokens at MAX_TOKENS; candidates
//     at 200 per entity; results at PER_ENTITY_LIMIT. Every multiplier is
//     bounded so a crafted query cannot fan out into a DoS.
//   - Every SQL value is bound via ? placeholders (see
//     listRedditSourcesForSearch / listStoriesForSearch). No string
//     concatenation; the literal "' OR 1=1 --" returns 0 rows because
//     it's just a substring search target.
//   - Logs `q.length` and counts, not the verbatim query, so a future
//     audit log doesn't accidentally capture sensitive titles (rule 13
//     + rule 14).
//
// Observability (rule 14): one [admin search] line per request with
// timing + result counts.

import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/dal";
import {
  buildSnippet,
  compareScored,
  MAX_QUERY_LENGTH,
  score,
  tokenise,
} from "@/lib/admin-search";
import { listRedditSourcesForSearch } from "@/lib/reddit-source";
import { listStoriesForSearch } from "@/lib/repo";

const PER_ENTITY_CANDIDATES = 200;
const PER_ENTITY_LIMIT = 6;

interface RedditHit {
  reddit_id: string;
  subreddit: string;
  title: string;
  snippet: string;
  href: string;
  score: number;
}

interface StoryHit {
  id: string;
  category: string;
  title: string;
  snippet: string;
  href: string;
  score: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  await requireAdmin();
  const t0 = Date.now();
  const { searchParams } = new URL(req.url);
  const rawQ = (searchParams.get("q") ?? "").trim();

  if (!rawQ) {
    return Response.json({ q: "", took_ms: 0, reddit: [], stories: [] });
  }
  if (rawQ.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: `Query too long (max ${MAX_QUERY_LENGTH} chars)` },
      { status: 400 },
    );
  }

  const tokens = tokenise(rawQ);
  if (tokens.length === 0) {
    // Pure-punctuation queries land here. Return empty quickly so the
    // bar stops showing the loading shimmer.
    return Response.json({ q: rawQ, took_ms: Date.now() - t0, reddit: [], stories: [] });
  }

  let reddit: RedditHit[] = [];
  let stories: StoryHit[] = [];
  try {
    const [rsCandidates, stCandidates] = await Promise.all([
      listRedditSourcesForSearch(tokens, PER_ENTITY_CANDIDATES),
      listStoriesForSearch(tokens, PER_ENTITY_CANDIDATES),
    ]);

    reddit = rsCandidates
      .map((row) => {
        const { score: s } = score(
          {
            title: row.title,
            summary: row.summary,
            body: row.full_text,
            bucket: row.subreddit,
          },
          tokens,
          rawQ,
        );
        return { row, s };
      })
      .filter((x) => x.s > 0)
      .map(({ row, s }) => ({
        id: row.reddit_id,
        score: s,
        updated_at: row.last_synced,
        reddit_id: row.reddit_id,
        subreddit: row.subreddit,
        title: row.title,
        snippet: buildSnippet(
          { summary: row.summary, body: null, full_text: row.full_text },
          tokens,
        ),
        href: `/admin/reddit-sources/${encodeURIComponent(row.reddit_id)}`,
      }))
      .sort(compareScored)
      .slice(0, PER_ENTITY_LIMIT)
      .map(({ score: s, ...rest }) => ({
        reddit_id: rest.reddit_id,
        subreddit: rest.subreddit,
        title: rest.title,
        snippet: rest.snippet,
        href: rest.href,
        score: s,
      }));

    stories = stCandidates
      .map((row) => {
        const { score: s } = score(
          {
            title: row.title,
            summary: row.summary,
            body: row.body,
            bucket: row.category,
          },
          tokens,
          rawQ,
        );
        return { row, s };
      })
      .filter((x) => x.s > 0)
      .map(({ row, s }) => ({
        id: row.id,
        score: s,
        updated_at: row.updated_at,
        category: row.category ?? "",
        title: row.title ?? "",
        snippet: buildSnippet(
          { summary: row.summary, body: row.body, full_text: null },
          tokens,
        ),
        href: `/admin/stories/${encodeURIComponent(row.id)}`,
      }))
      .sort(compareScored)
      .slice(0, PER_ENTITY_LIMIT)
      .map(({ score: s, ...rest }) => ({
        id: rest.id,
        category: rest.category,
        title: rest.title,
        snippet: rest.snippet,
        href: rest.href,
        score: s,
      }));
  } catch (err) {
    console.warn("[admin search] error", { err: String(err).slice(0, 200) });
    return Response.json({ error: "Search failed" }, { status: 500 });
  }

  const took = Date.now() - t0;
  console.info("[admin search]", {
    q_len: rawQ.length,
    tokens: tokens.length,
    took_ms: took,
    reddit: reddit.length,
    stories: stories.length,
  });

  return Response.json({
    q: rawQ,
    took_ms: took,
    reddit,
    stories,
  });
}
