// Publish-time originality gate (CONTENT_POLICY.md). Re-runs the blocking checks
// against the story's FINAL text, including admin edits, the short's narration
// and social metadata. Only clean-room stories (content_origin='original') are
// checked; older stories and reader submissions are out of scope by design.
//
// Fails closed: a clean-room story with no source record reports a finding.
// Findings can quote the source, so callers log check names only.

import "server-only";
import { all, one } from "@/lib/db";
import {
  checkCompliance,
  type ComplianceFinding,
  type ComplianceStory,
} from "@/lib/content-compliance";

const MISSING_SOURCE: ComplianceFinding = {
  check: "labeling",
  detail: "source record is missing, so originality cannot be verified",
};

interface GateRow {
  id: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  teleprompter: string | null;
  short_config: string | null;
  seo_metadata_json: string | null;
  source_title: string | null;
  source_text: string | null;
  source_url: string | null;
}

function narrationFrom(shortConfig: string | null): string | null {
  if (!shortConfig) return null;
  try {
    const script = (JSON.parse(shortConfig) as { script?: unknown }).script;
    return typeof script === "string" ? script : null;
  } catch {
    return null;
  }
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectStrings(v, out));
  }
}

function metadataText(seoJson: string | null): string | null {
  if (!seoJson) return null;
  try {
    const strings: string[] = [];
    collectStrings(JSON.parse(seoJson), strings);
    return strings.join("\n");
  } catch {
    return null;
  }
}

function findingsFor(row: GateRow): ComplianceFinding[] {
  if (!row.source_text) return [MISSING_SOURCE];
  const story: ComplianceStory = {
    title: row.title,
    summary: row.summary,
    body: row.body,
    teleprompter: row.teleprompter,
    narration: narrationFrom(row.short_config),
    metadata: metadataText(row.seo_metadata_json),
  };
  return checkCompliance(story, {
    sourceText: row.source_text,
    sourceTitle: row.source_title,
    sourceUrl: row.source_url,
  });
}

/** Blocking findings per story. Ids with none are absent from the map. */
export async function originalityBlockers(
  storyIds: readonly string[],
): Promise<Map<string, ComplianceFinding[]>> {
  const out = new Map<string, ComplianceFinding[]>();
  if (storyIds.length === 0) return out;
  const placeholders = storyIds.map(() => "?").join(", ");
  const rows = await all<GateRow>(
    `SELECT s.id, s.title, s.summary, s.body, s.teleprompter, s.short_config,
            s.seo_metadata_json, ss.source_title, ss.source_text, ss.source_url
     FROM stories s
     LEFT JOIN story_sources ss ON ss.story_id = s.id
     WHERE s.content_origin = 'original' AND s.id IN (${placeholders})`,
    [...storyIds],
  );
  for (const row of rows) {
    const findings = findingsFor(row);
    if (findings.length > 0) out.set(row.id, findings);
  }
  return out;
}

export interface StoredFinding {
  check: string;
  severity: string;
  detail: string;
}

export interface StoryOriginality {
  premise: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  /** Live result against the current text. */
  blockers: ComplianceFinding[];
  /** Paraphrase, structure and product flags from generation. */
  advisory: StoredFinding[];
  semanticChecksRan: boolean;
}

/** Admin-only view of a clean-room story. Null for any other story. */
export async function getStoryOriginality(
  storyId: string,
): Promise<StoryOriginality | null> {
  const origin = await one<{ content_origin: string | null }>(
    "SELECT content_origin FROM stories WHERE id = ?",
    [storyId],
  );
  if (origin?.content_origin !== "original") return null;
  const source = await one<{
    premise: string | null;
    source_title: string | null;
    source_url: string | null;
    compliance_report: string | null;
  }>(
    "SELECT premise, source_title, source_url, compliance_report FROM story_sources WHERE story_id = ?",
    [storyId],
  );
  const blockers = (await originalityBlockers([storyId])).get(storyId) ?? [];
  let advisory: StoredFinding[] = [];
  let semanticChecksRan = false;
  try {
    const report = JSON.parse(source?.compliance_report ?? "{}") as {
      findings?: StoredFinding[];
      semantic_checks_ran?: boolean;
    };
    advisory = (report.findings ?? []).filter((f) => f.severity === "advisory");
    semanticChecksRan = report.semantic_checks_ran === true;
  } catch {
    advisory = [];
  }
  return {
    premise: source?.premise ?? null,
    sourceTitle: source?.source_title ?? null,
    sourceUrl: source?.source_url ?? null,
    blockers,
    advisory,
    semanticChecksRan,
  };
}
