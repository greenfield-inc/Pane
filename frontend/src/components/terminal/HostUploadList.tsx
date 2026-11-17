import { X } from 'lucide-react';
import { formatBytes } from '../../../../shared/utils/formatBytes';
import type { HostUploadItem } from '../../hooks/useHostUploads';
import { describeUpload } from '../../utils/hostUpload';

/** One row per file still copying to the terminal's machine: name, bar, percent and time left, and a cancel button. */
export function HostUploadList({ items, onCancel }: { items: readonly HostUploadItem[]; onCancel: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="absolute bottom-3 right-3 z-[10002] flex w-72 max-w-[calc(100%-1.5rem)] flex-col gap-1.5" data-testid="host-upload-list">
      {items.map(({ id, name, progress }) => {
        const fraction = progress.totalBytes > 0 ? progress.receivedBytes / progress.totalBytes : 0;
        return (
          <div key={id} className="rounded-lg border border-border-primary bg-surface-primary/95 px-3 py-2 shadow-dropdown-elevated backdrop-blur-md"
            role="status" aria-label={`Copying ${name}: ${describeUpload(progress)}`}>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={name}>{name}</span>
              <button type="button" onClick={() => onCancel(id)} aria-label={`Cancel copying ${name}`} title="Cancel"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary">
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-tertiary">
              <div className="h-full bg-interactive" style={{ width: `${Math.floor(fraction * 100)}%` }} />
            </div>
            {/* One line at a fixed width: the status truncates instead of wrapping as its numbers change. */}
            <div className="mt-1 flex gap-2 text-[11px] tabular-nums text-text-tertiary">
              <span className="min-w-0 flex-1 truncate">{describeUpload(progress)}</span>
              <span className="flex-shrink-0">{formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
