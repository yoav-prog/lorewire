"use client";

// Client-side article editor. Phase 2 adds:
//   - Callout block (info / warning / success) — Tiptap block node with
//     editable content, tone picked from a toolbar dropdown.
//   - ArticleImage block — atomic block with a React NodeView that renders
//     <img> + alt input + caption input + delete. Alt text is enforced at
//     publish time by the setArticleStatusAction guard in actions.ts.
//   - Image upload: toolbar button -> file picker -> POST multipart to
//     /api/admin/articles/images -> insertArticleImage on the editor.
//   - Format toolbar: H2/H3, bold/italic, lists, quote, undo/redo.
//
// The node specs in src/lib/tiptap-callout.ts and src/lib/tiptap-article-image.ts
// stay React-free so the public reader (Phase 4a) can import them under Node
// for server-side generateHTML. The React NodeView is attached HERE via
// `.extend({ addNodeView })` so the schema in lib/ is pure JSON-side.

import { useEditor, EditorContent, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useRef, useState } from "react";
import { saveArticleAction } from "@/app/admin/actions";
import { Callout, type CalloutTone } from "@/lib/tiptap-callout";
import { ArticleImage } from "@/lib/tiptap-article-image";
import { ArticleImageView } from "./ArticleImageView";

const FIELD =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";
const TOOLBAR_BTN =
  "rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";
const TOOLBAR_BTN_ACTIVE =
  "rounded-md border border-accent bg-accent/15 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-accent";

const CALLOUT_TONES: CalloutTone[] = ["info", "warning", "success"];

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] } as const;

function parseDocument(raw: string): object {
  if (!raw) return EMPTY_DOC;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through
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

interface UploadResponse {
  imageId: string;
  url: string;
  width: number | null;
  height: number | null;
}

interface ErrorResponse {
  error?: string;
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const initialDoc = parseDocument(document);

  // ArticleImage carries a React NodeView. We attach it on-the-fly here so
  // the node spec in lib/ stays importable from server-side rendering code
  // that has no React available.
  const ArticleImageWithView = ArticleImage.extend({
    addNodeView() {
      return ReactNodeViewRenderer(ArticleImageView);
    },
  });

  const editor = useEditor({
    extensions: [StarterKit, Callout, ArticleImageWithView],
    content: initialDoc,
    textDirection: direction,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "min-h-[420px] rounded-lg border border-line bg-bg px-4 py-3 text-[15px] text-ink leading-relaxed outline-none focus-within:border-accent",
        dir: direction,
      },
    },
  });

  if (!editor) {
    return (
      <div className="space-y-4">
        <div className="h-[42px] rounded-lg border border-line bg-surface" />
        <div className="h-[420px] rounded-lg border border-line bg-surface" />
      </div>
    );
  }

  async function onUploadFile(file: File): Promise<void> {
    setUploadError("");
    if (file.size > 4 * 1024 * 1024) {
      setUploadError("Image is larger than 4 MB.");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("articleId", id);
      form.append("file", file);
      const resp = await fetch("/api/admin/articles/images", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as ErrorResponse;
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as UploadResponse;
      editor
        ?.chain()
        .focus()
        .insertArticleImage({
          src: data.url,
          alt: "",
          caption: "",
          width: data.width,
          height: data.height,
        })
        .run();
      console.info("[articles editor] upload-insert", {
        articleId: id,
        imageId: data.imageId,
        bytes: file.size,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[articles editor] upload FAILED:", msg);
      setUploadError(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const currentCalloutTone =
    editor.isActive("callout")
      ? (editor.getAttributes("callout").tone as CalloutTone | undefined) ?? "info"
      : null;

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
          placeholder="https://… (Phase 3 adds a picker; for now paste a URL)"
          className={`${FIELD} font-mono text-[12px]`}
        />
      </div>

      <div>
        <label className={LABEL}>Body</label>

        <div className="mb-2 flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-1.5">
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={
              editor.isActive("heading", { level: 2 })
                ? TOOLBAR_BTN_ACTIVE
                : TOOLBAR_BTN
            }
          >
            H2
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            className={
              editor.isActive("heading", { level: 3 })
                ? TOOLBAR_BTN_ACTIVE
                : TOOLBAR_BTN
            }
          >
            H3
          </button>
          <span className="mx-1 h-5 w-px bg-line" />
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={editor.isActive("bold") ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN}
          >
            Bold
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={
              editor.isActive("italic") ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN
            }
          >
            Italic
          </button>
          <span className="mx-1 h-5 w-px bg-line" />
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={
              editor.isActive("bulletList") ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN
            }
          >
            • List
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={
              editor.isActive("orderedList") ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN
            }
          >
            1. List
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={
              editor.isActive("blockquote") ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN
            }
          >
            Quote
          </button>
          <span className="mx-1 h-5 w-px bg-line" />

          {/* Callout — three tone buttons that work as a tri-state toggle. */}
          {CALLOUT_TONES.map((tone) => {
            const active = currentCalloutTone === tone;
            return (
              <button
                key={tone}
                type="button"
                onClick={() => {
                  if (currentCalloutTone === tone) {
                    editor.chain().focus().unsetCallout().run();
                  } else if (currentCalloutTone) {
                    editor.chain().focus().updateCalloutTone(tone).run();
                  } else {
                    editor.chain().focus().setCallout({ tone }).run();
                  }
                }}
                className={active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN}
                title={`${tone} callout`}
              >
                {tone === "info" ? "ℹ Callout" : tone === "warning" ? "! Callout" : "✓ Callout"}
              </button>
            );
          })}

          <span className="mx-1 h-5 w-px bg-line" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className={TOOLBAR_BTN}
          >
            {uploading ? "Uploading…" : "Image"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadFile(file);
            }}
          />

          <span className="ml-auto flex gap-1">
            <button
              type="button"
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().undo()}
              className={TOOLBAR_BTN}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().redo()}
              className={TOOLBAR_BTN}
            >
              Redo
            </button>
          </span>
        </div>

        {uploadError && (
          <p className="mb-2 text-[12px] text-danger">{uploadError}</p>
        )}

        <EditorContent editor={editor} />
        <p className="mt-1 font-mono text-[11px] text-muted">
          Markdown shortcuts also work: # heading, - list, &gt; quote, ``` code.
          Images need alt text before publish.
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
