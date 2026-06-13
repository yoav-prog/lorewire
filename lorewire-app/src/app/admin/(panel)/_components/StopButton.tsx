"use client";

// Per-row Stop button. Renders only when the queue row's status is
// transitional (queued or generating); on click, flips the row to
// 'cancelled' so the cron drain skips it and the worker discards any
// in-flight kie result.
//
// kie has no public cancel endpoint as of 2026-06-13, so this is a soft
// cancel: if a generation finishes server-side after we flip the row,
// the URL never gets written back. Saves DB + GCS work, may not save
// the kie credit.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  cancelImageRenderAction,
  type CancelImageRenderResult,
} from "@/app/admin/actions";

export function StopButton({
  renderId,
  label = "Stop",
}: {
  renderId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CancelImageRenderResult | null>(null);

  function fire() {
    setResult(null);
    startTransition(async () => {
      const r = await cancelImageRenderAction({ renderId });
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={fire}
        disabled={pending}
        className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Stopping…" : label}
      </button>
      {result && !result.ok && (
        <p className="text-[10px] text-danger">
          {result.error ?? "Stop failed"}
        </p>
      )}
    </div>
  );
}
