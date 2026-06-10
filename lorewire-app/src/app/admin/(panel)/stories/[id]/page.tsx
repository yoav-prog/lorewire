import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/dal";
import { getStory } from "@/lib/repo";
import { saveStory, changeStatus } from "@/app/admin/actions";
import { CATEGORIES, statusClass } from "@/app/admin/ui";

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

  const statusButtons: { status: string; label: string }[] = [
    { status: "review", label: "Mark in review" },
    { status: "ready", label: "Mark ready" },
    { status: "published", label: "Publish" },
    { status: "archived", label: "Archive" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/admin/stories"
          className="font-mono text-[12px] text-muted hover:text-ink"
        >
          &larr; Stories
        </Link>
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
          </div>

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
