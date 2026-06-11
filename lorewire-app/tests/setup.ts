// Vitest setup. Runs once per process (we pin a single fork in vitest.config
// so the lazy DB handle in `src/lib/db.ts` is consistent across files). We
// redirect the SQLite path to a per-process temp file BEFORE any module under
// test imports `src/lib/db.ts`, so the real pipeline DB at ../pipeline/lorewire.db
// is never touched in tests. The same temp file is reused across tests so
// suites can share fixtures within a run; we don't auto-clean it because the
// OS temp dir handles its own cleanup and we want crash logs to be inspectable.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const baseDir = path.join(os.tmpdir(), "lorewire-tests");
fs.mkdirSync(baseDir, { recursive: true });
// Unique per process. Vitest may shard but our config forces single-fork, so
// in practice we get one DB per run; the pid suffix protects us if the user
// later flips that off.
const dbFile = path.join(baseDir, `articles-${process.pid}.db`);
// Wipe any prior file from a previous run so suites start from a clean slate.
try {
  fs.unlinkSync(dbFile);
} catch {
  // already gone — fine
}

process.env.PIPELINE_DB = dbFile;
// Some modules import session.ts at module-resolution time and crash if
// SESSION_SECRET is unset. Tests never call into auth here, but the safe
// default keeps the import graph happy.
process.env.SESSION_SECRET ??= "test-session-secret";
// `DATABASE_URL` MUST be unset so db.ts takes the SQLite branch.
delete process.env.DATABASE_URL;

console.info("[articles tests setup]", { dbFile, pid: process.pid });
