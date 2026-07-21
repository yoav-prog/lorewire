"use client";

// Image setting: URL input + "Upload image" button + live preview. Used for
// the SEO social-card image and the organization logo — anywhere a settings
// value is a picture rather than text. Typing a URL autosaves like
// SettingText (500ms debounce + AutoSaveStatus pill); picking a file POSTs
// it to /api/admin/uploads/image (stored in R2 via the media uploader),
// fills the field with the returned URL, and saves immediately — one click
// does everything.
//
// Plan: _plans/2026-07-05-admin-image-upload-to-r2.md.

import { useRef, useState } from "react";
import { saveSettingAction } from "@/app/admin/actions";
import { AutoSaveStatus, useDebouncedSave } from "@/components/ui";
import {
  MAX_IMAGE_BYTES,
  uploadErrorText,
  type AdminImageSlot,
} from "@/lib/admin-image-upload";

export function SettingImageField({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
  slot,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  /** Which upload slot the file lands in — decides the object key prefix. */
  slot: AdminImageSlot;
}) {
  const [value, setValue] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const save = useDebouncedSave(
    async (next: string) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", next);
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: string) {
    setValue(next);
    save.request(next);
  }

  async function onPickFile(file: File) {
    setUploadError("");
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError(uploadErrorText("too-large"));
      return;
    }
    setUploading(true);
    console.info("[admin image-upload] picked", {
      slot,
      name: file.name,
      bytes: file.size,
    });
    try {
      const form = new FormData();
      form.append("slot", slot);
      form.append("file", file);
      const resp = await fetch("/api/admin/uploads/image", {
        method: "POST",
        body: form,
      });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as { url: string };
      console.info("[admin image-upload] ok", { slot, url: data.url });
      // Fill the field AND persist right away — the admin shouldn't need a
      // second click after picking a file.
      update(data.url);
      save.flush();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[admin image-upload] failed", { slot, error: msg });
      setUploadError(uploadErrorText(msg));
    } finally {
      setUploading(false);
      // Reset so re-picking the same file fires the change event again.
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const showPreview = /^https?:\/\//.test(value.trim());

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="block text-[13px] font-semibold text-ink">
          {label}
        </label>
        <AutoSaveStatus state={save.state} detail={save.lastError ?? undefined} />
      </div>
      {hint && <p className="mb-2 text-[12px] text-muted">{hint}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <input
          type="url"
          value={value}
          onChange={(e) => update(e.target.value)}
          onBlur={save.flush}
          placeholder={placeholder}
          className="min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className={`rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent ${
            uploading ? "cursor-wait opacity-60" : ""
          }`}
        >
          {uploading ? "Uploading…" : "Upload image"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickFile(f);
          }}
        />
      </div>
      {uploadError && (
        <p className="mt-2 text-[12px] text-danger">{uploadError}</p>
      )}
      {showPreview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={value.trim()}
          alt=""
          className="mt-3 max-h-32 rounded-lg border border-line bg-surface2 object-contain"
        />
      )}
    </div>
  );
}
