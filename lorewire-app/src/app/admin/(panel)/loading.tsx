// Shown the instant a panel nav click resolves while the server renders the
// real page. The shape mirrors the most common admin layout (title bar,
// stat row, content section) so the transition does not visibly jump.

function Block({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface2/60 ${className}`}
      aria-hidden
    />
  );
}

export default function PanelLoading() {
  return (
    <div className="space-y-7" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="space-y-2">
        <Block className="h-6 w-40" />
        <Block className="h-4 w-72" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Block className="h-20" />
        <Block className="h-20" />
        <Block className="h-20" />
        <Block className="h-20" />
      </div>

      <div className="space-y-2">
        <Block className="h-12" />
        <Block className="h-12" />
        <Block className="h-12" />
        <Block className="h-12" />
      </div>
    </div>
  );
}
