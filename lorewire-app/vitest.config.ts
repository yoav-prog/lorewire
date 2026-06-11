// Minimal Vitest config. The only thing we need beyond Vitest's defaults is
// the `@/*` path alias so test files import from the same paths Next.js does
// — keeps tests honest about the actual import graph the app uses.
//
// Environment is left at Vitest's default (`node`) because everything under
// test today is pure logic (validator, derived defaults, articles repo).
// When we add component tests (Day 5+ UI work), flip the affected files to
// `// @vitest-environment happy-dom` at the top of each test.
//
// `tests/setup.ts` redirects the data layer at a per-run temp SQLite file so
// the articles repo tests do not touch the pipeline's lorewire.db. We run in
// a single fork so the lazy `globalThis.__lwDriver` in `src/lib/db.ts` does
// not race across worker processes.

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Real `server-only` throws at import time when loaded outside a server
      // context — correct for production bundles, wrong for Vitest. The stub
      // is an empty module so repo and DAL code can be imported on plain Node.
      "server-only": path.resolve(__dirname, "./tests/server-only-stub.ts"),
    },
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    // Single-process so the lazy `globalThis.__lwDriver` in `src/lib/db.ts`
    // is shared across test files. Vitest 4 expresses this via
    // `fileParallelism: false`, which internally sets `maxWorkers: 1`.
    fileParallelism: false,
  },
});
