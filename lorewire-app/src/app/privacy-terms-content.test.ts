// Guards against the three production-blocking TODOs in /privacy and /terms
// being re-introduced. The history (audit on 2026-06-30) had:
//
//   - CONTACT_EMAIL = "info@lorewire.com"  (wrong domain)
//   - LEGAL_ENTITY  = "Flexelent (operator of LoreWire)"  (wrong operator)
//   - GOVERNING_LAW = "the State of Israel"  (TODO unconfirmed)
//
// The fix sets CONTACT_EMAIL to "contact@lorewire.com" and LEGAL_ENTITY to
// "LoreWire". Governing law stays as Israel for now but the TODO is
// removed. These tests fail if anyone re-introduces the wrong strings,
// because the source file is read directly off disk and the assertions
// scan for the offending text.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PRIVACY_PATH = resolve(__dirname, "privacy/page.tsx");
const TERMS_PATH = resolve(__dirname, "terms/page.tsx");

async function loadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("privacy/page.tsx — production TODOs are resolved", () => {
  it("uses contact@lorewire.com as the contact email", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).toContain('CONTACT_EMAIL = "contact@lorewire.com"');
  });

  it("no longer references the old info@lorewire.com address", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).not.toContain("info@lorewire.com");
  });

  it("uses LoreWire as the legal entity", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).toContain('LEGAL_ENTITY = "LoreWire"');
  });

  it("no longer references Flexelent as the operator", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).not.toContain("Flexelent");
  });

  it("discloses Google Analytics 4 as a third-party data flow", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).toContain("Google Analytics 4");
  });

  it("discloses Sentry as a third-party data flow", async () => {
    const src = await loadFile(PRIVACY_PATH);
    expect(src).toContain("Sentry");
  });
});

describe("terms/page.tsx — production TODOs are resolved", () => {
  it("uses contact@lorewire.com as the contact email", async () => {
    const src = await loadFile(TERMS_PATH);
    expect(src).toContain('CONTACT_EMAIL = "contact@lorewire.com"');
  });

  it("no longer references the old info@lorewire.com address", async () => {
    const src = await loadFile(TERMS_PATH);
    expect(src).not.toContain("info@lorewire.com");
  });

  it("uses LoreWire as the legal entity", async () => {
    const src = await loadFile(TERMS_PATH);
    expect(src).toContain('LEGAL_ENTITY = "LoreWire"');
  });

  it("no longer references Flexelent as the operator", async () => {
    const src = await loadFile(TERMS_PATH);
    expect(src).not.toContain("Flexelent");
  });

  it("no longer carries the unresolved governing law TODO", async () => {
    const src = await loadFile(TERMS_PATH);
    expect(src).not.toContain("TODO Yoav: confirm — Israel courts");
  });
});
