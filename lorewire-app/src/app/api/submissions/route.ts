// POST /api/submissions — create or edit a user's own story + dilemma submission.
//
// Authenticated by the lw_user JWT cookie (a suspended account is treated as
// signed out). Body: { id?, action: 'submit' | 'draft', title, body, question,
// optionA, optionB, lang }. With an `id` it edits that draft/rejected submission;
// without one it creates a new one. Validation + the per-user cap live in
// lib/submissions.ts and surface as SubmissionError (kind 'invalid' -> 400,
// 'cap' -> 429). Phase 1: a submit lands in 'pending_review'; nothing renders.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 1).

import { NextResponse, type NextRequest } from "next/server";

import { readActiveUserSession } from "@/lib/member-session";
import { screenSubmission } from "@/lib/submission-moderation";
import {
  createSubmission,
  parseSubmissionInput,
  SubmissionError,
  updateSubmission,
} from "@/lib/submissions";

function isAllowedOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  const expected = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim() ?? "";
  if (expected) return origin === expected.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") {
    return (
      /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    );
  }
  return false;
}

interface SubmissionBody {
  id?: unknown;
  action?: unknown;
  title?: unknown;
  body?: unknown;
  question?: unknown;
  optionA?: unknown;
  optionB?: unknown;
  lang?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAllowedOrigin(req)) {
    console.warn("[submissions origin-rejected]", {
      received_origin: req.headers.get("origin"),
      expected_origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? null,
    });
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  // readActiveUserSession (not raw readUserSession): a suspended account is
  // treated as signed out, so it can't submit.
  const session = await readActiveUserSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let raw: SubmissionBody;
  try {
    raw = (await req.json()) as SubmissionBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = raw.action === "draft" ? "draft" : "submit";
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;

  try {
    const input = parseSubmissionInput(raw);
    let submission = id
      ? await updateSubmission({ id, userId: session.userId, input, action })
      : await createSubmission({ userId: session.userId, input, action });
    // Screen newly-submitted text inline: clear violations auto-reject with a
    // reason, the rest enters the human queue. A draft save doesn't get screened.
    if (action === "submit" && submission.status === "pending_review") {
      const screened = await screenSubmission(submission);
      if (screened) submission = screened;
    }
    return NextResponse.json({
      ok: true,
      submission: { id: submission.id, status: submission.status },
    });
  } catch (err) {
    if (err instanceof SubmissionError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.kind === "cap" ? 429 : 400 },
      );
    }
    console.warn("[submissions write-failed]", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Couldn't save your submission. Try again." },
      { status: 500 },
    );
  }
}
