// Magic-link token lifecycle coverage.
//
// What this file pins:
//   - Token generation produces well-formed, non-colliding tokens.
//   - Hash is deterministic.
//   - issue → consume happy path returns the email.
//   - Consume rejects unknown / expired / already-used tokens.
//   - Two concurrent consumes of the same token can't both succeed.
//
// What this file does NOT cover:
//   - The Brevo send (network — exercised manually in the QA pass).
//   - The two route handlers (integration shape).

import { describe, expect, it } from "vitest";

import { run } from "@/lib/db";
import {
  consumeMagicLink,
  hashMagicLinkToken,
  issueMagicLink,
  newMagicLinkToken,
  pruneExpiredMagicLinks,
} from "./magic-link";

describe("magic-link token primitive", () => {
  it("emits a 64-character lower-hex token (256 bits)", () => {
    const t = newMagicLinkToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not collide across 200 generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newMagicLinkToken());
    expect(seen.size).toBe(200);
  });

  it("hash is deterministic for a given token", () => {
    const t = newMagicLinkToken();
    expect(hashMagicLinkToken(t)).toBe(hashMagicLinkToken(t));
  });
});

describe("issueMagicLink + consumeMagicLink", () => {
  it("round-trips: issue creates a row that consume returns + invalidates", async () => {
    const issued = await issueMagicLink("alpha@example.com");
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const claim = await consumeMagicLink(issued.token);
    expect(claim?.email).toBe("alpha@example.com");

    // Second consume on the same token must fail — single-use.
    const second = await consumeMagicLink(issued.token);
    expect(second).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    const fake = "0".repeat(64);
    expect(await consumeMagicLink(fake)).toBeNull();
  });

  it("returns null for an empty-string token", async () => {
    expect(await consumeMagicLink("")).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const issued = await issueMagicLink("beta@example.com");
    // Backdate expires_at directly so we don't need to wait 15 minutes.
    await run(
      `UPDATE magic_link_tokens SET expires_at = ? WHERE token_hash = ?`,
      [new Date(Date.now() - 60_000).toISOString(), hashMagicLinkToken(issued.token)],
    );
    expect(await consumeMagicLink(issued.token)).toBeNull();
  });

  it("two concurrent consumes can't both succeed", async () => {
    const issued = await issueMagicLink("concurrent@example.com");
    const [a, b] = await Promise.all([
      consumeMagicLink(issued.token),
      consumeMagicLink(issued.token),
    ]);
    const successes = [a, b].filter((x) => x !== null);
    expect(successes.length).toBe(1);
  });
});

describe("pruneExpiredMagicLinks", () => {
  it("removes expired and used rows but leaves fresh, unused tokens", async () => {
    const fresh = await issueMagicLink("fresh@example.com");
    const stale = await issueMagicLink("stale@example.com");
    await run(
      `UPDATE magic_link_tokens SET expires_at = ? WHERE token_hash = ?`,
      [
        new Date(Date.now() - 60_000).toISOString(),
        hashMagicLinkToken(stale.token),
      ],
    );
    const used = await issueMagicLink("used@example.com");
    await consumeMagicLink(used.token);

    const pruned = await pruneExpiredMagicLinks();
    expect(pruned).toBeGreaterThanOrEqual(2);

    // Fresh token still consumable.
    expect((await consumeMagicLink(fresh.token))?.email).toBe(
      "fresh@example.com",
    );
  });
});
