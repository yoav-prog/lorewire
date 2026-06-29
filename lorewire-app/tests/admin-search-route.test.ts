// Tests for the GET /api/admin/search route handler (plan:
// _plans/2026-06-19-global-admin-search.md).
//
// The scoring + tokenising + snippet logic is exercised by
// src/lib/admin-search.test.ts; here we lock down the route-specific
// guards: empty q, oversized q, pure-punctuation q, SQL-injection-shaped
// q (which must return zero rows without throwing, because q is param-
// bound — never concatenated into SQL).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the admin gate so tests don't need a session cookie. Mirrors the
// approach the existing content tests would use if they had a route
// test — keeps the test surface "the handler logic, not the auth".
vi.mock("@/lib/dal", () => ({
  requireAdmin: vi.fn(async () => ({ userId: "test-user" })),
  requireCapability: vi.fn(async () => ({ userId: "test-user" })),
}));

vi.mock("@/lib/reddit-source", () => ({
  listRedditSourcesForSearch: vi.fn(async () => []),
}));

vi.mock("@/lib/repo", () => ({
  listStoriesForSearch: vi.fn(async () => []),
}));

// Import AFTER the mocks so the route handler picks up our stubs.
import { GET } from "@/app/api/admin/search/route";
import { listRedditSourcesForSearch } from "@/lib/reddit-source";
import { listStoriesForSearch } from "@/lib/repo";
import { MAX_QUERY_LENGTH } from "@/lib/admin-search";

function makeRequest(qs: string): Request {
  // The handler reads `new URL(req.url).searchParams`, so any concrete
  // URL works as long as the search string is correct.
  return new Request(`https://example.test/api/admin/search?${qs}`);
}

describe("/api/admin/search GET", () => {
  beforeEach(() => {
    vi.mocked(listRedditSourcesForSearch).mockClear();
    vi.mocked(listStoriesForSearch).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty arrays when q is missing", async () => {
    const res = await GET(makeRequest("") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reddit).toEqual([]);
    expect(body.stories).toEqual([]);
    expect(body.q).toBe("");
    // No DB hits when q is empty.
    expect(listRedditSourcesForSearch).not.toHaveBeenCalled();
    expect(listStoriesForSearch).not.toHaveBeenCalled();
  });

  it("returns empty arrays when q is whitespace", async () => {
    const res = await GET(makeRequest("q=%20%20%20") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reddit).toEqual([]);
    expect(body.stories).toEqual([]);
    expect(listRedditSourcesForSearch).not.toHaveBeenCalled();
  });

  it("returns 400 when q exceeds MAX_QUERY_LENGTH", async () => {
    const huge = "a".repeat(MAX_QUERY_LENGTH + 1);
    const res = await GET(makeRequest(`q=${huge}`) as never);
    expect(res.status).toBe(400);
    expect(listRedditSourcesForSearch).not.toHaveBeenCalled();
  });

  it("returns empty arrays for pure-punctuation q (no usable tokens)", async () => {
    // The tokeniser drops <2-char tokens and trims edge punctuation; "?"
    // and "..." collapse to nothing. The route returns empty without
    // hitting the DB.
    const res = await GET(makeRequest("q=%3F%3F%3F") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reddit).toEqual([]);
    expect(body.stories).toEqual([]);
    expect(listRedditSourcesForSearch).not.toHaveBeenCalled();
  });

  it("SQL-injection-shaped query is harmless (param-bound, returns zero rows)", async () => {
    // The string is just a substring search target. Repo helpers return
    // []; the route stays a 200 with empty hits. This is a smoke test —
    // the real protection is the parameter binding in the repo functions
    // (asserted by code review, not by execution).
    const evil = encodeURIComponent("' OR 1=1 --");
    const res = await GET(makeRequest(`q=${evil}`) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reddit).toEqual([]);
    expect(body.stories).toEqual([]);
    // Repo helpers WERE called (tokens existed) but with the literal
    // string as a token, not as SQL.
    expect(listRedditSourcesForSearch).toHaveBeenCalled();
  });

  it("passes tokens through to both repo helpers", async () => {
    await GET(makeRequest("q=steak+standoff") as never);
    expect(listRedditSourcesForSearch).toHaveBeenCalledWith(
      ["steak", "standoff"], 200,
    );
    expect(listStoriesForSearch).toHaveBeenCalledWith(
      ["steak", "standoff"], 200,
    );
  });

  it("ranks and ships happy-path hits", async () => {
    vi.mocked(listRedditSourcesForSearch).mockResolvedValueOnce([
      {
        reddit_id: "r1",
        subreddit: "AITAH",
        title: "THE STEAK STANDOFF",
        summary: "A short summary of the standoff.",
        full_text: "Long body content.",
        last_synced: "2026-06-19T00:00:00Z",
      },
    ]);
    vi.mocked(listStoriesForSearch).mockResolvedValueOnce([
      {
        id: "s1",
        category: "Drama",
        title: "The Steak Standoff",
        summary: "Rewritten for LoreWire.",
        body: "The body.",
        updated_at: "2026-06-19T00:00:00Z",
      },
    ]);
    const res = await GET(makeRequest("q=steak+standoff") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reddit).toHaveLength(1);
    expect(body.reddit[0].reddit_id).toBe("r1");
    expect(body.reddit[0].href).toBe("/admin/reddit-sources/r1");
    expect(body.reddit[0].snippet).toContain("**");
    expect(body.stories).toHaveLength(1);
    expect(body.stories[0].id).toBe("s1");
    expect(body.stories[0].href).toBe("/admin/stories/s1");
  });

  it("drops rows that the scorer rates 0", async () => {
    vi.mocked(listRedditSourcesForSearch).mockResolvedValueOnce([
      {
        reddit_id: "miss",
        subreddit: "OtherSub",
        title: "Completely unrelated headline",
        summary: "Nothing relevant here.",
        full_text: "Or here.",
        last_synced: "2026-06-19T00:00:00Z",
      },
    ]);
    const res = await GET(makeRequest("q=steak") as never);
    const body = await res.json();
    // Row had no token match across any field → score=0 → dropped.
    expect(body.reddit).toEqual([]);
  });
});
