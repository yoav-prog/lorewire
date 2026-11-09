// Guards the security-header block in next.config.ts. These headers are
// the only hardening layer beyond Vercel's edge HSTS; a refactor that
// drops or typos one would silently weaken production, so the exact
// key/value pairs are pinned here.

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function loadHeaderRules(): Promise<HeaderRule[]> {
  if (!nextConfig.headers) throw new Error("next.config.ts no longer defines headers()");
  return (await nextConfig.headers()) as HeaderRule[];
}

function headerMap(rule: HeaderRule): Record<string, string> {
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
}

describe("next.config.ts headers()", () => {
  it("serves the baseline security headers on every route", async () => {
    const rules = await loadHeaderRules();
    const catchAll = rules.find((r) => r.source === "/:path*");
    expect(catchAll).toBeDefined();
    expect(headerMap(catchAll!)).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("does not set HSTS (Vercel serves it at the edge)", async () => {
    const rules = await loadHeaderRules();
    for (const rule of rules) {
      expect(Object.keys(headerMap(rule))).not.toContain("Strict-Transport-Security");
    }
  });

  it("keeps the service-worker cache headers intact", async () => {
    const rules = await loadHeaderRules();
    const sw = rules.find((r) => r.source === "/sw.js");
    expect(sw).toBeDefined();
    expect(headerMap(sw!)).toEqual({
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Service-Worker-Allowed": "/",
    });
  });

  it("keeps the manifest cache header intact", async () => {
    const rules = await loadHeaderRules();
    const manifest = rules.find((r) => r.source === "/manifest.webmanifest");
    expect(manifest).toBeDefined();
    expect(headerMap(manifest!)).toEqual({
      "Cache-Control": "public, max-age=0, must-revalidate",
    });
  });
});
