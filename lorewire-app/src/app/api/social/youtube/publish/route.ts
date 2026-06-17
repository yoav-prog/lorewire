// POST /api/social/youtube/publish
//
// Publish a finished short to the connected YouTube channel. Body: { renderId }.
// Flow: require admin -> resolve the done render + its story -> resolve the
// active YouTube account -> idempotency guard -> audio-clearance gate (F9) ->
// build + validate metadata -> insert an in_flight ledger row -> get a valid
// access token -> stream the MP4 into the resumable videos.insert -> flip the
// row to published (or failed). Plan sections 5, 7.1, 8, 9, 11.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/dal";
import { getShortRender } from "@/lib/short-render-queue";
import { getStory } from "@/lib/repo";
import { getActiveSocialAccount } from "@/lib/social-accounts";
import { audioClearanceGate } from "@/lib/social-publish";
import {
  buildVideosInsertBody,
  buildYoutubeShortUrl,
  mapStoryToYoutubePayload,
  validateYoutubePayload,
} from "@/lib/youtube-publish";
import {
  getValidYoutubeAccessToken,
  uploadShortToYoutube,
} from "@/lib/youtube-upload";
import {
  getActiveYoutubePublishForShort,
  insertInFlightYoutubePublish,
  markYoutubePublishFailed,
  markYoutubePublished,
} from "@/lib/youtube-publishes";

// The resumable upload streams an MP4 to YouTube; give it the room the plan
// budgets (section 5). 300s is ample for a 60s short at 30-80 MB.
export const maxDuration = 300;

interface PublishRequestBody {
  renderId?: unknown;
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await requireAdmin();

  let payload: PublishRequestBody;
  try {
    payload = (await req.json()) as PublishRequestBody;
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  const renderId = payload.renderId;
  if (typeof renderId !== "string" || !renderId) {
    return NextResponse.json({ error: "missing-renderId" }, { status: 400 });
  }

  const render = await getShortRender(renderId);
  if (!render) {
    return NextResponse.json({ error: "short-not-found" }, { status: 404 });
  }
  if (render.status !== "done" || !render.output_url) {
    return NextResponse.json({ error: "short-not-ready" }, { status: 409 });
  }

  const account = await getActiveSocialAccount("youtube");
  if (!account) {
    return NextResponse.json({ error: "not-connected" }, { status: 409 });
  }

  // Idempotency: never double-publish a short. A finished publish returns its
  // URL; one in flight is reported as in-progress. Failed rows do not block a
  // retry. The fully race-proof guarantee arrives with the Phase 2 queue.
  const active = await getActiveYoutubePublishForShort(renderId);
  if (active?.status === "published") {
    return NextResponse.json({
      status: "published",
      alreadyPublished: true,
      publicUrl: active.public_url,
    });
  }
  if (active?.status === "in_flight") {
    return NextResponse.json({ error: "in-progress" }, { status: 409 });
  }

  // Audio clearance (F9). A Lorewire short's audio is its synthesized
  // voiceover, so the provenance is 'tts'. The gate still runs so an unknown
  // source can never slip through, and the verdict is recorded on the row.
  const audio = audioClearanceGate({ source: "tts", platform: "youtube" });
  console.info("[social publish audio-check]", {
    renderId,
    clearance: audio.verdict,
    allowed: audio.allowed,
  });
  if (!audio.allowed) {
    return NextResponse.json(
      { error: "audio-blocked", reason: audio.reason },
      { status: 422 },
    );
  }

  // Build + validate the metadata from the story.
  const story = await getStory(render.story_id);
  const ytPayload = mapStoryToYoutubePayload({
    storyTitle: story?.title ?? "Lorewire short",
    storySummary: story?.summary,
    category: story?.category,
  });
  const validation = validateYoutubePayload(ytPayload);
  if (!validation.ok) {
    return NextResponse.json(
      { error: "invalid-metadata", details: validation.errors },
      { status: 400 },
    );
  }

  const publishId = await insertInFlightYoutubePublish({
    shortId: renderId,
    accountId: account.id,
    audioClearance: audio.verdict,
  });
  console.info("[social publish request]", {
    publishId,
    renderId,
    accountId: account.id,
    by: session.userId,
  });

  const accessToken = await getValidYoutubeAccessToken(account);
  if (!accessToken) {
    await markYoutubePublishFailed(
      publishId,
      "token refresh failed; reconnect the account",
    );
    return NextResponse.json({ error: "needs-reauth" }, { status: 409 });
  }

  try {
    console.info("[social publish upload]", {
      publishId,
      sourceUrl: render.output_url,
    });
    const { videoId } = await uploadShortToYoutube({
      accessToken,
      sourceUrl: render.output_url,
      body: buildVideosInsertBody(ytPayload),
    });
    const publicUrl = buildYoutubeShortUrl(videoId);
    await markYoutubePublished(publishId, videoId, publicUrl);
    console.info("[social publish complete]", { publishId, videoId, publicUrl });
    return NextResponse.json({ status: "published", videoId, publicUrl });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await markYoutubePublishFailed(publishId, detail);
    console.error("[social publish fail]", { publishId, renderId, detail });
    return NextResponse.json({ error: "upload-failed", detail }, { status: 502 });
  }
}
