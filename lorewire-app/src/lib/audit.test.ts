// audit() + read-helper coverage. The invariants that matter: (1) a row is
// PII-free — actor/target are stored as 8-hex hashes, never the raw email;
// (2) metadata round-trips; (3) the filters (actor, action, target, free-text)
// select the right rows; (4) reads come back newest-first. Runs against the
// configured DB via all/run, same pattern as account-deletion.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  audit,
  countAuditLog,
  listAuditForTarget,
  listAuditLog,
  parseAuditMetadata,
} from "@/lib/audit";
import { all, run } from "@/lib/db";
import { hashForLog } from "@/lib/users";

const ACTOR = "test_audit_actor_1";
const ACTOR_2 = "test_audit_actor_2";

// Every row written by these tests carries an actor_id under the test_audit_
// namespace, so a single LIKE delete cleans up without touching real rows.
async function cleanup(): Promise<void> {
  await run("DELETE FROM admin_audit_log WHERE actor_id LIKE 'test_audit_%'", []);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("audit() — write path", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("writes a PII-free row: emails are hashed, not stored raw", async () => {
    await audit({
      actorId: ACTOR,
      actorEmail: "alice@staff.test",
      action: "user.suspend",
      targetType: "user",
      targetId: "test_audit_target_a",
      targetEmail: "victim@example.test",
      metadata: { reason: "spam" },
      ip: "203.0.113.7",
    });

    const rows = await all<{
      actor_label: string | null;
      target_label: string | null;
      action: string | null;
      target_type: string | null;
      target_id: string | null;
      ip_hash: string | null;
      created_at: string | null;
    }>("SELECT * FROM admin_audit_log WHERE actor_id = ?", [ACTOR]);

    expect(rows).toHaveLength(1);
    const r = rows[0];
    // Labels are the 8-hex hash of the email — and crucially NOT the raw email.
    expect(r.actor_label).toBe(hashForLog("alice@staff.test"));
    expect(r.target_label).toBe(hashForLog("victim@example.test"));
    expect(r.actor_label).toMatch(/^[0-9a-f]{8}$/);
    expect(r.target_label).toMatch(/^[0-9a-f]{8}$/);
    expect(r.actor_label).not.toContain("alice");
    expect(r.target_label).not.toContain("victim");
    expect(r.ip_hash).toBe(hashForLog("203.0.113.7"));
    expect(r.action).toBe("user.suspend");
    expect(r.target_type).toBe("user");
    expect(r.target_id).toBe("test_audit_target_a");
    expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("round-trips metadata as JSON and tolerates omitted optional fields", async () => {
    await audit({
      actorId: ACTOR,
      action: "user.role_change",
      targetType: "user",
      targetId: "test_audit_target_b",
      metadata: { from: "user", to: "moderator" },
    });

    const [row] = await listAuditLog({ actorId: ACTOR });
    expect(parseAuditMetadata(row)).toEqual({ from: "user", to: "moderator" });
    // Omitted optionals are stored as NULL, not the string "undefined".
    expect(row.actor_label).toBeNull();
    expect(row.target_label).toBeNull();
    expect(row.ip_hash).toBeNull();
  });

  it("returns {} from parseAuditMetadata when metadata is absent", async () => {
    await audit({
      actorId: ACTOR,
      action: "user.delete",
      targetType: "user",
      targetId: "test_audit_target_c",
    });
    const [row] = await listAuditLog({ actorId: ACTOR });
    expect(row.metadata).toBeNull();
    expect(parseAuditMetadata(row)).toEqual({});
  });
});

describe("listAuditLog — filtering + ordering", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns rows newest-first", async () => {
    await audit({ actorId: ACTOR, action: "user.suspend", targetType: "user", targetId: "t" });
    await sleep(8);
    await audit({ actorId: ACTOR, action: "user.unsuspend", targetType: "user", targetId: "t" });
    await sleep(8);
    await audit({ actorId: ACTOR, action: "user.delete", targetType: "user", targetId: "t" });

    const rows = await listAuditLog({ actorId: ACTOR });
    expect(rows.map((r) => r.action)).toEqual([
      "user.delete",
      "user.unsuspend",
      "user.suspend",
    ]);
  });

  it("filters by action, by actor, and by exact target", async () => {
    await audit({ actorId: ACTOR, action: "user.suspend", targetType: "user", targetId: "test_audit_t1" });
    await audit({ actorId: ACTOR, action: "user.delete", targetType: "user", targetId: "test_audit_t2" });
    await audit({ actorId: ACTOR_2, action: "user.suspend", targetType: "user", targetId: "test_audit_t1" });

    expect(await countAuditLog({ action: "user.suspend", targetId: "test_audit_t1" })).toBe(2);
    expect(await countAuditLog({ actorId: ACTOR_2 })).toBe(1);
    const byTarget = await listAuditLog({ targetId: "test_audit_t2" });
    expect(byTarget).toHaveLength(1);
    expect(byTarget[0].action).toBe("user.delete");
  });

  it("free-text q matches the action and the metadata", async () => {
    await audit({
      actorId: ACTOR,
      action: "user.suspend",
      targetType: "user",
      targetId: "test_audit_q1",
      metadata: { reason: "harassment" },
    });
    await audit({
      actorId: ACTOR,
      action: "team.invite_create",
      targetType: "invite",
      targetId: "test_audit_q2",
      metadata: { role: "editor" },
    });

    // matches the action key
    const bySuspend = await listAuditLog({ actorId: ACTOR, q: "suspend" });
    expect(bySuspend).toHaveLength(1);
    expect(bySuspend[0].target_id).toBe("test_audit_q1");

    // matches inside the metadata JSON
    const byReason = await listAuditLog({ actorId: ACTOR, q: "harassment" });
    expect(byReason).toHaveLength(1);
    expect(byReason[0].target_id).toBe("test_audit_q1");

    const byRole = await listAuditLog({ actorId: ACTOR, q: "editor" });
    expect(byRole).toHaveLength(1);
    expect(byRole[0].target_id).toBe("test_audit_q2");
  });

  it("listAuditForTarget returns only that entity's trail", async () => {
    await audit({ actorId: ACTOR, action: "user.suspend", targetType: "user", targetId: "test_audit_x" });
    await audit({ actorId: ACTOR, action: "user.unsuspend", targetType: "user", targetId: "test_audit_x" });
    await audit({ actorId: ACTOR, action: "user.suspend", targetType: "user", targetId: "test_audit_y" });

    const trail = await listAuditForTarget("user", "test_audit_x");
    expect(trail).toHaveLength(2);
    expect(trail.every((r) => r.target_id === "test_audit_x")).toBe(true);
  });

  it("clamps limit and honors offset for pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await audit({ actorId: ACTOR, action: "user.suspend", targetType: "user", targetId: `test_audit_p${i}` });
      await sleep(3);
    }
    const firstTwo = await listAuditLog({ actorId: ACTOR, limit: 2 });
    expect(firstTwo).toHaveLength(2);
    const nextTwo = await listAuditLog({ actorId: ACTOR, limit: 2, offset: 2 });
    expect(nextTwo).toHaveLength(2);
    // Pages don't overlap.
    const firstIds = new Set(firstTwo.map((r) => r.id));
    expect(nextTwo.some((r) => firstIds.has(r.id))).toBe(false);
    // A nonsense limit clamps rather than throwing or returning everything.
    expect((await listAuditLog({ actorId: ACTOR, limit: -3 })).length).toBeLessThanOrEqual(50);
  });
});
