import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react';
import type { ToolPanel } from '../../../../../../shared/types/panels';
import { cn } from '../../../../utils/cn';
import { normalizeUrl } from '../browserUrl';
import { BrowserStreamView, stopLine } from './BrowserStreamView';
import { streamClient } from './streamClient';
import { useBrowserStream } from './useBrowserStream';

/**
 * A browser tab on a desktop showing another computer's Pane: the page runs on that computer, with
 * its sign-ins, and this desktop draws its frames and sends input back (docs/BROWSER_AGENTS.md).
 * A host on an older Pane streams nothing: `ownCopy` then renders this desktop's own copy.
 */
export function StreamedBrowserPanel({ panel, isActive, ownCopy }: { panel: ToolPanel; isActive: boolean; ownCopy: () => ReactNode }) {
  const client = useMemo(() => streamClient((channel, ...args) => window.electronAPI.invoke(channel, ...args)), []);
  const stream = useBrowserStream(client, panel.id, isActive);
  const view = stream.view;
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState('');
  const host = view?.host ?? 'the host';

  if (stream.stop === 'older') {
    return (
      <div className="flex h-full flex-col">
        <p role="status" className="border-b border-border-primary bg-bg-chrome px-3 py-1 text-xs text-text-tertiary">{stopLine('older', host)}</p>
        <div className="min-h-0 flex-1">{ownCopy()}</div>
      </div>
    );
  }

  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeUrl(typed ?? view?.url ?? '');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not web');
    } catch {
      setError('Enter a valid http or https URL');
      return;
    }
    setError('');
    setTyped(null);
    void client.input(panel.id, [{ kind: 'navigate', url }]);
  };
  const history = (to: 'back' | 'forward' | 'reload') => void client.input(panel.id, [{ kind: 'history', go: to }]);
  const button = 'p-1 rounded enabled:hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div className="flex h-full flex-col bg-bg-primary" data-browser-streamed={panel.id}>
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-border-primary bg-bg-chrome px-2 py-1.5">
        <button type="button" className={button} disabled={!view?.canGoBack} onClick={() => history('back')} title="Back"><ArrowLeft className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} disabled={!view?.canGoForward} onClick={() => history('forward')} title="Forward"><ArrowRight className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} disabled={!view?.url} onClick={() => history('reload')} title="Refresh">
          {view?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
        </button>
        <form onSubmit={go} className={cn('flex min-w-0 flex-1 items-center rounded border border-border-primary bg-bg-primary focus-within:border-border-focus', error && 'border-status-error')}>
          <input
            type="text"
            value={typed ?? view?.url ?? ''}
            onChange={event => { setTyped(event.target.value); setError(''); }}
            onBlur={() => { if (typed === (view?.url ?? '')) setTyped(null); }}
            placeholder="Enter a URL"
            className="min-w-0 flex-1 bg-transparent px-2.5 py-1 text-sm text-text-primary placeholder-text-tertiary focus:outline-none"
          />
          <span className="mr-1 max-w-[40%] flex-shrink-0 truncate rounded bg-surface-secondary px-1.5 text-[11px] leading-5 text-text-tertiary" title={`This page runs on ${host}, signed in as ${host}`}>
            on {host}
          </span>
        </form>
      </div>
      {error && <div className="border-b border-border-primary bg-bg-primary px-2 py-1 text-xs text-status-error">{error}</div>}
      <BrowserStreamView client={client} panelId={panel.id} stream={stream} hostName={host} />
    </div>
  );
}
