// Coverage for the FAQ single-source array + FAQPage schema
// (_plans/2026-07-05-seo-structured-data.md). The page and the JSON-LD
// both render from FAQ_ITEMS, so the invariants here protect both.

import { describe, expect, it } from "vitest";

import { FAQ_ITEMS, buildFaqJsonLd, faqJsonLdScript } from "./faq-items";

describe("FAQ_ITEMS", () => {
  it("has items with non-empty questions and answers", () => {
    expect(FAQ_ITEMS.length).toBeGreaterThanOrEqual(5);
    for (const item of FAQ_ITEMS) {
      expect(item.question.trim().length).toBeGreaterThan(0);
      expect(item.answerHtml).toMatch(/^<p[ >]/);
    }
  });

  it("contains no unresolved template placeholders", () => {
    for (const item of FAQ_ITEMS) {
      expect(item.answerHtml).not.toContain("${");
      expect(item.answerHtml).not.toContain("undefined");
    }
  });
});

describe("buildFaqJsonLd", () => {
  it("emits one Question per item with the same copy", () => {
    const schema = buildFaqJsonLd(FAQ_ITEMS);
    expect(schema["@type"]).toBe("FAQPage");
    const entities = schema.mainEntity as Array<{
      "@type": string;
      name: string;
      acceptedAnswer: { "@type": string; text: string };
    }>;
    expect(entities).toHaveLength(FAQ_ITEMS.length);
    entities.forEach((entity, i) => {
      expect(entity["@type"]).toBe("Question");
      expect(entity.name).toBe(FAQ_ITEMS[i].question);
      expect(entity.acceptedAnswer["@type"]).toBe("Answer");
      expect(entity.acceptedAnswer.text).toBe(FAQ_ITEMS[i].answerHtml);
    });
  });

  it("serializes without a raw </script> sequence", () => {
    expect(faqJsonLdScript(FAQ_ITEMS)).not.toContain("</script>");
  });
});
