// Smoke + metadata coverage for the trust / legal pages added in
// _plans/2026-06-30-trust-and-launch-readiness.md.
//
// Each page exports a default React component and a `metadata` object that
// drives the document title, description, and canonical URL for SEO. The
// metadata is what Google AdSense and the platform reviewers see in
// `view-source:` — so a typo or a missing field is a real launch blocker.
// The tests assert each page exports the right shape and exposes the
// trust signals the manager's audit asked for (a real description, a
// canonical, and the page name in the title).

import type { Metadata } from "next";
import { describe, expect, it } from "vitest";

import About, { metadata as aboutMetadata } from "./about/page";
import Accessibility, {
  metadata as accessibilityMetadata,
} from "./accessibility/page";
import CommunityGuidelines, {
  metadata as communityGuidelinesMetadata,
} from "./community-guidelines/page";
import Contact, { metadata as contactMetadata } from "./contact/page";
import CookiePolicy, {
  metadata as cookiePolicyMetadata,
} from "./cookie-policy/page";
import Dmca, { metadata as dmcaMetadata } from "./dmca/page";
import Faq, { metadata as faqMetadata } from "./faq/page";

interface Case {
  label: string;
  component: unknown;
  metadata: Metadata;
  expectedTitle: string;
  expectedCanonical: string;
}

const CASES: Case[] = [
  {
    label: "FAQ",
    component: Faq,
    metadata: faqMetadata,
    expectedTitle: "Frequently Asked Questions",
    expectedCanonical: "/faq",
  },
  {
    label: "Contact",
    component: Contact,
    metadata: contactMetadata,
    expectedTitle: "Contact",
    expectedCanonical: "/contact",
  },
  {
    label: "About",
    component: About,
    metadata: aboutMetadata,
    expectedTitle: "About LoreWire",
    expectedCanonical: "/about",
  },
  {
    label: "Cookie Policy",
    component: CookiePolicy,
    metadata: cookiePolicyMetadata,
    expectedTitle: "Cookie Policy",
    expectedCanonical: "/cookie-policy",
  },
  {
    label: "Community Guidelines",
    component: CommunityGuidelines,
    metadata: communityGuidelinesMetadata,
    expectedTitle: "Community Guidelines",
    expectedCanonical: "/community-guidelines",
  },
  {
    label: "Accessibility",
    component: Accessibility,
    metadata: accessibilityMetadata,
    expectedTitle: "Accessibility",
    expectedCanonical: "/accessibility",
  },
  {
    label: "DMCA",
    component: Dmca,
    metadata: dmcaMetadata,
    expectedTitle: "DMCA / Takedown",
    expectedCanonical: "/dmca",
  },
];

describe("trust pages — metadata exports", () => {
  for (const c of CASES) {
    describe(c.label, () => {
      it("exports a callable default component", () => {
        expect(typeof c.component).toBe("function");
      });
      it("exports a metadata title that matches the page heading", () => {
        expect(c.metadata.title).toBe(c.expectedTitle);
      });
      it("exports a non-empty description for SEO + AdSense", () => {
        const desc = c.metadata.description;
        expect(typeof desc).toBe("string");
        expect((desc as string).length).toBeGreaterThan(30);
      });
      it("sets the canonical alternate to its own route", () => {
        const canonical = c.metadata.alternates?.canonical;
        expect(canonical).toBe(c.expectedCanonical);
      });
    });
  }
});
