// Single source of truth for the FAQ page: the visible sections AND the
// FAQPage JSON-LD both render from this array, so the schema can never
// drift from the copy (_plans/2026-07-05-seo-structured-data.md).
//
// answerHtml is trusted, hardcoded repo content — never user input. It
// may contain <p> and <a> tags; Google accepts limited HTML (including
// links) inside acceptedAnswer.text, and the page renders the same
// string, so what the crawler reads is exactly what the visitor sees.
// Lives beside the page (not in lib/) because it IS the page's copy.

import { maybe, serializeJsonLd } from "@/lib/jsonld";

export const FAQ_CONTACT_EMAIL = "contact@lorewire.com";

const A = 'class="text-accent underline"';

export interface FaqItem {
  question: string;
  answerHtml: string;
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: "What is LoreWire?",
    answerHtml:
      "<p>LoreWire is a publishing tool for short illustrated stories and the poll debates around them. Stories are written, narrated, and rendered inside LoreWire and published on the site and on connected social accounts.</p>",
  },
  {
    question: "Is LoreWire free?",
    answerHtml:
      "<p>Reading LoreWire is free. There are no ads on the site and no paywall. We may introduce paid creator features later, but everything on the public reader side stays free.</p>",
  },
  {
    question: "Do I need an account to read?",
    answerHtml:
      "<p>No. You can read every story, watch every short, and vote in every poll without signing in. Saving stories and remembering your reading position works on your device without an account too. Signing in is only required if you want your library to follow you across devices.</p>",
  },
  {
    question: "Are the stories real?",
    answerHtml:
      "<p>The stories are inspired by real situations posted on public internet forums. They are rewritten, narrated, and illustrated before publishing. Identifying details are changed. Treat them as stories, not as journalism.</p>",
  },
  {
    question: "Who writes them?",
    answerHtml: `<p>LoreWire uses a mix of human editing and AI generation for narration, illustration, and captions. Every published piece is reviewed before it goes out. See our <a ${A} href="/community-guidelines">Community Guidelines</a> for what we allow and what we won't publish.</p>`,
  },
  {
    question: "How do polls work?",
    answerHtml:
      "<p>Each story comes with a yes/no question. You can vote without an account; the site uses a small cookie to remember that this browser has voted, so it won't count you twice. Your individual vote is not shown to other readers — only the running totals are.</p>",
  },
  {
    question: "Why do I see a cookie banner?",
    answerHtml: `<p>To ask your permission before we save your activity on this device. If you accept, we remember your saved stories, your reading position, and we load analytics so we can see how the site is being used. If you reject, none of that runs and we clear anything we had saved on this device. You can change your mind anytime from the "Manage cookies" link in the footer.</p><p>See the <a ${A} href="/cookie-policy">Cookie Policy</a> for the full list.</p>`,
  },
  {
    question: "How do I delete my data?",
    answerHtml: `<p>Signed-in users can delete their account from the account page; everything tied to it is removed. Anonymous users can press Reject on the cookie banner to clear local data on this device. Full details are in the <a ${A} href="/privacy#data-deletion">Privacy Policy</a>.</p>`,
  },
  {
    question: "Is LoreWire accessible?",
    answerHtml: `<p>We aim for WCAG 2.1 AA. See our <a ${A} href="/accessibility">Accessibility statement</a> for the current state and how to report a problem.</p>`,
  },
  {
    question: "I have a question that isn't here.",
    answerHtml: `<p>Email <a ${A} href="mailto:${FAQ_CONTACT_EMAIL}">${FAQ_CONTACT_EMAIL}</a> or use the <a ${A} href="/contact">Contact</a> page.</p>`,
  },
];

// FAQPage schema over the same items the page renders.
export function buildFaqJsonLd(items: FaqItem[]): Record<string, unknown> {
  return maybe({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answerHtml },
    })),
  });
}

export function faqJsonLdScript(items: FaqItem[]): string {
  return serializeJsonLd([buildFaqJsonLd(items)]);
}
