// Tests for worker-health: reading the heartbeat the Python worker
// writes into settings, and deriving online/stale/offline state for the
// admin UI.

import { beforeEach, describe, expect, it } from "vitest";

import { run } from "@/lib/db";
import {
  WORKER_HEARTBEAT_SETTING_KEY,
  WORKER_HEARTBEAT_STALE_MS,
  getWorkerHealth,
} from "./worker-health";

async function setHeartbeat(value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [WORKER_HEARTBEAT_SETTING_KEY, value],
  );
}

async function clearHeartbeat() {
  await run("DELETE FROM settings WHERE key = ?", [
    WORKER_HEARTBEAT_SETTING_KEY,
  ]);
}

describe("getWorkerHealth", () => {
  beforeEach(clearHeartbeat);

  it("returns offline when no heartbeat has ever been written", async () => {
    const h = await getWorkerHealth();
    expect(h.state).toBe("offline");
    expect(h.isHealthy).toBe(false);
    expect(h.lastSeenAt).toBeNull();
    expect(h.secondsSince).toBeNull();
  });

  it("returns online for a fresh heartbeat", async () => {
    await setHeartbeat(new Date().toISOString());
    const h = await getWorkerHealth();
    expect(h.state).toBe("online");
    expect(h.isHealthy).toBe(true);
    expect(h.secondsSince).toBeLessThan(2);
  });

  it("returns stale when the heartbeat is older than the window", async () => {
    const old = new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 5_000);
    await setHeartbeat(old.toISOString());
    const h = await getWorkerHealth();
    expect(h.state).toBe("stale");
    expect(h.isHealthy).toBe(false);
    // secondsSince should be roughly (stale_ms + 5000) / 1000.
    expect(h.secondsSince).toBeGreaterThan(WORKER_HEARTBEAT_STALE_MS / 1000);
  });

  it("treats a corrupt timestamp as offline (no spinning UI)", async () => {
    await setHeartbeat("not-a-timestamp");
    const h = await getWorkerHealth();
    expect(h.state).toBe("offline");
    expect(h.isHealthy).toBe(false);
    expect(h.secondsSince).toBeNull();
    // lastSeenAt still surfaces the raw bad value so a debugging admin
    // can see what's actually in the row.
    expect(h.lastSeenAt).toBe("not-a-timestamp");
  });

  it("handles the exact boundary: just-inside-stale-window is online", async () => {
    // 500ms inside the window — must still be online.
    const insideEdge = new Date(
      Date.now() - WORKER_HEARTBEAT_STALE_MS + 500,
    );
    await setHeartbeat(insideEdge.toISOString());
    const h = await getWorkerHealth();
    expect(h.state).toBe("online");
  });

  it("handles the exact boundary: just-past-stale-window is stale", async () => {
    const pastEdge = new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 500);
    await setHeartbeat(pastEdge.toISOString());
    const h = await getWorkerHealth();
    expect(h.state).toBe("stale");
  });
});
