"use client";

// Drives the existing-media WebP backfill: walks the three tables that hold
// image URLs (stories, articles, short_renders), looping /api/admin/compress/run
// per table with the returned cursor until each is done. Dry run first (no
// writes), then the real pass behind a confirm. Stop aborts; failures are listed.

import { useRef, useState } from "react";

const TABLES = ["stories", "articles", "short_renders"] as const;

interface BatchResult {
  table: string;
  nextCursor: string | null;
  done: boolean;
  rows: number;
  compressed: number;
  skipped: number;
  bytesBefore: number;
  bytesAfter: number;
  failures: Array<{ url: string; error: string }>;
  error?: string;
}

interface Totals {
  rows: number;
  compressed: number;
  skipped: number;
  before: number;
  after: number;
}

const ZERO: Totals = { rows: 0, compressed: 0, skipped: 0, before: 0, after: 0 };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function CompressClient() {
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"idle" | "dry" | "real">("idle");
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [table, setTable] = useState<string | null>(null);
  const [failures, setFailures] = useState<Array<{ url: string; error: string }>>(
    [],
  );
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
        "Compress all existing images to WebP and repoint the database URLs? " +
          "Additive (the original files are kept) and resumable. Continue?",
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
    const fails: Array<{ url: string; error: string }> = [];
    setTotals(acc);
    setFailures(fails);

    try {
      outer: for (const tbl of TABLES) {
        setTable(tbl);
        let cursor: string | null = null;
        for (;;) {
          if (stopRef.current) break outer;
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          let res: Response;
          try {
            res = await fetch("/api/admin/compress/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "same-origin",
              signal: ctrl.signal,
              body: JSON.stringify({ table: tbl, cursor, dryRun, batchSize: 10 }),
            });
          } catch (e) {
            if (
              stopRef.current ||
              (e instanceof DOMException && e.name === "AbortError")
            ) {
              break outer;
            }
            throw e;
          }
          const data = (await res.json().catch(() => null)) as BatchResult | null;
          if (!res.ok || !data) {
            setError(data?.error ?? `Request failed (HTTP ${res.status}).`);
            break outer;
          }
          acc.rows += data.rows;
          acc.compressed += data.compressed;
          acc.skipped += data.skipped;
          acc.before += data.bytesBefore;
          acc.after += data.bytesAfter;
          for (const f of data.failures) fails.push(f);
          setTotals({ ...acc });
          setFailures([...fails]);
          cursor = data.nextCursor;
          if (data.done) break;
        }
      }
      if (!stopRef.current) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (stopRef.current) setStopped(true);
    abortRef.current = null;
    setRunning(false);
    setTable(null);
  }

  function stop() {
    stopRef.current = true;
    abortRef.current?.abort();
  }

  const saved = totals.before - totals.after;
  const ratio = totals.after > 0 ? totals.before / totals.after : 0;

  return (
    <div className="mt-6 space-y-5">
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
          {running && mode === "real" ? "Compressing…" : "Compress to WebP"}
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
            <span>rows: {totals.rows}</span>
            <span className="text-high">
              {mode === "dry" ? "to compress" : "compressed"}: {totals.compressed}
            </span>
            <span className="text-muted">skipped: {totals.skipped}</span>
            {mode === "real" && totals.before > 0 && (
              <span className="text-high">
                saved {fmtBytes(saved)} ({ratio.toFixed(1)}×)
              </span>
            )}
            {failures.length > 0 && (
              <span className="text-danger">failed: {failures.length}</span>
            )}
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-wider text-muted">
            {running
              ? `${mode === "dry" ? "Scanning" : "Compressing"} ${table ?? ""}… (Stop anytime)`
              : stopped
                ? "Stopped."
                : done
                  ? mode === "dry"
                    ? `Dry run complete. ${totals.compressed} image(s) would compress.`
                    : `Done. ${totals.compressed} image(s) compressed${totals.before > 0 ? `, ${fmtBytes(saved)} saved` : ""}.`
                  : "Stopped."}
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-line bg-surface p-3 text-sm text-danger">
          {error}
        </p>
      )}

      {failures.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-3" open>
          <summary className="cursor-pointer text-sm text-danger">
            {failures.length} failure(s) — re-run to retry
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-muted">
            {failures.slice(0, 100).map((f, i) => (
              <li key={`${f.url}-${i}`}>
                {f.url}: {f.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
