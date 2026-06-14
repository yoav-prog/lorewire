// Per-row review + publish gate.
//
// Two-pane layout: source post (left) so the admin can compare the
// generated story (right) to the original facts. The publish button is
// only enabled when the readiness check passes (body + hero + video +
// source.status='used'); the same check runs server-side in
// publishReviewedStoryAction so a hand-crafted POST can't bypass it.
//
// Five page states map to five distinct surfaces:
//   imported   — never enqueued, link to bulk action
//   queued     — waiting on the worker
//   processing — worker is on it; show progress + link to refresh
//   used       — story exists; render the full review surface
//   skipped    — admin had previously rejected; show reopen control

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import { getStory } from "@/lib/repo";
import {
  evaluatePublishReadiness,
  getRedditSource,
  type RedditSourceRow,
} from "@/lib/reddit-source";
import { getLatestStoryJobForReddit } from "@/lib/story-jobs";
import {
  publishReviewedStoryAction,
  rejectReviewedStoryAction,
  reprocessRedditSourceAction,
  reopenRedditSourcesAction,
} from "@/app/admin/actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ reddit_id: string }>;
  searchParams: Promise<{
    published?: string;
    rejected?: string;
    reprocess?: string;
    publish_blocked?: string;
    error?: string;
  }>;
}

export default async function RedditSourceReviewPage({
  params,
  searchParams,
}: PageProps) {
  await requireAdmin();
  const { reddit_id } = await params;
  const sp = await searchParams;

  const source = await getRedditSource(reddit_id);
  if (!source) notFound();

  const story = source.story_id ? await getStory(source.story_id) : null;
  const latestJob = await getLatestStoryJobForReddit(reddit_id);
  const readiness = evaluatePublishReadiness(
    story
      ? {
          status: story.status,
          body: story.body,
          hero_image: story.hero_image,
          video_url: story.video_url,
        }
      : null,
    { status: source.status, story_id: source.story_id },
  );

  const blockedReasons = sp.publish_blocked
    ? decodeURIComponent(sp.publish_blocked).split(" | ").filter(Boolean)
    : [];

  return (
    <div className="mx-auto max-w-[1280px] space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/reddit-sources"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Reddit Sources
        </Link>
        <span className="font-mono text-[11px] text-muted">
          reddit_id <span className="text-ink">{source.reddit_id}</span>
        </span>
      </div>

      <FlashBanner sp={sp} blockedReasons={blockedReasons} />

      <SummaryHeader source={source} story={story} />

      <div className="grid gap-5 lg:grid-cols-2">
        <SourcePane source={source} />
        <StoryPane
          source={source}
          story={story}
          readiness={readiness}
          latestJobStatus={latestJob?.status ?? null}
          latestJobError={latestJob?.error ?? null}
        />
      </div>
    </div>
  );
}

function FlashBanner({
  sp,
  blockedReasons,
}: {
  sp: { published?: string; rejected?: string; reprocess?: string; error?: string };
  blockedReasons: string[];
}) {
  if (blockedReasons.length > 0) {
    return (
      <div className="rounded-xl border border-cat-entitled/40 bg-cat-entitled/10 p-3 text-[12px] text-cat-entitled">
        <p className="font-semibold">Publish blocked</p>
        <ul className="mt-1 ml-4 list-disc font-mono text-[11px]">
          {blockedReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (sp.published) {
    return (
      <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 p-3 text-[12px] text-cat-ok">
        Story published. It is now live on the site.
      </div>
    );
  }
  if (sp.rejected) {
    return (
      <div className="rounded-xl border border-line bg-surface p-3 text-[12px] text-ink">
        Story archived. The source row is still marked <code>used</code>; click{" "}
        <em>Re-process</em> below to discard the draft and try again.
      </div>
    );
  }
  if (sp.reprocess) {
    return (
      <div className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-[12px] text-accent">
        Source row reset to <code>imported</code>. Open Reddit Sources, select
        it, and click Process to start a fresh run.
      </div>
    );
  }
  if (sp.error) {
    return (
      <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-[12px] text-danger">
        {sp.error.replace(/-/g, " ")}
      </div>
    );
  }
  return null;
}

const SOURCE_TONE: Record<string, string> = {
  imported: "border-line text-muted",
  queued: "border-accent/40 bg-accent/10 text-accent",
  processing: "border-accent/40 bg-accent/15 text-accent",
  used: "border-cat-ok/40 bg-cat-ok/10 text-cat-ok",
  skipped: "border-cat-entitled/40 bg-cat-entitled/10 text-cat-entitled",
};

function SummaryHeader({
  source,
  story,
}: {
  source: RedditSourceRow;
  story: Awaited<ReturnType<typeof getStory>>;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-[20px] font-extrabold leading-tight tracking-tightest text-ink">
            {story?.title ?? source.title}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            r/{source.subreddit} · {(source.length_chars ?? 0).toLocaleString()}{" "}
            chars · {(source.comments ?? 0).toLocaleString()} comments ·{" "}
            {source.date_written.slice(0, 10)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Chip
            label={`source: ${source.status}`}
            tone={SOURCE_TONE[source.status] ?? "border-line text-muted"}
          />
          {story && (
            <Chip
              label={`story: ${story.status ?? "draft"}`}
              tone={
                story.status === "published"
                  ? "border-cat-ok/40 bg-cat-ok/10 text-cat-ok"
                  : story.status === "archived"
                    ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-accent/40 bg-accent/10 text-accent"
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Chip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function SourcePane({ source }: { source: RedditSourceRow }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Source post
        </h2>
        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-[11px] text-accent hover:underline"
          >
            open on reddit ↗
          </a>
        )}
      </header>
      <h3 className="font-display text-[16px] font-bold tracking-tight text-ink">
        {source.title}
      </h3>
      {source.summary && (
        <p className="font-mono text-[11px] text-muted">{source.summary}</p>
      )}
      <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-3 font-mono text-[12px] leading-relaxed text-ink">
        {source.full_text}
      </pre>
    </section>
  );
}

function StoryPane({
  source,
  story,
  readiness,
  latestJobStatus,
  latestJobError,
}: {
  source: RedditSourceRow;
  story: Awaited<ReturnType<typeof getStory>>;
  readiness: ReturnType<typeof evaluatePublishReadiness>;
  latestJobStatus: string | null;
  latestJobError: string | null;
}) {
  // Five-state branch by source status. The 'used' branch is the full
  // review surface; the others are status snapshots with the next action.
  if (source.status === "skipped") {
    return (
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <Header subtitle="Skipped by you" />
        <p className="text-[13px] text-muted">
          This row is filtered out of the candidate pool. Re-open it to put it
          back in front of the bulk-process flow.
        </p>
        <form action={reopenRedditSourcesAction}>
          <input type="hidden" name="reddit_id" value={source.reddit_id} />
          <button type="submit" className={SECONDARY_BTN}>
            Re-open as imported
          </button>
        </form>
      </section>
    );
  }

  if (source.status === "imported") {
    return (
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <Header subtitle="Not yet enqueued" />
        <p className="text-[13px] text-muted">
          Go back to the candidate list, select this row (plus any others), and
          click <strong>Process N</strong> to kick off the pipeline.
        </p>
        <Link
          href={`/admin/reddit-sources?q=${encodeURIComponent(
            source.title.slice(0, 40),
          )}`}
          className={SECONDARY_BTN}
        >
          Find on candidate list
        </Link>
      </section>
    );
  }

  if (source.status === "queued" || source.status === "processing") {
    return (
      <section className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <Header
          subtitle={
            source.status === "queued"
              ? "Waiting on the local worker"
              : "Worker is processing this row"
          }
        />
        <p className="text-[13px] text-muted">
          Latest job status: <code>{latestJobStatus ?? "—"}</code>.
          {latestJobError && (
            <>
              {" "}
              Last error:{" "}
              <span className="text-danger">{latestJobError}</span>
            </>
          )}
        </p>
        <p className="font-mono text-[11px] text-muted">
          Worker command (run locally):{" "}
          <code className="text-ink">
            python -m pipeline.story_jobs_worker
          </code>
        </p>
        <Link href={`/admin/reddit-sources/${source.reddit_id}`} className={SECONDARY_BTN}>
          Refresh
        </Link>
      </section>
    );
  }

  // status === 'used' — full review surface
  if (!story) {
    return (
      <section className="rounded-xl border border-danger/40 bg-danger/10 p-4">
        <p className="text-[13px] text-danger">
          Source row is marked <code>used</code> but the linked story row is
          missing. This is a data inconsistency — check{" "}
          <code>story_id={source.story_id}</code> in the stories table.
        </p>
      </section>
    );
  }

  let gallery: string[] = [];
  try {
    gallery = story.images ? (JSON.parse(story.images) as string[]) : [];
  } catch {
    gallery = [];
  }

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <Header
          subtitle={
            <>
              Generated story{" "}
              <Link
                href={`/admin/stories/${story.id}`}
                className="text-accent hover:underline"
              >
                open editor →
              </Link>
            </>
          }
        />
        {story.summary && (
          <p className="font-mono text-[11px] text-muted">{story.summary}</p>
        )}
        {story.hero_image ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={story.hero_image}
            alt={`${story.title ?? "story"} hero`}
            className="w-full rounded-lg border border-line"
          />
        ) : (
          <p className="font-mono text-[11px] text-muted">No hero image.</p>
        )}
        {story.video_url ? (
          <video
            controls
            src={story.video_url}
            className="w-full rounded-lg border border-line"
          />
        ) : (
          <p className="font-mono text-[11px] text-muted">No video rendered.</p>
        )}
        {story.body ? (
          <article className="prose prose-invert max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-3 text-[13px] leading-relaxed text-ink">
            {story.body}
          </article>
        ) : (
          <p className="font-mono text-[11px] text-muted">No body.</p>
        )}
        {gallery.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {gallery.slice(0, 9).map((url, i) => (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="block overflow-hidden rounded-md border border-line"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`scene ${i + 1}`}
                  className="h-24 w-full object-cover"
                />
              </a>
            ))}
          </div>
        )}
      </div>

      <ReadinessPanel readiness={readiness} />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <p className="text-[12px] text-muted">
          {readiness.ready
            ? "All checks green. You can publish."
            : "Publish is blocked until the checks above pass."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <form action={reprocessRedditSourceAction}>
            <input type="hidden" name="reddit_id" value={source.reddit_id} />
            <button type="submit" className={SECONDARY_BTN}>
              Re-process
            </button>
          </form>
          <form action={rejectReviewedStoryAction}>
            <input type="hidden" name="reddit_id" value={source.reddit_id} />
            <button
              type="submit"
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-danger hover:opacity-80"
            >
              Reject (archive)
            </button>
          </form>
          <form action={publishReviewedStoryAction}>
            <input type="hidden" name="reddit_id" value={source.reddit_id} />
            <button
              type="submit"
              disabled={!readiness.ready}
              className="rounded-md bg-accent px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Publish
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

function Header({ subtitle }: { subtitle: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-2">
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
        Generated story
      </h2>
      <span className="font-mono text-[11px] text-muted">{subtitle}</span>
    </header>
  );
}

function ReadinessPanel({
  readiness,
}: {
  readiness: ReturnType<typeof evaluatePublishReadiness>;
}) {
  if (readiness.ready) {
    return (
      <div className="rounded-xl border border-cat-ok/40 bg-cat-ok/10 p-3 text-[12px] text-cat-ok">
        All readiness checks passed.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-cat-entitled/40 bg-cat-entitled/10 p-3 text-[12px] text-cat-entitled">
      <p className="font-semibold">Readiness checks blocking publish</p>
      <ul className="mt-1 ml-4 list-disc font-mono text-[11px]">
        {readiness.missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

const SECONDARY_BTN =
  "rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted hover:text-ink";
