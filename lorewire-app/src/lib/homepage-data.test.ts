// Tests for the homepage Server Component's SSR fan-out
// (loadHomepageSSRData) and its failure-isolation contract: when one of
// the three sub-loaders throws, the other two still seed and the failing
// field falls back to its safe sentinel. The tests use `vi.doMock` +
// dynamic re-import so each case mocks a different sub-loader cleanly,
// without leaking module state between tests.
//
// Module-level mock: `readVoteToken` from @/lib/poll-cookie wraps next/
// headers' `cookies()`, which throws when called outside a Next.js
// request scope. Vitest tests have no such scope, so every call to the
// polls loader would otherwise fail — masking whatever each test
// actually wants to assert. We default the cookie read to `null` (the
// "no returning voter" path) for every test and let individual cases
// override the poll-cookie module when they specifically need polls to
// fail.
//
// Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/poll-cookie", () => ({
  readVoteToken: async () => null,
}));

afterEach(() => {
  // Reset module cache so each test gets a fresh import graph. Per-test
  // doMock overrides live until vi.doUnmock is called below; the top-of-
  // file vi.mock for @/lib/poll-cookie is intentionally NOT unmocked so
  // every test keeps the safe "no returning voter" default.
  vi.resetModules();
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/lib/repo");
  vi.doUnmock("@/lib/homepage-curation");
  vi.doUnmock("@/lib/polls");
});

// Happy path against the test SQLite (empty by default per tests/setup.ts).
// Empty DB still returns a well-formed initial: null curation, default
// behavior, empty live rows, empty poll rails. That's the same shape the
// client used to start with — but now resolved server-side so the shells
// can mark `loaded=true` from the first render.
describe("loadHomepageSSRData (happy path, empty DB)", () => {
  it("returns the union of all three loaders with safe empties when the DB has no rows", async () => {
    const { loadHomepageSSRData } = await import("@/lib/homepage-data");
    const initial = await loadHomepageSSRData();
    expect(initial.curation).not.toBeUndefined();
    expect(initial.curation && Array.isArray(initial.curation.hero)).toBe(true);
    expect(initial.curation?.hero).toEqual([]);
    expect(initial.behavior).toEqual({
      emptyRailBehavior: "fallback",
      heroRequired: false,
    });
    expect(initial.rawCurationCount).toBe(0);
    expect(initial.liveRows).toEqual([]);
    expect(initial.pollRails.ok).toBe(true);
    expect(initial.pollRails.rails).toEqual({
      divisive: [],
      agreed: [],
      unpopular: [],
    });
  });
});

// Failure isolation: each of the three loaders gets its dependency
// stubbed to throw, in turn. The other two must still produce real
// results, and the failing field must fall back to its sentinel. The
// warn log is emitted with the failing source name so an operator
// scanning logs sees which sub-system died.
describe("loadHomepageSSRData (failure isolation)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("a curation failure leaves liveRows + pollRails intact", async () => {
    vi.doMock("@/lib/homepage-curation", async () => {
      const actual = await vi.importActual<typeof import("@/lib/homepage-curation")>(
        "@/lib/homepage-curation",
      );
      return {
        ...actual,
        listAllCuration: () => {
          throw new Error("simulated curation failure");
        },
      };
    });
    const { loadHomepageSSRData } = await import("@/lib/homepage-data");
    const initial = await loadHomepageSSRData();
    expect(initial.curation).toBeNull();
    expect(initial.behavior).toEqual({
      emptyRailBehavior: "fallback",
      heroRequired: false,
    });
    // The other two sub-loaders still succeeded (empty DB -> empty arrays
    // and ok=true on the polls result).
    expect(Array.isArray(initial.liveRows)).toBe(true);
    expect(initial.pollRails.ok).toBe(true);
    expect(initial.pollRails.rails.divisive).toEqual([]);
    // The warn log fires once with source=curation.
    const calls = warnSpy.mock.calls.filter(
      (c: unknown[]) => c[0] === "[lorewire homepage ssr error]",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({ source: "curation" });
  });

  it("a live-catalog failure leaves curation + pollRails intact", async () => {
    vi.doMock("@/lib/db", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db")>(
        "@/lib/db",
      );
      return {
        ...actual,
        all: vi.fn(async (sql: string) => {
          // Only the live-catalog SELECT names hero_image + video_url
          // together — anchor on that to break only this loader.
          if (sql.includes("hero_image") && sql.includes("video_url") && sql.includes("FROM stories")) {
            throw new Error("simulated catalog failure");
          }
          // Other queries (curation publish-set lookup) still resolve.
          return [];
        }),
      };
    });
    const { loadHomepageSSRData } = await import("@/lib/homepage-data");
    const initial = await loadHomepageSSRData();
    expect(initial.liveRows).toEqual([]);
    expect(initial.curation).not.toBeNull();
    expect(initial.pollRails.ok).toBe(true);
    expect(initial.pollRails.rails.agreed).toEqual([]);
    const calls = warnSpy.mock.calls.filter(
      (c: unknown[]) => c[0] === "[lorewire homepage ssr error]",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({ source: "catalog" });
  });

  it("a polls failure leaves curation + liveRows intact", async () => {
    // Break the polls loader by throwing inside the settings reads (the
    // first await in loadHomepagePolls). This puts the throw OUTSIDE
    // safeQuery so the whole polls fan-out fails, which is the contract
    // the SSR failure-isolation guards. Only the poll-rail setting keys
    // throw — curation's own getSetting reads (curation.*) still resolve
    // so loadHomepageCuration keeps working.
    vi.doMock("@/lib/repo", async () => {
      const actual = await vi.importActual<typeof import("@/lib/repo")>(
        "@/lib/repo",
      );
      return {
        ...actual,
        getSetting: async (key: string) => {
          if (key.startsWith("polls.")) {
            throw new Error("simulated polls failure");
          }
          return actual.getSetting(key);
        },
      };
    });
    const { loadHomepageSSRData } = await import("@/lib/homepage-data");
    const initial = await loadHomepageSSRData();
    expect(initial.pollRails.ok).toBe(false);
    expect(initial.pollRails.rails).toEqual({
      divisive: [],
      agreed: [],
      unpopular: [],
    });
    expect(initial.curation).not.toBeNull();
    expect(Array.isArray(initial.liveRows)).toBe(true);
    const calls = warnSpy.mock.calls.filter(
      (c: unknown[]) => c[0] === "[lorewire homepage ssr error]",
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({ source: "polls" });
  });
});
