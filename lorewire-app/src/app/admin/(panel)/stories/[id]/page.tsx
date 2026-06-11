import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import {
  getStory,
  getSetting,
  listSegments,
  type SegmentKind,
  type SegmentRow,
} from "@/lib/repo";
import {
  saveStory,
  changeStatus,
  setStoryOverrideAction,
  setStoryNoindexAction,
} from "@/app/admin/actions";
import { CATEGORIES, statusClass } from "@/app/admin/ui";
import Breadcrumb from "@/app/admin/Breadcrumb";
import {
  MediaRegenPanel,
  type MediaAssetSpec,
} from "@/app/admin/(panel)/_components/MediaRegenPanel";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

export default async function EditStory({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const s = await getStory(id);
  if (!s) notFound();

  let gallery: string[] = [];
  try {
    gallery = s.images ? (JSON.parse(s.images) as string[]) : [];
  } catch {
    gallery = [];
  }

  // Intro/outro override controls. The dropdown options are the enabled
  // segments for that kind plus an "inherit global" and "skip" sentinel; the
  // server action turns the choice into either a pinned id or a skip flag.
  const [intros, outros, activeIntroId, activeOutroId] = await Promise.all([
    listSegments("intro"),
    listSegments("outro"),
    getSetting("video.active_intro_id"),
    getSetting("video.active_outro_id"),
  ]);

  const statusButtons: { status: string; label: string }[] = [
    { status: "review", label: "Mark in review" },
    { status: "ready", label: "Mark ready" },
    { status: "published", label: "Publish" },
    { status: "archived", label: "Archive" },
  ];

  // What this story owns that can be regenerated. Order is the order the
  // panel lists them in — hero first (most impactful), then bulk-asset
  // groups (scenes, props), then mouth-swap (specialty).
  const storyAssets: MediaAssetSpec[] = [
    {
      asset: "hero",
      label: "Hero image",
      hint: "The poster frame on the public reader and the OG card.",
    },
    {
      asset: "scenes",
      label: "All scene images",
      hint: "Every scene image the doodle composition cycles through. Count comes from Settings → General → Scenes per story.",
    },
  ];
  // Optional bulk regens that only appear when the relevant feature is on.
  const propSlideOn = String((await getSetting("video.prop_slide")) ?? "0") !== "0";
  if (propSlideOn) {
    storyAssets.push({
      asset: "props",
      label: "All prop cutouts",
      hint: "Object cutouts that slide in across the video. Count comes from Settings → General → Props per story.",
    });
  }
  const mouthSwapOn = String((await getSetting("video.mouth_swap")) ?? "0") !== "0";
  if (mouthSwapOn) {
    storyAssets.push({
      asset: "mouth_swap",
      label: "Talking head bust",
      hint: "Protagonist portrait + mouth-removed pair for the lip-flap overlay. Two images per regen.",
    });
  }

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin/content", label: "Inbox" }]} />
      <div className="flex items-center justify-end gap-3">
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${statusClass(
            s.status,
          )}`}
        >
          {s.status ?? "draft"}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Editor */}
        <form action={saveStory} className="space-y-4">
          <input type="hidden" name="id" value={s.id} />

          <div>
            <label className={LABEL}>Title</label>
            <input name="title" defaultValue={s.title ?? ""} className={FIELD} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Category</label>
              <select
                name="category"
                defaultValue={s.category ?? "Entitled"}
                className={FIELD}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>Duration</label>
              <input
                name="duration"
                defaultValue={s.duration ?? ""}
                placeholder="2:14"
                className={FIELD}
              />
            </div>
          </div>

          <div>
            <label className={LABEL}>Source URL</label>
            <input
              name="source_url"
              defaultValue={s.source_url ?? ""}
              className={FIELD}
            />
          </div>

          <div>
            <label className={LABEL}>Synopsis</label>
            <textarea
              name="summary"
              defaultValue={s.summary ?? ""}
              rows={2}
              className={FIELD}
            />
          </div>

          <div>
            <label className={LABEL}>Article body</label>
            <textarea
              name="body"
              defaultValue={s.body ?? ""}
              rows={16}
              className={`${FIELD} font-body leading-relaxed`}
            />
          </div>

          <div>
            <label className={LABEL}>Read-along script</label>
            <textarea
              name="teleprompter"
              defaultValue={s.teleprompter ?? ""}
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

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Status</div>
            <div className="flex flex-wrap gap-2">
              {statusButtons.map((b) => (
                <form key={b.status} action={changeStatus}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="status" value={b.status} />
                  <button
                    className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent"
                  >
                    {b.label}
                  </button>
                </form>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Search visibility</div>
            <p className="mb-2 text-[12px] text-muted">
              {s.noindex
                ? "Hidden from search engines. /v/${slug} emits noindex,nofollow."
                : "Indexable. /v/${slug} can be crawled and ranked."}
            </p>
            <form action={setStoryNoindexAction}>
              <input type="hidden" name="id" value={s.id} />
              <input
                type="hidden"
                name="noindex"
                value={s.noindex ? "0" : "1"}
              />
              <button className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
                {s.noindex ? "Show in search engines" : "Hide from search engines"}
              </button>
            </form>
          </div>

          <MediaRegenPanel
            ownerKind="story"
            ownerId={s.id}
            assets={storyAssets}
          />

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className={LABEL}>Media</div>
            {s.hero_image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={s.hero_image}
                alt=""
                className="mb-3 w-full rounded-lg border border-line"
              />
            ) : (
              <p className="mb-2 text-[13px] text-muted">No hero image yet.</p>
            )}
            {gallery.length > 0 && (
              <p className="mb-2 text-[13px] text-muted">
                {gallery.length} illustration(s)
              </p>
            )}
            {s.audio_url && (
              <audio controls src={s.audio_url} className="mb-2 w-full" />
            )}
            {s.video_url ? (
              <video controls src={s.video_url} className="w-full rounded-lg" />
            ) : (
              <p className="text-[13px] text-muted">No video rendered yet.</p>
            )}
            <Link
              href={`/admin/videos/${s.id}`}
              className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent"
            >
              Open video editor →
            </Link>
          </div>

          <SegmentOverrideCard
            kind="intro"
            label="Intro"
            rows={intros}
            storyId={s.id}
            pinnedId={s.intro_segment_id}
            skip={Boolean(s.skip_intro)}
            globalActiveId={activeIntroId ?? null}
          />

          <SegmentOverrideCard
            kind="outro"
            label="Outro"
            rows={outros}
            storyId={s.id}
            pinnedId={s.outro_segment_id}
            skip={Boolean(s.skip_outro)}
            globalActiveId={activeOutroId ?? null}
          />

          <div className="rounded-xl border border-line bg-surface p-4 font-mono text-[11px] text-muted">
            <div className={LABEL}>Meta</div>
            <p>id: {s.id}</p>
            <p>tokens: {s.tokens ?? 0}</p>
            <p>cost: ${((s.cost_cents ?? 0) / 100).toFixed(2)}</p>
            {s.created_at && <p>created: {s.created_at.slice(0, 16)}</p>}
            {s.published_at && <p>published: {s.published_at.slice(0, 16)}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SegmentOverrideCard({
  kind,
  label,
  rows,
  storyId,
  pinnedId,
  skip,
  globalActiveId,
}: {
  kind: SegmentKind;
  label: string;
  rows: SegmentRow[];
  storyId: string;
  pinnedId: string | null;
  skip: boolean;
  globalActiveId: string | null;
}) {
  const enabledRows = rows.filter((r) => r.enabled !== 0);
  // The select's current value reflects the resolution chain so the UI shows
  // exactly what the render will use: a skip flag wins over a pinned id, and
  // a pinned id wins over the global active.
  const currentValue = skip ? "skip" : pinnedId || "inherit";
  const globalRow = rows.find((r) => r.id === globalActiveId);
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className={LABEL}>{label}</div>
      <form action={setStoryOverrideAction} className="space-y-2">
        <input type="hidden" name="story_id" value={storyId} />
        <input type="hidden" name="kind" value={kind} />
        <select
          name="pick"
          defaultValue={currentValue}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        >
          <option value="inherit">
            Use global active
            {globalRow ? ` (${globalRow.label ?? globalRow.id.slice(0, 8)})` : " (none set)"}
          </option>
          <option value="skip">Skip — no {kind} for this story</option>
          {enabledRows.length > 0 && (
            <optgroup label="Pin a specific one">
              {enabledRows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label ?? r.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button className="w-full rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save {label.toLowerCase()} choice
        </button>
      </form>
    </div>
  );
}
