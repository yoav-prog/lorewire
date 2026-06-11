// Per-type payload schemas for the articles CMS.
//
// `articles.payload` is a TEXT column holding a JSON blob. Its shape depends
// on `articles.type` — news has a dateline, listicle has items[], review has
// a rating + verdict + pros/cons. We keep the shapes here (one source of
// truth) so:
//   - the type-specific sidebar can render the right form
//   - the save action can validate before write
//   - the reader can parse safely with a Zod fallback
//
// Each schema defaults every field, so an empty `{}` parses into a usable
// shape and a freshly-created article can render its sidebar without
// special-casing "no payload yet".

import { z } from "zod";
import type { ArticleType } from "@/lib/repo";

// Hard caps so an editor mishap can't insert megabytes of free-form text
// into payload. Generous enough for real editorial copy.
const SHORT_TEXT = z.string().trim().max(200).default("");
const MEDIUM_TEXT = z.string().trim().max(2000).default("");
const URL_FIELD = z
  .string()
  .trim()
  .max(2000)
  .default("")
  .refine((v) => v === "" || /^https?:\/\//.test(v), {
    message: "URL must start with http:// or https://",
  });

// --- news ------------------------------------------------------------------
// Dateline = the journalist's "LONDON, June 11 —" header. We split it into a
// location and a date string so the reader can format consistently across
// languages (Hebrew dates render right-to-left; an English-formatted string
// would look wrong inline). source_url surfaces a "via" link in the reader.

export const NewsPayloadSchema = z.object({
  datelineLocation: SHORT_TEXT,
  datelineDate: SHORT_TEXT,
  sourceUrl: URL_FIELD,
  sourceLabel: SHORT_TEXT,
});
export type NewsPayload = z.infer<typeof NewsPayloadSchema>;

// --- feature ---------------------------------------------------------------
// Long-form articles already use the top-level columns (subtitle, hero_image,
// summary) and the Tiptap document for sections. The payload here is just
// reading-time hints and the author byline. No load-bearing fields.

export const FeaturePayloadSchema = z.object({
  authorByline: SHORT_TEXT,
  readingTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(0)
    .or(z.string().transform((s) => Number(s) || 0)),
});
export type FeaturePayload = z.infer<typeof FeaturePayloadSchema>;

// --- listicle --------------------------------------------------------------
// One numbered entry per item. The body is plain text for now — Phase 3 may
// upgrade individual items to a small Tiptap fragment if writers ask, but
// most listicles are short blurbs that don't justify the editor cost.

export const ListicleItemSchema = z.object({
  rank: z.number().int().min(1).max(999).default(1),
  title: SHORT_TEXT,
  body: MEDIUM_TEXT,
  imageUrl: URL_FIELD,
  imageAlt: SHORT_TEXT,
});
export type ListicleItem = z.infer<typeof ListicleItemSchema>;

export const ListiclePayloadSchema = z.object({
  // Cap at 50 items. Real listicles are 5-25; the cap stops a stray paste
  // from blowing up payload storage.
  items: z.array(ListicleItemSchema).max(50).default([]),
  countdownOrder: z.boolean().default(false),
});
export type ListiclePayload = z.infer<typeof ListiclePayloadSchema>;

// --- review ----------------------------------------------------------------
// Rating is on a 0..10 scale stored to one decimal place. A scale of 5 stars
// can be rendered by dividing by 2 in the reader — keeping the storage at
// 0..10 means switching to a half-star UI later is a CSS change, not a
// migration. Verdict is one sentence. Pros/cons are short bullets.

export const ReviewPayloadSchema = z.object({
  rating: z
    .number()
    .min(0)
    .max(10)
    .default(0)
    .or(z.string().transform((s) => Number(s) || 0)),
  verdict: SHORT_TEXT,
  pros: z.array(SHORT_TEXT).max(20).default([]),
  cons: z.array(SHORT_TEXT).max(20).default([]),
});
export type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

// --- discriminated parse ---------------------------------------------------
// Parses the raw stored JSON string into the right shape for a given article
// type. Tolerant: a totally empty / malformed payload becomes a defaulted
// instance of the type's schema (so a fresh article renders its sidebar
// without nullable checks everywhere). Invalid shape that doesn't fit ANY
// schema bubbles the error so callers can surface it.

export type ArticlePayload =
  | { type: "news"; payload: NewsPayload }
  | { type: "feature"; payload: FeaturePayload }
  | { type: "listicle"; payload: ListiclePayload }
  | { type: "review"; payload: ReviewPayload };

export function parseArticlePayload(
  type: ArticleType,
  raw: string | null | undefined,
): ArticlePayload {
  let json: unknown = {};
  if (raw && raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = {};
    }
  }
  if (!json || typeof json !== "object") json = {};
  switch (type) {
    case "news":
      return { type, payload: NewsPayloadSchema.parse(json) };
    case "feature":
      return { type, payload: FeaturePayloadSchema.parse(json) };
    case "listicle":
      return { type, payload: ListiclePayloadSchema.parse(json) };
    case "review":
      return { type, payload: ReviewPayloadSchema.parse(json) };
  }
}

// Serialize a parsed payload back to the JSON string the DB stores. Pairs
// with parseArticlePayload — round-tripping through these two functions
// drops unknown fields (Zod's strip default) so we don't accumulate garbage
// from old shapes the next time an article is touched.
export function stringifyArticlePayload(payload: ArticlePayload): string {
  return JSON.stringify(payload.payload);
}
