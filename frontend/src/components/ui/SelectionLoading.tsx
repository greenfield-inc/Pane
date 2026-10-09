/** Item-owned loading content: never mount a previous item's tools underneath. */
export function SelectionLoading({ name }: { name: string }) {
  return <div role="status" aria-live="polite" className="flex flex-1 flex-col gap-4 p-6 text-text-secondary">
    <span className="text-sm">Opening {name}…</span>
    <div aria-hidden="true" className="flex flex-col gap-3 animate-pulse">
      <div className="h-5 w-1/3 rounded bg-surface-secondary" />
      <div className="h-5 w-2/3 rounded bg-surface-secondary" />
      <div className="h-40 w-full rounded bg-surface-secondary" />
    </div>
  </div>;
}
