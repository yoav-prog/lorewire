"use client";

// Client-side article editor. Wraps a Tiptap v3 editor with the StarterKit
// built-ins (paragraph, headings, lists, quote, divider, code) plus the
// editor-level `textDirection` option for Hebrew RTL. Phase 1 ships only the
// built-ins; custom blocks (callout, image, gallery, embed) land in Phase 2
// alongside Novel.sh's slash-menu shell.
//
// The form serializes the title + subtitle + summary + hero image inputs
// alongside a hidden `document` field set on submit from `editor.getJSON()`.
// Autosave-debounce + revision coalescing wire in Phase 2; Phase 1 commits
// on the Save button only so the editing model stays unsurprising.

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useRef, useState } from "react";
import { saveArticleAction } from "@/app/admin/actions";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

// Tiptap empty document shape — matches what `createArticle` writes at insert
// time. Used as a fallback when the stored document fails to parse so the
// editor never hard-crashes on a malformed blob.
const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] } as const;

function parseDocument(raw: string): object {
  if (!raw) return EMPTY_DOC;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through to EMPTY_DOC — recovery surface lands in Phase 2
  }
  return EMPTY_DOC;
}

interface Props {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  heroImage: string;
  document: string;
  direction: "ltr" | "rtl";
}

export function ArticleEditor({
  id,
  title,
  subtitle,
  summary,
  heroImage,
  document,
  direction,
}: Props) {
  const docHidden = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const initialDoc = parseDocument(document);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialDoc,
    textDirection: direction,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // Tailwind `prose` would be nicer but we don't ship the typography
        // plug-in yet; this matches the existing admin form rhythm and gives
        // the editor surface enough room to feel like an editor, not a textarea.
        class:
          "min-h-[360px] rounded-lg border border-line bg-bg px-4 py-3 text-[15px] text-ink leading-relaxed outline-none focus-within:border-accent",
        dir: direction,
      },
    },
  });

  // Brief loading shell so the editor surface is reserved on first mount and
  // the layout doesn't jump when Tiptap initializes. `immediatelyRender:false`
  // makes the first paint server-hydrated empty; this fills that paint.
  if (!editor) {
    return (
      <div className="space-y-4">
        <div className="h-[42px] rounded-lg border border-line bg-surface" />
        <div className="h-[360px] rounded-lg border border-line bg-surface" />
      </div>
    );
  }

  return (
    <form
      action={saveArticleAction}
      onSubmit={() => {
        if (docHidden.current) {
          docHidden.current.value = JSON.stringify(editor.getJSON());
        }
        setSaving(true);
      }}
      className="space-y-4"
    >
      <input type="hidden" name="id" value={id} />
      <input ref={docHidden} type="hidden" name="document" defaultValue="" />

      <div>
        <label className={LABEL}>Title</label>
        <input
          name="title"
          defaultValue={title}
          className={FIELD}
          dir={direction}
        />
      </div>

      <div>
        <label className={LABEL}>Subtitle</label>
        <input
          name="subtitle"
          defaultValue={subtitle}
          className={FIELD}
          dir={direction}
        />
      </div>

      <div>
        <label className={LABEL}>Summary</label>
        <textarea
          name="summary"
          defaultValue={summary}
          rows={2}
          className={FIELD}
          dir={direction}
        />
      </div>

      <div>
        <label className={LABEL}>Hero image URL</label>
        <input
          name="hero_image"
          defaultValue={heroImage}
          placeholder="https://… (upload UI lands in Phase 2)"
          className={`${FIELD} font-mono text-[12px]`}
        />
      </div>

      <div>
        <label className={LABEL}>Body</label>
        <EditorContent editor={editor} />
        <p className="mt-1 font-mono text-[11px] text-muted">
          Markdown shortcuts work: # heading, - list, &gt; quote, ``` code.
          Custom blocks (callout, image, gallery, embed) land in Phase 2.
        </p>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-accent px-5 py-2.5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
