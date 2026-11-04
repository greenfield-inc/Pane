import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { TerminalPausedMark } from '../../../../shared/types/panels';
import { DEFAULT_TERMINAL_FONT_SIZE } from '../../../../shared/types/appearance';
import { Button } from '../ui/Button';
import { useConfigStore } from '../../stores/configStore';
import { pausedLabel, pausedReason, runPauseAction } from '../../utils/pause';
import { buildTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from '../../utils/terminalTheme';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** Enough lines to fill a tall window; the view opens scrolled to the end. */
const LAST_SCREEN_LINES = 400;

const scrollbackSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.object({ content: boundary.string })),
});

/** The slim bar over a paused tab: when it paused, and Resume, which starts it again in its saved conversation. */
export function PausedBanner({ panelId, mark, detail }: { panelId: string; mark: TerminalPausedMark; detail?: string }) {
  const [resuming, setResuming] = useState(false);
  const reason = pausedReason(mark);
  return (
    <div
      role="status"
      title={reason ?? undefined}
      className="flex h-[34px] flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-secondary pl-3.5 pr-1.5 text-[12.5px] text-text-secondary"
    >
      <Pause aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-text-primary">{pausedLabel(mark)}</span>
        {detail && <span className="text-text-tertiary"> · {detail}</span>}
      </span>
      <Button
        type="button"
        size="sm"
        variant="primary"
        className="ml-auto h-6 flex-shrink-0 px-2.5 text-xs"
        loading={resuming}
        loadingText="Resuming"
        icon={<Play aria-hidden="true" className="h-3 w-3 fill-current" />}
        onClick={() => {
          setResuming(true);
          void runPauseAction({ kind: 'panel', id: panelId }, false).finally(() => setResuming(false));
        }}
      >
        Resume
      </Button>
    </div>
  );
}

/**
 * A paused terminal tab: its saved last screen, dimmed, under the paused banner. It never starts
 * the terminal; Resume does, and the tab then mounts its live terminal as usual.
 */
export function PausedTerminalView({ panelId, mark }: { panelId: string; mark: TerminalPausedMark }) {
  const [screen, setScreen] = useState<string | null>(null);
  const scrollRef = useRef<HTMLPreElement>(null);
  const fontFamily = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontSize = useConfigStore(state => state.config?.terminalFontSize) || DEFAULT_TERMINAL_FONT_SIZE;

  useEffect(() => {
    let disposed = false;
    void window.electronAPI.invoke('terminal:getScrollbackClean', panelId, LAST_SCREEN_LINES).then(
      response => {
        if (!disposed) setScreen(decodeOptionalBoundary(response, scrollbackSchema)?.data?.content ?? '');
      },
      () => { if (!disposed) setScreen(''); },
    );
    return () => { disposed = true; };
  }, [panelId, mark.at]);

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [screen]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-bg-primary" data-testid="paused-terminal-view">
      <PausedBanner panelId={panelId} mark={mark} detail="last screen" />
      <pre
        ref={scrollRef}
        aria-label="Last screen before the pause"
        className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre px-4 py-3 leading-[1.55] text-text-primary opacity-45"
        style={{ fontFamily: buildTerminalFontFamily(fontFamily), fontSize }}
      >
        {screen === '' ? <span className="text-text-tertiary">No output was saved before the pause.</span> : screen}
      </pre>
    </div>
  );
}
