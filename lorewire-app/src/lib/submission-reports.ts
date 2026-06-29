// Victim reports for published user submissions (Phase 4). The "this is about me"
// path for someone who recognises themselves in a published submission story. They
// have no account, so the write path is unauthenticated; abuse is bounded by an
// origin gate (in the route) plus a DB-backed hourly cap per reporter bucket here.
// An admin reviews open reports and either takes the story down or dismisses.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 4).

import "server-only";
import { randomUUID } from "node:crypto";

import { all, one, run } from "@/lib/db";

export interface SubmissionReportRow {
  id: string;
  story_id: string | null;
  submission_id: string | null;
  reason: string | null;
  status: string;
  created_at: string;
}

const REPORT_COLS =
  "id, story_id, submission_id, reason, status, created_at";

const MIN_REASON = 3;
const MAX_REASON = 1000;
const MAX_PER_HOUR_PER_HASH = 10;
const HOUR_MS = 60 * 60 * 1000;

export interface CreateReportInput {
  storyId: string;
  reason: string;
  ipUaHash: string;
  now?: number;
}

/** Record a report against a published submission-origin story. Returns a
 *  user-safe error when the target is wrong or the reporter's hourly cap is hit;
 *  never reveals whether the story exists beyond "isn't available". */
export async function createSubmissionReport(
  input: CreateReportInput,
): Promise<{ ok: boolean; error?: string }> {
  const reason = input.reason.trim().slice(0, MAX_REASON);
  if (reason.length < MIN_REASON) {
    return { ok: false, error: "Tell us a bit about the problem." };
  }

  // Target must be a submission-origin story (Reddit stories aren't reportable
  // through this path).
  const story = await one<{ submission_id: string | null }>(
    `SELECT submission_id FROM stories WHERE id = ?`,
    [input.storyId],
  );
  if (!story || !story.submission_id) {
    return { ok: false, error: "That story isn't available." };
  }

  const now = input.now ?? Date.now();
  const since = new Date(now - HOUR_MS).toISOString();
  const recent = await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM submission_reports
      WHERE ip_ua_hash = ? AND created_at >= ?`,
    [input.ipUaHash, since],
  );
  if ((recent?.n ?? 0) >= MAX_PER_HOUR_PER_HASH) {
    return { ok: false, error: "You've sent a few reports. Try again later." };
  }

  await run(
    `INSERT INTO submission_reports
       (id, story_id, submission_id, reason, status, ip_ua_hash, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    [
      randomUUID(),
      input.storyId,
      story.submission_id,
      reason,
      input.ipUaHash,
      new Date(now).toISOString(),
    ],
  );
  return { ok: true };
}

/** Open reports for the admin queue, oldest first. */
export async function listOpenSubmissionReports(
  limit = 200,
): Promise<SubmissionReportRow[]> {
  return all<SubmissionReportRow>(
    `SELECT ${REPORT_COLS} FROM submission_reports
      WHERE status = 'open' ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
}

/** Resolve every open report on a story at once (when the admin acts on it). */
export async function resolveReportsForStory(
  storyId: string,
  status: "actioned" | "dismissed",
): Promise<void> {
  await run(
    `UPDATE submission_reports SET status = ?
      WHERE story_id = ? AND status = 'open'`,
    [status, storyId],
  );
}
