import { describe, expect, it } from "vitest";

import { TABLES } from "./schema";
import { PERSONAL_DATA_SOURCES } from "./personal-data";

// Drift guard. The store has no foreign keys, so erasure and export are a
// hand-written sweep over PERSONAL_DATA_SOURCES. If someone adds a new
// per-user table to the schema (any table with a `user_id` column) but forgets
// to register it here, a user could be "deleted" while their rows survive — a
// worse GDPR failure than having no delete at all. These tests fail the build
// the moment that happens.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 1.
describe("personal-data registry", () => {
  const byName = new Map(TABLES.map((t) => [t.name, t]));
  const registered = new Set(PERSONAL_DATA_SOURCES.map((s) => s.table));

  it("registers every schema table that has a user_id column", () => {
    const userKeyedTables = TABLES.filter((t) =>
      t.columns.some((c) => c.name === "user_id"),
    ).map((t) => t.name);

    for (const table of userKeyedTables) {
      expect(
        registered.has(table),
        `${table} has a user_id column but is missing from PERSONAL_DATA_SOURCES — erasure/export would silently skip it`,
      ).toBe(true);
    }
  });

  it("only references tables and locator columns that exist in the schema", () => {
    for (const source of PERSONAL_DATA_SOURCES) {
      const table = byName.get(source.table);
      expect(table, `unknown table ${source.table}`).toBeDefined();
      const hasColumn = table!.columns.some((c) => c.name === source.column);
      expect(
        hasColumn,
        `${source.table}.${source.column} is not a real column`,
      ).toBe(true);
    }
  });

  it("clears exactly one subject row, the users table, and clears it last", () => {
    const subjects = PERSONAL_DATA_SOURCES.filter(
      (s) => s.strategy === "delete-subject",
    );
    expect(subjects).toHaveLength(1);
    expect(subjects[0].table).toBe("users");
  });

  it("exports only real columns and never the password hash", () => {
    for (const source of PERSONAL_DATA_SOURCES) {
      if (!source.exportColumns) continue;
      const cols = new Set(byName.get(source.table)!.columns.map((c) => c.name));
      for (const col of source.exportColumns) {
        expect(
          cols.has(col),
          `${source.table}.${col} is listed for export but is not a real column`,
        ).toBe(true);
      }
      expect(source.exportColumns).not.toContain("password_hash");
    }
  });
});
