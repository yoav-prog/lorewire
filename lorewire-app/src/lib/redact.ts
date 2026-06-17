// Recursively replace sensitive values before they reach a log line.
//
// Every observability statement that logs an object runs it through redact()
// first (_plans/2026-06-16-multi-platform-shorts-publisher.md, sections 10/11):
// OAuth access and refresh tokens, Authorization headers, and cookies must
// never appear in logs in cleartext. Key names match case-insensitively, the
// walk descends through nested objects and arrays, and the input is never
// mutated. A sensitive key whose value is itself an object is replaced wholesale
// rather than walked, so nothing inside a token blob leaks.

const DEFAULT_SENSITIVE_KEYS = [
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
] as const;

const PLACEHOLDER = "[REDACTED]";

export function redact<T>(
  value: T,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): T {
  const lower = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const seen = new WeakSet<object>();

  function walk(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[Circular]";
    seen.add(v as object);

    if (Array.isArray(v)) return v.map(walk);

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = lower.has(k.toLowerCase()) ? PLACEHOLDER : walk(val);
    }
    return out;
  }

  return walk(value) as T;
}
