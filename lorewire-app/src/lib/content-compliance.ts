// Blocking compliance checks for CONTENT_POLICY.md, ported from
// pipeline/compliance.py so the publish gate can re-check final text. Change
// both together; pipeline/fixtures/compliance_cases.json runs against both.
//
// Findings can quote the source, so never log their `detail`.

export const VERBATIM_NGRAM = 6;
export const MIN_QUOTE_WORDS = 2;

export type ComplianceCheck = "verbatim" | "quote" | "identifying" | "labeling";

export interface ComplianceFinding {
  check: ComplianceCheck;
  detail: string;
}

export interface ComplianceStory {
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  teleprompter?: string | null;
  narration?: string | null;
  metadata?: string | null;
}

export interface ComplianceSource {
  sourceText: string;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
}

const STORY_FIELDS = [
  "title",
  "summary",
  "body",
  "teleprompter",
  "narration",
  "metadata",
] as const;

const NOT_NAMES = new Set(
  `Monday Tuesday Wednesday Thursday Friday Saturday Sunday
   January February March April May June July August September October
   November December Christmas Easter Thanksgiving Halloween
   Mom Dad Mum Grandma Grandpa Aunt Uncle Sis Bro God English Internet
   Reddit AITA WIBTA TIFU`.split(/\s+/),
);

const LABEL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["says the story is true", /\btrue\s*stor(?:y|ies)\b/i],
  ["names Reddit", /\b(?:sub)?reddit\b/i],
  ["names a subreddit", /(?<![a-z0-9/])r\/[a-z0-9_]{2,}/i],
  ["uses a Reddit term", /\b(?:aita|wibta|tifu)\b/i],
  ["refers to the source post", /\boriginal\s+(?:post(?:er)?|thread)\b/i],
  ["refers to the source poster", /\bOP\b/],
];

const USERNAME_PATTERNS = [
  /(?<![a-z0-9/])u\/[a-z0-9_-]{3,}/gi,
  /(?<![a-z0-9@._-])@[a-z0-9_]{3,}/gi,
];

const QUOTED = /["“]([^"“”\n]{2,300})["”]/g;
const CAPITALIZED = /(?<![\p{L}\p{N}_])[A-Z][a-z]{2,}(?![\p{L}\p{N}_])/gu;
const SENTENCE_START_BEFORE = new Set([".", "!", "?", ":", '"', "'", "“", "”", "‘", "’"]);

function tokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function ngrams(words: readonly string[], n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    grams.add(words.slice(i, i + n).join(" "));
  }
  return grams;
}

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  return ngrams(haystack, needle.length).has(needle.join(" "));
}

function sourceProperNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(CAPITALIZED)) {
    const word = match[0];
    if (NOT_NAMES.has(word)) continue;
    const before = source.slice(0, match.index);
    const stripped = before.trimEnd();
    if (!stripped || SENTENCE_START_BEFORE.has(stripped[stripped.length - 1])) continue;
    if (before.slice(stripped.length).includes("\n")) continue;
    names.add(word);
  }
  return [...names].sort();
}

function hasWholeWord(value: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, "u").test(value);
}

export function checkCompliance(
  story: ComplianceStory,
  { sourceText, sourceTitle, sourceUrl }: ComplianceSource,
): ComplianceFinding[] {
  const source = sourceTitle ? `${sourceTitle}\n${sourceText}` : sourceText;
  const fields = STORY_FIELDS.flatMap((name) => {
    const value = story[name];
    return typeof value === "string" && value.trim() ? [{ name, value }] : [];
  });
  const findings: ComplianceFinding[] = [];

  const sourceGrams = ngrams(tokens(source), VERBATIM_NGRAM);
  for (const { name, value } of fields) {
    for (const gram of ngrams(tokens(value), VERBATIM_NGRAM)) {
      if (sourceGrams.has(gram)) {
        findings.push({ check: "verbatim", detail: `${name}: shares "${gram}"` });
      }
    }
  }

  for (const match of source.matchAll(QUOTED)) {
    const quote = tokens(match[1]);
    if (quote.length < MIN_QUOTE_WORDS) continue;
    for (const { name, value } of fields) {
      if (containsSequence(tokens(value), quote)) {
        findings.push({ check: "quote", detail: `${name}: repeats quote "${quote.join(" ")}"` });
      }
    }
  }

  for (const { name, value } of fields) {
    for (const pattern of USERNAME_PATTERNS) {
      for (const match of value.matchAll(pattern)) {
        findings.push({ check: "identifying", detail: `${name}: username ${match[0]}` });
      }
    }
  }
  for (const proper of sourceProperNames(source)) {
    for (const { name, value } of fields) {
      const variants = name === "title" ? [proper, proper.toUpperCase()] : [proper];
      if (variants.some((v) => hasWholeWord(value, v))) {
        findings.push({ check: "identifying", detail: `${name}: uses source name "${proper}"` });
      }
    }
  }

  const url = (sourceUrl ?? "").trim().toLowerCase();
  for (const { name, value } of fields) {
    for (const [reason, pattern] of LABEL_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({ check: "labeling", detail: `${name}: ${reason}` });
      }
    }
    if (url && value.toLowerCase().includes(url)) {
      findings.push({ check: "labeling", detail: `${name}: contains the source URL` });
    }
  }

  return findings;
}
