"use client";

// Type-specific metadata sidebar for the article editor. Renders the right
// fields per article.type and posts the form to updateArticlePayloadAction.
// Lives client-side because the listicle editor needs add / remove / reorder
// state — the other three are pure forms but they share the chrome and the
// submit handler, so keeping all four in one file beats two duplicated
// shells.
//
// All inputs are namespaced `payload.<field>` so the action's field() helper
// can pick them up, and the listicle items use repeated `payload.item.*`
// fields which formData.getAll preserves in order. A hidden `__type` lets
// the action cross-check against the stored article type before write.

import { useState } from "react";
import { updateArticlePayloadAction } from "@/app/admin/actions";
import type { ArticleType } from "@/lib/repo";
import type {
  NewsPayload,
  FeaturePayload,
  ListiclePayload,
  ReviewPayload,
  ListicleItem,
} from "@/lib/article-payload";

const FIELD =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent";
const SMALL_LABEL =
  "mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-muted";
const SECTION_LABEL =
  "mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted";
const ROW = "rounded-lg border border-line bg-bg p-2.5 space-y-2";
const BTN =
  "rounded-md border border-line bg-bg px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent";
const PRIMARY_BTN =
  "w-full rounded-md bg-accent px-3 py-1.5 font-semibold text-bg transition-opacity hover:opacity-90";
const SECTION_WRAP = "rounded-xl border border-line bg-surface p-4";

interface CommonProps {
  articleId: string;
  direction: "ltr" | "rtl";
}

type Props = CommonProps &
  (
    | { type: "news"; payload: NewsPayload }
    | { type: "feature"; payload: FeaturePayload }
    | { type: "listicle"; payload: ListiclePayload }
    | { type: "review"; payload: ReviewPayload }
  );

export function ArticlePayloadSidebar(props: Props) {
  return (
    <div className={SECTION_WRAP}>
      <div className={SECTION_LABEL}>
        {labelForType(props.type)} details
      </div>
      <form action={updateArticlePayloadAction} className="space-y-3">
        <input type="hidden" name="id" value={props.articleId} />
        <input type="hidden" name="__type" value={props.type} />
        {renderFor(props)}
        <button type="submit" className={PRIMARY_BTN}>
          Save details
        </button>
      </form>
    </div>
  );
}

function labelForType(t: ArticleType): string {
  switch (t) {
    case "news":
      return "News";
    case "feature":
      return "Feature";
    case "listicle":
      return "Listicle";
    case "review":
      return "Review";
  }
}

function renderFor(props: Props): React.ReactNode {
  switch (props.type) {
    case "news":
      return <NewsFields payload={props.payload} direction={props.direction} />;
    case "feature":
      return (
        <FeatureFields payload={props.payload} direction={props.direction} />
      );
    case "listicle":
      return (
        <ListicleFields payload={props.payload} direction={props.direction} />
      );
    case "review":
      return <ReviewFields payload={props.payload} direction={props.direction} />;
  }
}

// --- news ------------------------------------------------------------------

function NewsFields({
  payload,
  direction,
}: {
  payload: NewsPayload;
  direction: "ltr" | "rtl";
}) {
  return (
    <>
      <label className="block">
        <span className={SMALL_LABEL}>Dateline location</span>
        <input
          name="payload.datelineLocation"
          defaultValue={payload.datelineLocation}
          placeholder='e.g. "Tel Aviv"'
          className={FIELD}
          dir={direction}
        />
      </label>
      <label className="block">
        <span className={SMALL_LABEL}>Dateline date</span>
        <input
          name="payload.datelineDate"
          defaultValue={payload.datelineDate}
          placeholder='e.g. "June 11"'
          className={FIELD}
          dir={direction}
        />
      </label>
      <label className="block">
        <span className={SMALL_LABEL}>Source URL</span>
        <input
          name="payload.sourceUrl"
          defaultValue={payload.sourceUrl}
          placeholder="https://…"
          className={`${FIELD} font-mono text-[12px]`}
        />
      </label>
      <label className="block">
        <span className={SMALL_LABEL}>Source label</span>
        <input
          name="payload.sourceLabel"
          defaultValue={payload.sourceLabel}
          placeholder='e.g. "Reuters"'
          className={FIELD}
          dir={direction}
        />
      </label>
    </>
  );
}

// --- feature ---------------------------------------------------------------

function FeatureFields({
  payload,
  direction,
}: {
  payload: FeaturePayload;
  direction: "ltr" | "rtl";
}) {
  return (
    <>
      <label className="block">
        <span className={SMALL_LABEL}>Author byline</span>
        <input
          name="payload.authorByline"
          defaultValue={payload.authorByline}
          placeholder='e.g. "By Yoav Morag"'
          className={FIELD}
          dir={direction}
        />
      </label>
      <label className="block">
        <span className={SMALL_LABEL}>Reading time (minutes)</span>
        <input
          name="payload.readingTimeMinutes"
          defaultValue={String(payload.readingTimeMinutes ?? 0)}
          type="number"
          min={0}
          max={120}
          className={`${FIELD} font-mono`}
        />
      </label>
      <p className="font-mono text-[10px] text-muted">
        Hero image and subtitle live on the main editor form, not here.
      </p>
    </>
  );
}

// --- listicle --------------------------------------------------------------

function ListicleFields({
  payload,
  direction,
}: {
  payload: ListiclePayload;
  direction: "ltr" | "rtl";
}) {
  // Local items state so the writer can add / remove rows before submitting.
  // The form serializes the final state when the user clicks Save details.
  const [items, setItems] = useState<ListicleItem[]>(
    payload.items.length > 0
      ? payload.items
      : [{ rank: 1, title: "", body: "", imageUrl: "", imageAlt: "" }],
  );

  function update(idx: number, patch: Partial<ListicleItem>): void {
    setItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function add(): void {
    setItems((prev) => [
      ...prev,
      {
        rank: prev.length + 1,
        title: "",
        body: "",
        imageUrl: "",
        imageAlt: "",
      },
    ]);
  }

  function remove(idx: number): void {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.map((it, i) => ({ ...it, rank: i + 1 }));
    });
  }

  function move(idx: number, dir: -1 | 1): void {
    setItems((prev) => {
      const j = idx + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[j]] = [next[j], next[idx]];
      return next.map((it, i) => ({ ...it, rank: i + 1 }));
    });
  }

  return (
    <>
      <label className="flex items-center justify-between gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5">
        <span className={`${SMALL_LABEL} mb-0`}>Countdown order</span>
        <input
          type="checkbox"
          name="payload.countdownOrder"
          defaultChecked={payload.countdownOrder}
          className="h-4 w-4 accent-accent"
        />
      </label>

      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className={ROW}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider text-muted">
                #{idx + 1}
              </span>
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => move(idx, -1)}
                  disabled={idx === 0}
                  className={`${BTN} disabled:opacity-30`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, 1)}
                  disabled={idx === items.length - 1}
                  className={`${BTN} disabled:opacity-30`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  className={`${BTN} hover:border-danger/40 hover:text-danger`}
                >
                  Remove
                </button>
              </span>
            </div>
            <input type="hidden" name="payload.item.rank" value={item.rank} />
            <input
              name="payload.item.title"
              value={item.title}
              onChange={(e) => update(idx, { title: e.target.value })}
              placeholder="Item title"
              className={FIELD}
              dir={direction}
            />
            <textarea
              name="payload.item.body"
              value={item.body}
              onChange={(e) => update(idx, { body: e.target.value })}
              placeholder="Short blurb"
              rows={2}
              className={FIELD}
              dir={direction}
            />
            <div className="grid grid-cols-[1fr_1fr] gap-2">
              <input
                name="payload.item.imageUrl"
                value={item.imageUrl}
                onChange={(e) => update(idx, { imageUrl: e.target.value })}
                placeholder="Image URL"
                className={`${FIELD} font-mono text-[11px]`}
              />
              <input
                name="payload.item.imageAlt"
                value={item.imageAlt}
                onChange={(e) => update(idx, { imageAlt: e.target.value })}
                placeholder="Alt text"
                className={FIELD}
                dir={direction}
              />
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        disabled={items.length >= 50}
        className={`${BTN} w-full disabled:opacity-40`}
      >
        + Add item
      </button>
    </>
  );
}

// --- review ----------------------------------------------------------------

function ReviewFields({
  payload,
  direction,
}: {
  payload: ReviewPayload;
  direction: "ltr" | "rtl";
}) {
  // Local pros / cons state so the writer can add / remove bullets. We render
  // an empty row at the end so adding is a one-click affair without an
  // explicit add button per list.
  const [pros, setPros] = useState<string[]>(
    payload.pros.length > 0 ? payload.pros : [""],
  );
  const [cons, setCons] = useState<string[]>(
    payload.cons.length > 0 ? payload.cons : [""],
  );

  return (
    <>
      <label className="block">
        <span className={SMALL_LABEL}>Rating (0–10)</span>
        <input
          name="payload.rating"
          defaultValue={String(payload.rating ?? 0)}
          type="number"
          step="0.1"
          min={0}
          max={10}
          className={`${FIELD} font-mono`}
        />
      </label>
      <label className="block">
        <span className={SMALL_LABEL}>Verdict</span>
        <input
          name="payload.verdict"
          defaultValue={payload.verdict}
          placeholder="One-sentence summary"
          className={FIELD}
          dir={direction}
        />
      </label>

      <BulletList
        label="Pros"
        items={pros}
        onChange={setPros}
        fieldName="payload.pros"
        direction={direction}
      />
      <BulletList
        label="Cons"
        items={cons}
        onChange={setCons}
        fieldName="payload.cons"
        direction={direction}
      />
    </>
  );
}

function BulletList({
  label,
  items,
  onChange,
  fieldName,
  direction,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  fieldName: string;
  direction: "ltr" | "rtl";
}) {
  function update(idx: number, value: string): void {
    onChange(items.map((it, i) => (i === idx ? value : it)));
  }
  function add(): void {
    if (items.length >= 20) return;
    onChange([...items, ""]);
  }
  function remove(idx: number): void {
    onChange(items.filter((_, i) => i !== idx));
  }
  return (
    <div className="space-y-1">
      <div className={SMALL_LABEL}>{label}</div>
      {items.map((it, idx) => (
        <div key={idx} className="flex items-center gap-1">
          <input
            name={fieldName}
            value={it}
            onChange={(e) => update(idx, e.target.value)}
            placeholder={`${label.toLowerCase().slice(0, -1)} ${idx + 1}`}
            className={FIELD}
            dir={direction}
          />
          <button
            type="button"
            onClick={() => remove(idx)}
            className={`${BTN} hover:border-danger/40 hover:text-danger`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        disabled={items.length >= 20}
        className={`${BTN} disabled:opacity-40`}
      >
        + Add
      </button>
    </div>
  );
}
