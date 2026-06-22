// Tier 1 of the comment moderator: OpenAI's free Moderation API
// (omni-moderation-latest). Separate from src/lib/llm.ts because it hits a
// different endpoint (/moderations, not /chat/completions). Same security
// posture as llm.ts: key from env only, errors sanitised to a short string
// that never contains the key, hard timeout.
//
// The free endpoint does not count toward usage limits. It classifies
// TOXICITY only (hate, harassment, violence, sexual, self-harm, illicit) — it
// does NOT detect spam or off-topic, which is why the gpt-5-nano judge in
// comment-moderation.ts carries those. Verified by the Step 0 eval: Tier 1
// alone has weak recall, especially on Hebrew; it is a fast safety net, not
// the gate.

import "server-only";

/** Categories that route to the non-discretionary quarantine path rather than
 *  an ordinary reject: never silently deleted, preserved for the admin. */
export const QUARANTINE_CATEGORIES = [
  "sexual/minors",
  "harassment/threatening",
  "hate/threatening",
  "self-harm/intent",
] as const;

const MODERATION_TIMEOUT_MS = 5000;

export interface ModerationSignals {
  flagged: boolean;
  /** Highest score across all 13 categories. */
  maxTox: number;
  /** Highest score across the quarantine categories. */
  maxQuarantine: number;
  topCategory: string;
  topScore: number;
}

export type ModerationOutcome =
  | ({ ok: true } & ModerationSignals)
  | { ok: false; error: string };

export async function moderateText(text: string): Promise<ModerationOutcome> {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY not configured" };
  const base = (
    process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  try {
    const r = await fetch(`${base}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
      signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
    });
    if (!r.ok) {
      const errBody = (await r.text()).slice(0, 300);
      console.warn("[moderation] non-ok", { status: r.status });
      return { ok: false, error: `moderation ${r.status}: ${errBody}` };
    }
    const data = (await r.json()) as {
      results?: {
        flagged?: boolean;
        category_scores?: Record<string, number>;
      }[];
    };
    const res = data?.results?.[0];
    if (!res || !res.category_scores) {
      return { ok: false, error: "moderation returned no result" };
    }
    const scores = res.category_scores;
    const maxQuarantine = Math.max(
      0,
      ...QUARANTINE_CATEGORIES.map((c) => scores[c] ?? 0),
    );
    let topCategory = "";
    let topScore = -1;
    for (const [c, v] of Object.entries(scores)) {
      const n = Number(v) || 0;
      if (n > topScore) {
        topScore = n;
        topCategory = c;
      }
    }
    return {
      ok: true,
      flagged: !!res.flagged,
      maxTox: Math.max(0, topScore),
      maxQuarantine,
      topCategory,
      topScore: Math.max(0, topScore),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `moderation call failed: ${msg}` };
  }
}
