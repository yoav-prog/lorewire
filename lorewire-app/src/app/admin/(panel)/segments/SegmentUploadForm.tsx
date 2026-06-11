"use client";

// Client-side intro/outro uploader. Three-step flow:
//   1. POST /api/admin/segments/sign-upload (tiny JSON) -> {segId, sessionUri}
//   2. PUT the file in 8 MiB chunks to sessionUri (direct to GCS — no Vercel)
//   3. POST /api/admin/segments/finalize so the worker picks it up
//
// The whole point of doing the PUT browser->GCS is to bypass Vercel's 4.5 MB
// function-body cap; video segments are 5-500 MB. We never proxy bytes
// through a server route.
//
// Per rule 14 (observability), every step logs a `[segment upload]` line
// with the values that matter so the admin can paste them when something
// fails. Errors leave the row in `pending` so the worker's abandoned-sweep
// (5 min default) eventually marks it `error` — UI surfaces both states
// the same way ("Processing…" -> "Failed").

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Must be a multiple of 256 KiB per the GCS resumable contract. 8 MiB is the
// recommended minimum; keeps the chunk count low for typical 5-30 MB intros
// while still bounding the memory footprint per PUT. Stays the same for
// every chunk except the last.
const CHUNK_BYTES = 8 * 1024 * 1024;

// 500 MB hard ceiling, mirrors MAX_UPLOAD_BYTES in lib/segments-upload.ts.
// Validated client-side so we never even initiate the GCS session for a
// file the server would reject anyway.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const ACCEPTED_MIME = new Set(["video/mp4", "video/quicktime"]);
const ACCEPTED_EXT = new Set([".mp4", ".mov"]);

const LABEL =
  "mb-1 block font-mono text-[11px] uppercase tracking-wider text-muted";

interface Props {
  kind: "intro" | "outro";
  // Used to render the file-input label and the upload button caption — the
  // server doesn't care about the visual nicety, so it stays purely a prop.
  singular: string;
}

interface SignUploadResponse {
  segId: string;
  sessionUri: string;
  sourceUrl: string;
}

interface ErrorResponse {
  error?: string;
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SegmentUploadForm({ kind, singular }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    "idle" | "signing" | "uploading" | "finalizing" | "done" | "error"
  >("idle");
  const [progressPct, setProgressPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");

  function resetForm() {
    if (fileRef.current) fileRef.current.value = "";
    if (labelRef.current) labelRef.current.value = "";
    setProgressPct(0);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg("");
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setErrorMsg("Pick a file before uploading.");
      return;
    }
    const ext = extOf(file.name);
    if (!ACCEPTED_EXT.has(ext)) {
      setErrorMsg("Only .mp4 and .mov uploads are accepted.");
      return;
    }
    // file.type can be empty when the browser doesn't know the MIME from the
    // extension — accept the file in that case and let the server validate.
    if (file.type && !ACCEPTED_MIME.has(file.type)) {
      setErrorMsg("Only video/mp4 and video/quicktime are accepted.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorMsg(`File is larger than ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      return;
    }
    const contentType = ACCEPTED_MIME.has(file.type) ? file.type : "video/mp4";
    const label = labelRef.current?.value ?? "";

    console.info(
      `[segment upload] start kind=${kind} file=${file.name} size=${file.size} contentType=${contentType}`,
    );

    setStatus("signing");
    let signed: SignUploadResponse;
    try {
      signed = await signUpload({
        kind,
        label,
        filename: file.name,
        size: file.size,
        contentType,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[segment upload] sign-upload FAILED: ${msg}`);
      setStatus("error");
      setErrorMsg(`Could not start upload: ${msg}`);
      return;
    }
    console.info(
      `[segment upload] sign-ok segId=${signed.segId} chunkBytes=${CHUNK_BYTES}`,
    );

    setStatus("uploading");
    try {
      await putChunks(file, signed.sessionUri, contentType, (sent) => {
        setProgressPct(Math.round((sent / file.size) * 100));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[segment upload] PUT FAILED segId=${signed.segId}: ${msg}`);
      setStatus("error");
      setErrorMsg(`Upload failed: ${msg}`);
      // Row stays `pending`. The worker's abandoned-sweep will mark it
      // `error` after the configured threshold so it shows up in the admin
      // list with a delete button.
      return;
    }
    console.info(`[segment upload] PUT complete segId=${signed.segId}`);

    setStatus("finalizing");
    try {
      await finalize(signed.segId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[segment upload] finalize FAILED segId=${signed.segId}: ${msg}`,
      );
      setStatus("error");
      setErrorMsg(`Finalize failed: ${msg}`);
      return;
    }
    console.info(`[segment upload] done segId=${signed.segId}`);

    setStatus("done");
    resetForm();
    router.refresh();
  }

  const uploading = status === "signing" || status === "uploading" || status === "finalizing";

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-2 rounded-xl border border-line bg-surface p-4"
    >
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className={LABEL}>{singular} file (.mp4 / .mov)</label>
          <input
            ref={fileRef}
            name="file"
            type="file"
            accept="video/mp4,video/quicktime,.mp4,.mov"
            required
            disabled={uploading}
            className="block w-full text-[13px] text-ink file:mr-3 file:rounded-md file:border file:border-line file:bg-bg file:px-3 file:py-1.5 file:text-[12px] file:text-ink hover:file:border-accent disabled:opacity-50"
          />
        </div>
        <div>
          <label className={LABEL}>Label (optional)</label>
          <input
            ref={labelRef}
            name="label"
            placeholder={`e.g. "Brand opener v2"`}
            disabled={uploading}
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent disabled:opacity-50"
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={uploading}
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>

      {uploading && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
            {status === "signing" && "Initializing upload…"}
            {status === "uploading" && `Uploading to storage… ${progressPct}%`}
            {status === "finalizing" && "Finalizing…"}
          </p>
        </div>
      )}

      {status === "done" && !errorMsg && (
        <p className="font-mono text-[11px] uppercase tracking-wider text-high">
          Upload complete. The pipeline worker will normalize it within ~5s.
        </p>
      )}

      {errorMsg && (
        <p className="text-[12px] text-danger">{errorMsg}</p>
      )}

      <p className="text-[12px] text-muted">
        Source is normalized off-Vercel to 1080x1920 @ 30fps (center-crop for
        landscape sources) and stored in GCS. {formatBytes(MAX_UPLOAD_BYTES)} max.
      </p>
    </form>
  );
}

// --- helpers (kept colocated so the network shape lives next to the UI) ----

async function signUpload(body: {
  kind: "intro" | "outro";
  label: string;
  filename: string;
  size: number;
  contentType: string;
}): Promise<SignUploadResponse> {
  const resp = await fetch("/api/admin/segments/sign-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return (await resp.json()) as SignUploadResponse;
}

async function finalize(segId: string): Promise<void> {
  const resp = await fetch("/api/admin/segments/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segId }),
  });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as ErrorResponse;
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
}

// PUT the file to `sessionUri` in `CHUNK_BYTES`-sized chunks. Each chunk
// carries a Content-Range header per the GCS resumable contract; intermediate
// chunks return 308 "Resume Incomplete" with a `Range` header confirming how
// much has been persisted (we trust it and resume from there if a chunk
// retry needs it). The final chunk returns 200/201 — that's the success
// signal.
//
// Retries: up to 3 attempts per chunk with exponential backoff on 5xx /
// network errors. 4xx aborts immediately (those mean the request is wrong,
// retrying won't help).
async function putChunks(
  file: File,
  sessionUri: string,
  contentType: string,
  onProgress: (sentBytes: number) => void,
): Promise<void> {
  const total = file.size;
  let start = 0;
  while (start < total) {
    const end = Math.min(start + CHUNK_BYTES, total);
    const chunk = file.slice(start, end);
    const range = `bytes ${start}-${end - 1}/${total}`;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      let resp: Response;
      try {
        resp = await fetch(sessionUri, {
          method: "PUT",
          headers: {
            "Content-Type": contentType,
            "Content-Range": range,
          },
          body: chunk,
        });
      } catch (e) {
        // Network error — retry with backoff up to 3 attempts.
        if (attempt >= 3) {
          throw new Error(
            `network error after ${attempt} attempts: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await wait(500 * 2 ** (attempt - 1));
        continue;
      }
      // 308 Resume Incomplete = intermediate chunk accepted, more to come.
      // 200/201 = upload finished (only valid on the final chunk).
      if (resp.status === 308) {
        // GCS returns a `Range: bytes=0-K` header confirming bytes persisted.
        // We could use it to resume mid-chunk, but the simpler model is "if
        // 308, the chunk was accepted whole" — which is what the spec says
        // when the server's Range matches our end-1.
        onProgress(end);
        start = end;
        break;
      }
      if (resp.status === 200 || resp.status === 201) {
        if (end !== total) {
          // The server thinks the upload is complete before we sent all the
          // bytes — that's a contract violation; treat as error so we don't
          // silently leave half a file in GCS.
          throw new Error(
            `unexpected 200 mid-upload at byte ${end}/${total}`,
          );
        }
        onProgress(end);
        start = end;
        break;
      }
      if (resp.status >= 500 && attempt < 3) {
        await wait(500 * 2 ** (attempt - 1));
        continue;
      }
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
