// Overview tab — the story metadata form that used to live as the center
// column of /admin/stories/[id]. Extracted verbatim so the tab shell can
// host it alongside Scenes / Captions / Style / Script / Voice / Publish
// & SEO / Render. No behavior change in this extraction.
//
// Server component: the form's action is the existing `saveStory` server
// action, and the chip groups inside are client components that work
// inside an RSC tree the same way they did before.
//
// Plan: _plans/2026-06-24-unified-story-editor.md.

import type { StoryRow } from "@/lib/repo";
import { saveStory } from "@/app/admin/actions";
import { CategoryChipGroup } from "./CategoryChipGroup";
import { StoryAspectControl } from "./StoryAspectControl";
import type { VideoAspect } from "@/lib/aspect";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export function OverviewTab({
  story,
  initialAspect,
  aspectIsOverride,
}: {
  story: StoryRow;
  initialAspect: VideoAspect;
  aspectIsOverride: boolean;
}) {
  return (
    <form action={saveStory} className="space-y-4">
      <input type="hidden" name="id" value={story.id} />

      <div>
        <label className={LABEL}>Title</label>
        <input
          name="title"
          defaultValue={story.title ?? ""}
          className={FIELD}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
        <div>
          <label className={LABEL}>Category</label>
          <CategoryChipGroup
            name="category"
            initial={story.category ?? "Entitled"}
          />
        </div>
        <div>
          <label className={LABEL}>Duration</label>
          <input
            name="duration"
            defaultValue={story.duration ?? ""}
            placeholder="2:14"
            className={FIELD}
          />
        </div>
      </div>

      <div>
        <label className={LABEL}>Aspect ratio</label>
        <StoryAspectControl
          storyId={story.id}
          initialAspect={initialAspect}
          globalDefault={!aspectIsOverride}
        />
      </div>

      <div>
        <label className={LABEL}>Source URL</label>
        <input
          name="source_url"
          defaultValue={story.source_url ?? ""}
          className={FIELD}
        />
      </div>

      <div>
        <label className={LABEL}>Synopsis</label>
        <textarea
          name="summary"
          defaultValue={story.summary ?? ""}
          rows={2}
          className={FIELD}
        />
      </div>

      <div>
        <label className={LABEL}>Article body</label>
        <textarea
          name="body"
          defaultValue={story.body ?? ""}
          rows={16}
          className={`${FIELD} font-body leading-relaxed`}
        />
      </div>

      <div>
        <label className={LABEL}>Read-along script</label>
        <textarea
          name="teleprompter"
          defaultValue={story.teleprompter ?? ""}
          rows={6}
          className={FIELD}
        />
      </div>

      <button
        type="submit"
        className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90"
      >
        Save changes
      </button>
    </form>
  );
}
