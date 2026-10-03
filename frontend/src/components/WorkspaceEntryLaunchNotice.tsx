import type { WorkspaceEntryLaunchFailure } from '../stores/workspaceEntryStore';
import { Button } from './ui/Button';

interface WorkspaceEntryLaunchNoticeProps {
  failure: WorkspaceEntryLaunchFailure;
  onOpenAgent: () => void;
  onDismiss: () => void;
}

export function WorkspaceEntryLaunchNotice({ failure, onOpenAgent, onDismiss }: WorkspaceEntryLaunchNoticeProps) {
  return (
    <div
      role="status"
      aria-label="Agent launch failed"
      data-testid="workspace-entry-launch-notice"
      className="absolute inset-x-4 bottom-4 z-20 flex items-center justify-between gap-4 rounded-lg border border-status-warning/40 bg-surface-secondary px-4 py-3 shadow-lg"
    >
      <p className="min-w-0 text-sm text-text-secondary">
        Repository added, but <span className="font-medium text-text-primary">{failure.agentTitle}</span> could not start. {failure.message}
      </p>
      <div className="flex flex-shrink-0 items-center gap-2">
        <Button size="sm" onClick={onOpenAgent}>Open agent</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  );
}
