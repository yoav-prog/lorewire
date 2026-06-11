// Day-1 throwaway spike — does @remotion/player embed cleanly in a Next 16
// (panel) client component? The plan (2026-06-11-video-editor.md §Sequencing)
// gates the real /admin/videos/[id] editor on this answering yes.
//
// Server side: standard admin auth + story lookup so the spike sees a real
// row. Client side: dynamic-imported Player with ssr: false mounts a tiny
// inline composition built from the story's title. We are NOT importing the
// real DoodleShort yet — that is Day 5 work. The spike's only job is to
// prove the Player <-> Next 16 client boundary works.

import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { getStory } from "@/lib/repo";
import SpikeClient from "./SpikeClient";

export default async function VideoSpikePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const story = await getStory(id);
  if (!story) notFound();

  // eslint-disable-next-line no-console -- rule 14: observability from day one
  console.info("[video editor spike] page render", {
    story_id: story.id,
    has_title: Boolean(story.title),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link
          href={`/admin/stories/${story.id}`}
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Story
        </Link>
        <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          spike · throwaway
        </span>
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <h1 className="font-display text-[20px] font-bold tracking-tightest">
          Player embed spike
        </h1>
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted">
          {story.title ?? "(untitled story)"}
        </p>
      </div>

      <SpikeClient title={story.title ?? "LoreWire spike"} />

      <div className="rounded-xl border border-line bg-surface p-4 font-mono text-[11px] text-muted">
        <p className="mb-1 font-semibold uppercase tracking-wider">Pass criteria</p>
        <ul className="list-disc pl-4 leading-5">
          <li>Player mounts without SSR errors</li>
          <li>Play/pause/scrub controls visible and responsive</li>
          <li>Title text animates per <code>useCurrentFrame</code></li>
          <li>No console errors from the @remotion/player bundle</li>
        </ul>
      </div>
    </div>
  );
}
