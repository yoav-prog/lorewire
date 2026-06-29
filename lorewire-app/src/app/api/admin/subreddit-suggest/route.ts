// Server proxy for Reddit's public subreddit autocomplete endpoint.
//
// Why proxy instead of hitting Reddit from the client: keeps the User-Agent
// header consistent (Reddit asks for one), avoids any CORS surprises, and
// gives us a single place to add rate-limiting later if the admin pounds
// the input. The endpoint itself is unauthenticated — no API key needed.
//
// Security (rule 13): admin-gated like the rest of the panel surface. The
// query string is URL-encoded before forwarding so a `&` in the user's
// input can't inject extra params upstream. We don't echo Reddit's full
// payload back; we map to a slim `{ name, subscribers, over18 }[]` shape
// the client UI actually uses.

import { NextRequest } from "next/server";
import { requireCapability } from "@/lib/dal";

interface SubredditSuggestion {
  name: string;
  subscribers: number;
  over18: boolean;
}

interface RedditAutocompleteEntry {
  data?: {
    display_name?: string;
    subscribers?: number;
    over_18?: boolean;
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  await requireCapability("content.manage");
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return Response.json({ subreddits: [] satisfies SubredditSuggestion[] });
  }

  const upstream = new URL(
    "https://www.reddit.com/api/subreddit_autocomplete_v2.json",
  );
  upstream.searchParams.set("query", q);
  upstream.searchParams.set("include_over_18", "false");
  upstream.searchParams.set("include_profiles", "false");
  upstream.searchParams.set("limit", "10");

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstream, {
      headers: { "User-Agent": "LoreWire/1.0 (admin subreddit picker)" },
      // 5s cap — autocomplete should be snappy or it's not useful.
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[subreddit suggest] upstream fetch failed", { q, msg });
    return Response.json({ subreddits: [] satisfies SubredditSuggestion[] });
  }

  if (!upstreamResp.ok) {
    console.warn("[subreddit suggest] upstream non-OK", {
      q,
      status: upstreamResp.status,
    });
    return Response.json({ subreddits: [] satisfies SubredditSuggestion[] });
  }

  let json: { data?: { children?: RedditAutocompleteEntry[] } };
  try {
    json = await upstreamResp.json();
  } catch {
    return Response.json({ subreddits: [] satisfies SubredditSuggestion[] });
  }

  const children = json.data?.children ?? [];
  const subreddits: SubredditSuggestion[] = children
    .map((c) => ({
      name: c.data?.display_name ?? "",
      subscribers: c.data?.subscribers ?? 0,
      over18: Boolean(c.data?.over_18),
    }))
    .filter((s) => s.name);

  console.info("[subreddit suggest] ok", { q, count: subreddits.length });
  return Response.json({ subreddits });
}
