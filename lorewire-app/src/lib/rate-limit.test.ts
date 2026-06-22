// Login throttle coverage. The contract that matters: failures accumulate up
// to the threshold, the next one locks the key, a success clears it, and the
// stored key never contains a raw IP. DB-backed against the test SQLite.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "@/lib/db";
import {
  clearLoginAttempts,
  isLoginBlocked,
  loginAttemptKey,
  recordLoginFailure,
} from "./rate-limit";

const KEY = "admin-login:test-key";

async function cleanup(): Promise<void> {
  await run("DELETE FROM login_attempts WHERE key LIKE 'admin-login:test%'", []);
}

describe("loginAttemptKey", () => {
  it("namespaces and hashes the IP — no raw IP at rest", () => {
    const key = loginAttemptKey("203.0.113.7");
    expect(key.startsWith("admin-login:")).toBe(true);
    expect(key).not.toContain("203.0.113.7");
    expect(key).toBe(loginAttemptKey("203.0.113.7")); // stable
    expect(key).not.toBe(loginAttemptKey("198.51.100.1")); // distinct
  });

  it("handles a missing IP", () => {
    expect(loginAttemptKey(null).startsWith("admin-login:")).toBe(true);
    expect(loginAttemptKey(undefined)).toBe(loginAttemptKey("unknown"));
  });
});

describe("login throttle", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("allows up to the threshold, then locks", async () => {
    // 4 failures: still allowed.
    for (let i = 0; i < 4; i++) await recordLoginFailure(KEY);
    expect((await isLoginBlocked(KEY)).blocked).toBe(false);

    // 5th failure trips the lock.
    await recordLoginFailure(KEY);
    const state = await isLoginBlocked(KEY);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeLessThanOrEqual(15 * 60);
  });

  it("a successful login clears the attempts", async () => {
    for (let i = 0; i < 5; i++) await recordLoginFailure(KEY);
    expect((await isLoginBlocked(KEY)).blocked).toBe(true);
    await clearLoginAttempts(KEY);
    expect((await isLoginBlocked(KEY)).blocked).toBe(false);
  });

  it("an unknown key is never blocked", async () => {
    expect((await isLoginBlocked("admin-login:test-never-seen")).blocked).toBe(
      false,
    );
  });
});
