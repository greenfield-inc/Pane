import { TerminalSquare } from 'lucide-react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';

interface RemoteSessionListProps {
  session: Session | null;
  panels: ToolPanel[];
  onCreateTerminal: () => void;
}

export function RemoteSessionList({
  session,
  panels,
  onCreateTerminal,
}: RemoteSessionListProps) {
  if (!session) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md text-center">
          <h2 className="text-lg font-semibold text-text-primary">Select a remote pane</h2>
          <p className="mt-2 text-sm text-text-secondary">Choose a pane from the sidebar to view its terminal panels.</p>
        </div>
      </div>
    );
  }

  if (panels.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md rounded-lg border border-border-primary bg-surface-primary p-6 text-center">
          <TerminalSquare className="mx-auto mb-3 h-8 w-8 text-interactive" />
          <h2 className="text-lg font-semibold text-text-primary">No terminal panels</h2>
          <p className="mt-2 text-sm text-text-secondary">Create a terminal on the remote host to start working from this browser.</p>
          <button
            type="button"
            onClick={onCreateTerminal}
            className="needs-full-access pane-press pane-press-touch mt-4 rounded-md bg-interactive px-4 py-2 text-sm font-semibold text-text-on-interactive hover:bg-interactive-hover"
          >
            New Terminal
          </button>
        </div>
      </div>
    );
  }

  return null;
}
