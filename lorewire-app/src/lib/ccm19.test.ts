// deriveConsentFromCcm coverage: every branch of the CCM19 → lw_consent
// mapping. The function is the safety-critical core of the bridge — a
// wrong branch here either loads analytics without consent or wipes a
// user's saved stories on a phantom reject.

import { describe, expect, it } from "vitest";
import { deriveConsentFromCcm, type CcmApi } from "./ccm19";

const EMBEDDING = "Analytics & device personalization";

describe("deriveConsentFromCcm", () => {
  it("returns null when the CCM19 script never loaded", () => {
    expect(deriveConsentFromCcm(undefined, EMBEDDING)).toBeNull();
  });

  it("returns null while the visitor hasn't saved a choice yet", () => {
    expect(deriveConsentFromCcm({ consent: false }, EMBEDDING)).toBeNull();
    expect(deriveConsentFromCcm({}, EMBEDDING)).toBeNull();
  });

  it("accepts when the visitor accepted everything", () => {
    const ccm: CcmApi = { consent: true, fullConsentGiven: true };
    expect(deriveConsentFromCcm(ccm, EMBEDDING)).toBe("accepted");
    // Even with no embedding name configured.
    expect(deriveConsentFromCcm(ccm, "")).toBe("accepted");
  });

  it("accepts when the named embedding was accepted (case-insensitive)", () => {
    const ccm: CcmApi = {
      consent: true,
      fullConsentGiven: false,
      acceptedEmbeddings: [
        { name: "Something else" },
        { name: "analytics & DEVICE personalization" },
      ],
    };
    expect(deriveConsentFromCcm(ccm, EMBEDDING)).toBe("accepted");
  });

  it("rejects when a choice was saved without our embedding", () => {
    const ccm: CcmApi = {
      consent: true,
      fullConsentGiven: false,
      acceptedEmbeddings: [{ name: "Something else" }],
    };
    expect(deriveConsentFromCcm(ccm, EMBEDDING)).toBe("rejected");
  });

  it("rejects when a choice was saved and acceptedEmbeddings is absent", () => {
    const ccm: CcmApi = { consent: true, fullConsentGiven: false };
    expect(deriveConsentFromCcm(ccm, EMBEDDING)).toBe("rejected");
  });

  it("rejects instead of accepting when no embedding name is configured", () => {
    // Without a configured name, only fullConsentGiven can accept —
    // a partial accept must not be misread as consent to analytics.
    const ccm: CcmApi = {
      consent: true,
      fullConsentGiven: false,
      acceptedEmbeddings: [{ name: "Anything" }],
    };
    expect(deriveConsentFromCcm(ccm, "")).toBe("rejected");
  });

  it("survives malformed embedding entries", () => {
    const ccm: CcmApi = {
      consent: true,
      fullConsentGiven: false,
      acceptedEmbeddings: [{}, { name: undefined }],
    };
    expect(deriveConsentFromCcm(ccm, EMBEDDING)).toBe("rejected");
  });
});
