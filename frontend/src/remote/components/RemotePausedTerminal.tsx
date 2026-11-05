import { Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TerminalPausedMark } from '../../../../shared/types/panels';
import { PausedGlyph } from '../../components/ui/AgentStatusDot';
import { pausedLabel } from '../../utils/pause';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

/** Lines of the saved screen to show under the bar. */
const SCREEN_LINES = 300;

/**
 * A paused terminal tab: the desktop's "Paused … · last screen" bar with Resume, over the
 * tab's saved last screen, dimmed. It starts nothing on the host; only Resume does.
 */
export function RemotePausedTerminal({ adapter, panelId, mark }: {
  adapter: RemoteRuntimeAdapter;
  panelId: string;
  mark: TerminalPausedMark;
}) {
  const [screen, setScreen] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    adapter.getPanelScreen(panelId, SCREEN_LINES)
      .then(result => { if (!cancelled) setScreen(result.text); })
      .catch(() => { if (!cancelled) setScreen(''); });
    return () => { cancelled = true; };
  }, [adapter, panelId]);

  // The last lines matter most, as on a live terminal.
  useEffect(() => {
    const element = screenRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [screen]);

  const resume = () => {
    setResuming(true);
    setError(null);
    // The host's panel update swaps this view for the live terminal.
    adapter.resumePanel(panelId)
      .catch((cause: Error) => setError(cause.message || 'The tab did not resume.'))
      .finally(() => setResuming(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#010409]" data-testid="remote-paused-terminal">
      <div className="flex min-h-[34px] shrink-0 items-center gap-2 border-b border-border-primary bg-surface-secondary py-1 pl-3.5 pr-1.5 text-[12.5px] text-text-secondary">
        <PausedGlyph size="sm" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <b className="font-semibold text-text-primary">{pausedLabel(mark)}</b>
          <span className="text-text-tertiary"> · last screen</span>
          {error && <span role="alert" className="ml-2 text-status-error">{error}</span>}
        </span>
        <button
          type="button"
          onClick={resume}
          disabled={resuming}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md bg-interactive px-3 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-60 md:h-7"
        >
          <Play className="h-3 w-3 fill-current" aria-hidden="true" />
          Resume
        </button>
      </div>
      <pre
        ref={screenRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-2 pt-2 font-mono text-[13px] leading-[1.35] text-[#e6edf3] opacity-60"
      >
        {screen === null ? '' : screen || 'No saved screen.'}
      </pre>
    </div>
  );
}
