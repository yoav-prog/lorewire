// Short editor.
//
// Server Component shell: auth, story lookup, short_config seed (via the
// action's loadShortEditorState), voice catalog load for the Voice tab,
// then hand off to the client component that owns the tabs + interactivity.
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import { getStory } from "@/lib/repo";
import { listVoices } from "@/lib/voice-library";
import { loadShortEditorState } from "./actions";
import { ShortEditorClient } from "./ShortEditorClient";

export default async function ShortEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const story = await getStory(id);
  if (!story) notFound();

  // Voices: the catalog is per-process-memoized in listVoices() so this
  // costs ~1 ms after the first page load of the admin shell.
  const [state, voices] = await Promise.all([
    loadShortEditorState(id),
    listVoices().catch((err) => {
      // eslint-disable-next-line no-console -- rule 14
      console.warn("[short editor page] listVoices failed", { err: String(err) });
      return [];
    }),
  ]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted">
            <Link
              href={`/admin/videos/${id}`}
              className="hover:text-accent hover:underline"
            >
              ← Story
            </Link>
            <span>·</span>
            <span>Short editor</span>
          </div>
          <h1 className="mt-1 text-base font-semibold text-ink">
            {story.title ?? "(untitled)"}
          </h1>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted">
          Scenes · Captions · Script · Voice
        </div>
      </header>

      {!state.ok ? (
        <NoShortYet error={state.error ?? "unknown"} storyId={id} />
      ) : (
        <ShortEditorClient
          storyId={id}
          initialConfig={state.config!}
          initialRender={state.latestRender ?? null}
          voices={voices}
        />
      )}
    </div>
  );
}

function NoShortYet({ error, storyId }: { error: string; storyId: string }) {
  // The most common reason the editor lands cold is "you haven't generated
  // a short for this story yet." Send the admin to the video editor where
  // the Generate Short button lives — Phase 2's plan moves that button up
  // into this surface, but for Phase 1 we link out.
  if (error === "no-short-yet" || error === "short_renders-props-empty") {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="text-[13px] text-ink">
          No short exists for this story yet.
        </p>
        <p className="mt-1 text-[12px] text-muted">
          Generate one from the story editor, then come back here to fine-tune
          individual scenes.
        </p>
        <Link
          href={`/admin/videos/${storyId}`}
          className="mt-3 inline-block rounded-md border border-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent hover:bg-accent/10"
        >
          Open video editor
        </Link>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-warn bg-warn/10 p-4 text-[12px] text-warn"
    >
      Could not load the short editor: {error}
    </div>
  );
}
