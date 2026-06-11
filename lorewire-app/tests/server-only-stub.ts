// Empty stand-in for the `server-only` package during Vitest runs. The real
// module throws at import time when loaded from a non-server context — that
// guard is correct in production (it stops `src/lib/*` from leaking into
// client bundles) and wrong in tests, where we want to execute the same
// repo code on plain Node. `vitest.config.ts` aliases `server-only` here.
export {};
