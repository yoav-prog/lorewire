// Originality summary for clean-room stories (CONTENT_POLICY.md). Blockers are
// computed live against the current text, so an edit that fixes a problem clears
// it on the next page load. Renders nothing for older stories and submissions.

import { getStoryOriginality } from "@/lib/content-compliance-gate";

const HEADING = "font-mono text-[11px] uppercase tracking-wider text-muted";

export async function OriginalityPanel({ storyId }: { storyId: string }) {
  const originality = await getStoryOriginality(storyId);
  if (!originality) return null;
  const { premise, sourceTitle, sourceUrl, blockers, advisory, semanticChecksRan } =
    originality;
  return (
    <section className="mb-5 space-y-3 rounded-lg border border-line bg-surface p-4 text-[14px] text-ink">
      <p className="font-semibold">
        {blockers.length > 0
          ? "Originality: blocked from publishing"
          : "Originality: clear to publish"}
      </p>
      {blockers.length > 0 && (
        <div>
          <p className={HEADING}>Fix these first</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {blockers.map((b) => (
              <li key={`${b.check}:${b.detail}`}>{b.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {advisory.length > 0 && (
        <div>
          <p className={HEADING}>Worth a human look</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {advisory.map((a) => (
              <li key={`${a.check}:${a.detail}`}>{a.detail}</li>
            ))}
          </ul>
        </div>
      )}
      {!semanticChecksRan && (
        <p className="text-muted">
          The similarity checks did not run for this story.
        </p>
      )}
      {premise && (
        <div>
          <p className={HEADING}>Premise</p>
          <p className="mt-1">{premise}</p>
        </div>
      )}
      {sourceUrl && (
        <div>
          <p className={HEADING}>Source (internal only)</p>
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate underline"
          >
            {sourceTitle || sourceUrl}
          </a>
        </div>
      )}
    </section>
  );
}
