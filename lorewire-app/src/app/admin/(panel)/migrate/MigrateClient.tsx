"use client";

// Drives the GCS -> R2 migration from the browser: loops /api/admin/migrate/run
// with the returned cursor until done (or until Stop), accumulating live totals
// so the admin sees progress instead of a spinner.
//
// "Only referenced media" (default on) copies just what the database points at
// and skips the orphaned generation cruft that dominates the bucket. Dry run
// first (no writes), then the real copy behind a confirm. Stop aborts the
// in-flight batch and halts the loop. Failures and too-large objects are listed
// so nothing is silently dropped.

import { useRef, useState } from "react";

interface ItemResult {
  key: string;
  size: number;
  status:
    | "copied"
    | "skipped-present"
    | "skipped-orphan"
    | "too-large"
    | "failed"
    | "would-copy";
  error?: string;
}

interface BatchResult {
  nextCursor: string | null;
  done: boolean;
  items: ItemResult[];
  error?: string;
}

interface Totals {
  seen: number;
  copied: number;
  skipped: number;
  orphan: number;
  tooLarge: number;
  failed: number;
  wouldCopy: number;
  bytes: number; // every object seen
  copyBytes: number; // only what would copy / did copy
}

const ZERO: Totals = {
  seen: 0,
  copied: 0,
  skipped: 0,
  orphan: 0,
  tooLarge: 0,
  failed: 0,
  wouldCopy: 0,
  bytes: 0,
  copyBytes: 0,
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function MigrateClient() {
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"idle" | "dry" | "real">("idle");
  const [referencedOnly, setReferencedOnly] = useState(true);
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [failures, setFailures] = useState<ItemResult[]>([]);
  const [tooLarge, setTooLarge] = useState<ItemResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [stopped, setStopped] = useState(false);

  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  async function run(dryRun: boolean) {
    if (running) return;
    if (
      !dryRun &&
      !window.confirm(
        (referencedOnly
          ? "Copy the referenced (live) media from GCS to R2 now? "
          : "Copy ALL media from GCS to R2 now? ") +
          "Additive (GCS untouched) and resumable. Continue?",
      )
    ) {
      return;
    }

    setRunning(true);
    setMode(dryRun ? "dry" : "real");
    setError(null);
    setDone(false);
    setStopped(false);
    stopRef.current = false;
    const acc: Totals = { ...ZERO };
    const fails: ItemResult[] = [];
    const bigs: ItemResult[] = [];
    setTotals(acc);
    setFailures(fails);
    setTooLarge(bigs);

    let cursor: string | null = null;
    try {
      for (;;) {
        if (stopRef.current) break;
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        let res: Response;
        try {
          res = await fetch("/api/admin/migrate/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            signal: ctrl.signal,
            body: JSON.stringify({ cursor, dryRun, referencedOnly, batchSize: 15 }),
          });
        } catch (e) {
          // A Stop aborts the in-flight fetch — that's expected, not an error.
          if (
            stopRef.current ||
            (e instanceof DOMException && e.name === "AbortError")
          ) {
            break;
          }
          throw e;
        }
        const data = (await res.json().catch(() => null)) as BatchResult | null;
        if (!res.ok || !data) {
          setError(data?.error ?? `Request failed (HTTP ${res.status}).`);
          break;
        }
        for (const it of data.items) {
          acc.seen += 1;
          acc.bytes += it.size;
          if (it.status === "copied") {
            acc.copied += 1;
            acc.copyBytes += it.size;
          } else if (it.status === "skipped-present") acc.skipped += 1;
          else if (it.status === "skipped-orphan") acc.orphan += 1;
          else if (it.status === "too-large") {
            acc.tooLarge += 1;
            bigs.push(it);
          } else if (it.status === "failed") {
            acc.failed += 1;
            fails.push(it);
          } else if (it.status === "would-copy") {
            acc.wouldCopy += 1;
            acc.copyBytes += it.size;
          }
        }
        setTotals({ ...acc });
        setFailures([...fails]);
        setTooLarge([...bigs]);
        cursor = data.nextCursor;
        if (data.done) {
          setDone(true);
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (stopRef.current) setStopped(true);
    abortRef.current = null;
    setRunning(false);
  }

  function stop() {
    stopRef.current = true;
    abortRef.current?.abort();
  }

  const egressUsd = ((totals.copyBytes / (1024 * 1024 * 1024)) * 0.12).toFixed(2);

  return (
    <div className="mt-6 space-y-5">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={referencedOnly}
          disabled={running}
          onChange={(e) => setReferencedOnly(e.target.checked)}
        />
        Only referenced media (skip orphaned generation leftovers)
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={running}
          className="rounded-lg border border-ink px-4 py-2 text-sm font-medium text-ink hover:bg-ink hover:text-bg disabled:opacity-50"
        >
          {running && mode === "dry" ? "Scanning…" : "Dry run"}
        </button>
        <button
          type="button"
          onClick={() => run(false)}
          disabled={running}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-50"
        >
          {running && mode === "real" ? "Migrating…" : "Migrate to R2"}
        </button>
        {running && (
          <button
            type="button"
            onClick={stop}
            className="rounded-lg border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger hover:text-bg"
          >
            Stop
          </button>
        )}
      </div>

      {mode !== "idle" && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[13px] text-ink sm:grid-cols-3">
            <span>scanned: {totals.seen}</span>
            <span className="text-muted">{fmtBytes(totals.bytes)} total</span>
            {referencedOnly && (
              <span className="text-muted">skipped orphan: {totals.orphan}</span>
            )}
            {mode === "dry" ? (
              <span className="text-high">
                to copy: {totals.wouldCopy} ({fmtBytes(totals.copyBytes)})
              </span>
            ) : (
              <>
                <span className="text-high">copied: {totals.copied}</span>
                <span className="text-muted">present: {totals.skipped}</span>
              </>
            )}
            {totals.tooLarge > 0 && (
              <span className="text-warn">too large: {totals.tooLarge}</span>
            )}
            {totals.failed > 0 && (
              <span className="text-danger">failed: {totals.failed}</span>
            )}
          </div>

          <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-muted">
            {running
              ? mode === "dry"
                ? "Scanning the bucket… (Stop anytime)"
                : "Copying… keep this tab open. (Stop anytime)"
              : stopped
                ? "Stopped."
                : done
                  ? mode === "dry"
                    ? `Dry run complete. ${totals.wouldCopy} object(s) ≈ ${fmtBytes(totals.copyBytes)} would copy (one-time GCS egress ≈ $${egressUsd}).`
                    : totals.failed
                      ? "Done with failures — re-run to retry (copied objects are skipped)."
                      : "Migration complete."
                  : "Stopped."}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-line bg-surface p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {tooLarge.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-3">
          <summary className="cursor-pointer text-sm text-warn">
            {tooLarge.length} object(s) too large for the in-browser copy — run
            the CLI for these (python -m pipeline.migrate_gcs_to_r2)
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted">
            {tooLarge.slice(0, 100).map((i) => (
              <li key={i.key}>
                {i.key} ({fmtBytes(i.size)})
              </li>
            ))}
          </ul>
        </details>
      )}

      {failures.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-3" open>
          <summary className="cursor-pointer text-sm text-danger">
            {failures.length} failure(s) — re-run to retry
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted">
            {failures.slice(0, 100).map((i) => (
              <li key={i.key}>
                {i.key}: {i.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
