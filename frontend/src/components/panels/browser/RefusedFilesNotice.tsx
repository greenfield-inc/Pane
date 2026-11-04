import React, { useState } from 'react';
import { ChevronDown, CircleAlert, X } from 'lucide-react';
import { cn } from '../../../utils/cn';

export interface FileRefusal {
  message: string;
  next?: string;
}

interface RefusedFilesNoticeProps {
  refusals: FileRefusal[];
  onDismiss: () => void;
}

/** One quiet line for files a loaded page asked for and did not get; expands to say which and why. */
export const RefusedFilesNotice: React.FC<RefusedFilesNoticeProps> = ({ refusals, onDismiss }) => {
  const [expanded, setExpanded] = useState(false);
  const nextSteps = [...new Set(refusals.flatMap(refusal => (refusal.next ? [refusal.next] : [])))];
  const count = refusals.length;

  return (
    <div role="status" className="border-b border-border-primary bg-bg-primary text-xs text-text-secondary">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded(open => !open)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-text-primary"
        >
          <CircleAlert className="h-3.5 w-3.5 flex-shrink-0 text-status-warning" />
          <span className="truncate">
            {count === 1 ? "1 file wasn't loaded" : `${count} files weren't loaded`} (outside this page's folder)
          </span>
          <ChevronDown className={cn('h-3 w-3 flex-shrink-0 transition-transform', expanded && 'rotate-180')} />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 rounded p-0.5 hover:bg-surface-hover hover:text-text-primary"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="max-h-40 space-y-1 overflow-y-auto px-2 pb-1.5 pl-7 select-text">
          {refusals.map(refusal => <p key={refusal.message} className="break-words">{refusal.message}</p>)}
          {nextSteps.map(step => <p key={step} className="text-text-primary">Next: {step}</p>)}
        </div>
      )}
    </div>
  );
};
