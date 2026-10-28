import { useEffect, useReducer, useState } from 'react';
import { AlertCircle, Globe } from 'lucide-react';
import type { ToolPanel } from '../../../shared/types/panels';
import { useListeningPorts } from '../hooks/useListeningPorts';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { livePreviewPortFor, muteLivePreview, openLivePreview, recordLivePreviewShown } from '../utils/livePreviewPrompt';
import { Button } from './ui/Button';

interface LivePreviewToastProps {
  port: number;
  /** Why the last "Open preview" failed; the toast keeps its size and offers a retry. */
  failure: string | null;
  opening: boolean;
  onOpen: () => void;
  onNotNow: () => void;
}

/** "Dev server on :5173" with Not now / Open preview, anchored to the bottom right of the Pane's panels. */
export function LivePreviewToast({ port, failure, opening, onOpen, onNotNow }: LivePreviewToastProps) {
  return (
    <div
      role={failure ? 'alert' : 'status'}
      className="absolute bottom-4 right-4 z-20 w-[300px] max-w-[calc(100%-2rem)] rounded-lg border border-border-primary bg-surface-primary p-3 text-[13px] shadow-dropdown-enhanced animate-dropdown-enter-up"
    >
      <div className="flex items-center gap-2 font-semibold text-text-primary">
        <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          {failure ? <AlertCircle className="h-4 w-4 text-status-error" /> : <Globe className="h-4 w-4 text-interactive" />}
        </span>
        {/* Wraps rather than truncates, so a narrow window still shows the port. */}
        <span className="min-w-0">{failure ? "Preview didn't open" : `Dev server on :${port}`}</span>
      </div>
      <p className="mt-1 truncate text-text-secondary" title={failure ?? undefined}>
        {failure ? `Try again, or pick :${port} from the + menu.` : 'Open a live preview next to this agent?'}
      </p>
      {failure && <span className="sr-only">{failure}</span>}
      {/* Pressing a button keeps focus where it was, so typing into the terminal carries on. */}
      <div className="mt-3 flex flex-wrap justify-end gap-2" onMouseDown={event => event.preventDefault()}>
        <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={onNotNow}>Not now</Button>
        <Button variant="primary" size="sm" className="whitespace-nowrap" onClick={onOpen} disabled={opening}>
          {failure ? 'Try again' : 'Open preview'}
        </Button>
      </div>
    </div>
  );
}

interface LivePreviewPromptProps {
  paneId: string;
  projectId: number;
  panels: readonly ToolPanel[];
}

/**
 * Offers a preview of a web server the Pane on screen started. Derived from the Pane's ports and
 * tabs on every render, so it follows the Pane and leaves when the server stops or a tab shows it.
 * Mount it keyed by Pane so a failure stays with the Pane it happened in.
 */
export function LivePreviewPrompt({ paneId, projectId, panels }: LivePreviewPromptProps) {
  const ports = useListeningPorts();
  const remote = useRemoteRuntimeState();
  // The prompt's memory lives outside React; answering it re-renders through this.
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [failure, setFailure] = useState<{ port: number; message: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const viewingRemoteHost = !remote.connectionKnown || remote.connectionState.mode === 'remote';
  const port = livePreviewPortFor({ paneId, projectId, ports, panels, viewingRemoteHost });

  useEffect(() => {
    if (port !== null) recordLivePreviewShown(paneId, port);
  }, [paneId, port]);

  if (port === null) return null;

  const open = async () => {
    setOpening(true);
    const outcome = await openLivePreview(paneId, port);
    setOpening(false);
    setFailure(outcome.kind === 'failed' ? { port, message: outcome.message } : null);
    rerender();
  };

  return (
    <LivePreviewToast
      port={port}
      failure={failure?.port === port ? failure.message : null}
      opening={opening}
      onOpen={() => { void open(); }}
      onNotNow={() => { muteLivePreview(projectId); rerender(); }}
    />
  );
}
