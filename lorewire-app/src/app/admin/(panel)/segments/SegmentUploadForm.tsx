"use client";

// Client-side intro/outro uploader. Two flows, decided by the `uploadMode`
// prop the server component sets based on whether `GCS_BUCKET` is configured:
//
//   gcs (prod and dev-with-GCS):
//     1. POST /api/admin/segments/sign-upload  -> {segId, sessionUri}
//     2. PUT file in 8 MiB chunks to sessionUri (direct to GCS — no Vercel)
//     3. POST /api/admin/segments/finalize     -> HEAD-checks GCS,
//                                                 worker picks the row up
//
//   local (dev without GCS):
//     1. POST multipart to /api/admin/segments/upload-local
//        which runs system ffmpeg inline and writes both source + normalized
//        copies under public/segments/. Row lands as `status='ready'`
//        immediately. No worker, no chunking, no progress beyond the
//        browser's upload progress (which we don't surface here — the
//        admin's `next dev` server is the same machine).
//
// The whole point of the GCS direct flow is to bypass Vercel's 4.5 MB
// function-body cap; video segments are 5-500 MB. We never proxy bytes
// through a Vercel function in prod.
//
// Per rule 14 (observability), every step logs a `[segment upload]` line
// with the values that matter so the admin can paste them when something
// fails.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AspectChipGroup } from "@/components/ui";
import {
  inferAspectFromDims,
  LEGACY_DEFAULT_ASPECT,
  type VideoAspect,
} from "@/lib/aspect";

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
  // 'gcs' = browser -> GCS resumable (prod, or dev with GCS_BUCKET set).
  // 'local' = browser -> /api/admin/segments/upload-local (dev without GCS).
  // Decided server-side in page.tsx; the form just branches on it.
  uploadMode: "gcs" | "local";
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

export function SegmentUploadForm({ kind, singular, uploadMode }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<
    "idle" | "signing" | "uploading" | "finalizing" | "done" | "error"
  >("idle");
  const [progressPct, setProgressPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  // Phase 4 of _plans/2026-06-12-video-aspect-ratio.md: the admin picks
  // which canvas shape this segment normalises to. Defaults to the legacy
  // 9:16 so every existing upload UX is unchanged; landscape stories now
  // have a way to source a matching intro/outro.
  const [aspect, setAspect] = useState<VideoAspect>(LEGACY_DEFAULT_ASPECT);
  // Auto-detected aspect from the picked file's video metadata (2026-06-14
  // plan: stop silently uploading 16:9 sources with the chip stuck at
  // 9:16). null = no file picked yet OR browser couldn't decode the
  // metadata; the server's ffprobe override is the final safety net
  // either way.
  const [detectedAspect, setDetectedAspect] = useState<VideoAspect | null>(null);
  const [detectedDims, setDetectedDims] = useState<{
    width: number;
    height: number;
  } | null>(null);

  function resetForm() {
    if (fileRef.current) fileRef.current.value = "";
    if (labelRef.current) labelRef.current.value = "";
    setProgressPct(0);
    setDetectedAspect(null);
    setDetectedDims(null);
  }

  // Probe the picked file's video metadata in the browser so the aspect
  // chip auto-flips to match. Pure side-effect — runs once per file pick
  // and revokes its blob URL on success OR after a 5s safety timeout so
  // a forgotten loadedmetadata event can't leak the handle.
  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setDetectedAspect(null);
    setDetectedDims(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };
    const timeout = window.setTimeout(() => {
      console.info(
        "[segment upload aspect] probe timeout — server probe will still verify",
      );
      cleanup();
    }, 5000);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      const w = video.videoWidth;
      const h = video.videoHeight;
      const detected = inferAspectFromDims(w, h);
      setDetectedAspect(detected);
      setDetectedDims({ width: w, height: h });
      setAspect(detected);
      console.info("[segment upload aspect] detected", {
        width: w,
        height: h,
        aspect: detected,
      });
      cleanup();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      console.info(
        "[segment upload aspect] browser could not decode metadata — server probe will catch it",
      );
      cleanup();
    };
    video.src = url;
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
      `[segment upload] start mode=${uploadMode} kind=${kind} file=${file.name} size=${file.size} contentType=${contentType}`,
    );

    if (uploadMode === "local") {
      // Dev-only: multipart POST to upload-local. The handler runs ffmpeg
      // inline and writes to public/segments/, so the response either says
      // ready immediately or carries the failure reason.
      setStatus("uploading");
      try {
        const fd = new FormData();
        fd.append("kind", kind);
        fd.append("label", label);
        fd.append("aspect", aspect);
        fd.append("file", file);
        const resp = await fetch("/api/admin/segments/upload-local", {
          method: "POST",
          body: fd,
        });
        const data = (await resp.json().catch(() => ({}))) as {
          segId?: string;
          status?: string;
          error?: string;
        };
        if (!resp.ok || data.status !== "ready") {
          throw new Error(data.error || `HTTP ${resp.status}`);
        }
        console.info(
          `[segment upload] upload-local ok segId=${data.segId}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[segment upload] upload-local FAILED: ${msg}`);
        setStatus("error");
        setErrorMsg(`Upload failed: ${msg}`);
        return;
      }
      setStatus("done");
      resetForm();
      router.refresh();
      return;
    }

    setStatus("signing");
    let signed: SignUploadResponse;
    try {
      signed = await signUpload({
        kind,
        label,
        filename: file.name,
        size: file.size,
        contentType,
        aspect,
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
    // GCS does not include Access-Control-Allow-Origin on the actual PUT
    // response (only on the preflight), so Chrome rejects the 200 OK and
    // `fetch` throws "Failed to fetch" even when bytes successfully landed
    // in the bucket. We can't tell from the client which case we're in —
    // so we always call finalize, which HEAD-checks GCS authoritatively.
    let putError: Error | null = null;
    try {
      await putChunks(file, signed.sessionUri, contentType, (sent) => {
        setProgressPct(Math.round((sent / file.size) * 100));
      });
      console.info(`[segment upload] PUT complete segId=${signed.segId}`);
    } catch (e) {
      putError = e instanceof Error ? e : new Error(String(e));
      console.warn(
        `[segment upload] PUT threw segId=${signed.segId}: ${putError.message} ` +
          `(may still have succeeded — finalize will HEAD-check GCS)`,
      );
    }

    setStatus("finalizing");
    let finalizeResult: { status?: string; error?: string };
    try {
      finalizeResult = await finalize(signed.segId, putError === null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[segment upload] finalize FAILED segId=${signed.segId}: ${msg}`,
      );
      setStatus("error");
      setErrorMsg(
        putError
          ? `Upload failed: ${putError.message}`
          : `Finalize failed: ${msg}`,
      );
      return;
    }
    console.info(
      `[segment upload] finalize ok segId=${signed.segId} status=${finalizeResult.status}`,
    );

    if (finalizeResult.status === "error") {
      setStatus("error");
      setErrorMsg(
        `Upload failed: ${finalizeResult.error ?? "bytes did not reach GCS"}`,
      );
      router.refresh();
      return;
    }

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
            onChange={handleFileChange}
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

      <div>
        <label className={LABEL}>Aspect</label>
        <AspectChipGroup
          value={aspect}
          onChange={setAspect}
          ariaLabel="Segment aspect"
          disabled={uploading}
        />
        <AspectDetectionNote
          detectedAspect={detectedAspect}
          detectedDims={detectedDims}
          currentAspect={aspect}
        />
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
          {uploadMode === "gcs"
            ? "Upload complete. The pipeline worker will normalize it within ~5s."
            : "Upload complete. Ready to splice."}
        </p>
      )}

      {errorMsg && (
        <p className="text-[12px] text-danger">{errorMsg}</p>
      )}

      <p className="text-[12px] text-muted">
        {uploadMode === "gcs"
          ? `Source is normalized off-Vercel to 1080x1920 @ 30fps (center-crop for landscape sources) and stored in GCS. ${formatBytes(MAX_UPLOAD_BYTES)} max.`
          : `Local dev (no GCS): source is normalized inline by system ffmpeg and written to public/segments/. ${formatBytes(MAX_UPLOAD_BYTES)} max.`}
      </p>
    </form>
  );
}

// Sub-component: live status under the aspect chip. Three states, in
// priority order:
//   1. no file picked yet         -> the original "must match" reminder
//   2. detected and chip matches  -> "Detected 16:9 from file metadata"
//   3. detected and chip differs  -> warn that letterboxing will result
// The server probe still backs all of this up — see segments_worker.py.
function AspectDetectionNote({
  detectedAspect,
  detectedDims,
  currentAspect,
}: {
  detectedAspect: VideoAspect | null;
  detectedDims: { width: number; height: number } | null;
  currentAspect: VideoAspect;
}) {
  if (detectedAspect === null) {
    return (
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        Must match the story it ships with. Mismatched segments are dropped at render time.
      </p>
    );
  }
  const dimsLabel = detectedDims
    ? ` (${detectedDims.width}×${detectedDims.height})`
    : "";
  if (detectedAspect === currentAspect) {
    return (
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-accent">
        Detected {detectedAspect}{dimsLabel} from file metadata.
      </p>
    );
  }
  return (
    <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-warn">
      File is {detectedAspect}{dimsLabel}; uploading as {currentAspect} will letterbox or crop. The server will re-check on normalize.
    </p>
  );
}

// --- helpers (kept colocated so the network shape lives next to the UI) ----

async function signUpload(body: {
  kind: "intro" | "outro";
  label: string;
  filename: string;
  size: number;
  contentType: string;
  aspect: VideoAspect;
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

async function finalize(
  segId: string,
  clientReportedOk: boolean,
): Promise<{ status?: string; error?: string }> {
  const resp = await fetch("/api/admin/segments/finalize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segId, clientReportedOk }),
  });
  // 502 here means "no bytes in GCS — the upload genuinely failed". The
  // server already wrote status='error' to the row; we surface its body
  // to the caller so the UI can render the message.
  const data = (await resp.json().catch(() => ({}))) as {
    status?: string;
    error?: string;
  };
  if (!resp.ok && resp.status !== 502) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }
  return data;
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
