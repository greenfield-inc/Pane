import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { closeFind, setFindQuery, stepFind, useFindBar, type FindBarState } from './findController';
import { NO_TEXT_MESSAGE, findBarControlKeyAction, findBarKeyAction, findCountLabel } from './findBarLogic';

interface FindBarProps {
  panelId: string;
  /** Position inside the tab's content area; the parent must be positioned. */
  className?: string;
}

const iconButton = 'h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle';

/** The Chrome-style find bar every searchable tab shows at its top right. */
export function FindBar({ panelId, className }: FindBarProps) {
  return <FindBarView panelId={panelId} className={className} bar={useFindBar(panelId)} />;
}

export function FindBarView({ panelId, className, bar }: FindBarProps & { bar: FindBarState }) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!bar.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [bar.open, bar.focusRequest]);

  if (!bar.open) return null;

  const noMatches = !bar.noText && bar.query !== '' && bar.result.total === 0;
  const canStep = !bar.noText && bar.result.total > 0;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = findBarKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing });
    if (!action) return;
    event.preventDefault();
    // The tab underneath (terminal, Logs) must not see these keys.
    event.stopPropagation();
    if (action === 'close') closeFind(panelId);
    else stepFind(panelId, action);
  };

  // Esc from a button (after clicking Next, or tabbing out of the input).
  // The input's own handler stops its keys before they get here.
  const handleControlKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!findBarControlKeyAction({ key: event.key, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    event.stopPropagation();
    closeFind(panelId);
  };

  return (
    <div
      role="search"
      aria-label="Find in tab"
      data-find-bar={panelId}
      onKeyDown={handleControlKeyDown}
      className={cn(
        // Never wider than the tab: a narrow split group shrinks the input.
        'absolute top-2 right-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-1 p-1 rounded-md border border-border-primary bg-surface-secondary shadow-dropdown-elevated',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Find"
        aria-disabled={bar.noText || undefined}
        aria-invalid={noMatches || undefined}
        data-find-input={panelId}
        readOnly={bar.noText}
        value={bar.noText ? '' : bar.query}
        placeholder={bar.noText ? NO_TEXT_MESSAGE : 'Find'}
        spellCheck={false}
        onChange={(event) => setFindQuery(panelId, event.target.value)}
        onKeyDown={handleKeyDown}
        className={cn(
          'h-6 w-48 min-w-0 shrink rounded border px-2 text-xs outline-none',
          'bg-surface-primary text-text-primary placeholder:text-text-tertiary border-border-primary focus:border-interactive',
          bar.noText && 'w-56 cursor-default text-ellipsis',
          noMatches && 'bg-status-warning/15 border-status-warning focus:border-status-warning',
        )}
      />
      <span aria-live="polite" className="w-[7.5rem] min-w-[3.5rem] shrink text-center truncate text-xs tabular-nums text-text-tertiary select-none">
        {findCountLabel(bar)}
      </span>
      <button
        type="button"
        className={iconButton}
        disabled={!canStep}
        aria-label="Previous match"
        title={`Previous match (${formatKeyDisplay('mod+shift+g')})`}
        onClick={() => stepFind(panelId, 'prev')}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={iconButton}
        disabled={!canStep}
        aria-label="Next match"
        title={`Next match (${formatKeyDisplay('mod+g')})`}
        onClick={() => stepFind(panelId, 'next')}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={iconButton}
        aria-label="Close find"
        title="Close (Esc)"
        onClick={() => closeFind(panelId)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
