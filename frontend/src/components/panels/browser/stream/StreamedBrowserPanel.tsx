import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Loader2, RotateCw } from 'lucide-react';
import type { ToolPanel } from '../../../../../../shared/types/panels';
import type { BrowserInput } from '../../../../../../shared/types/browserStream';
import type { JsonValue } from '../../../../../../shared/validation/boundaryDecoder';
import { cn } from '../../../../utils/cn';
import { normalizeUrl } from '../browserUrl';
import { BROWSER_NAVIGATE_EVENT, navigateRequestAction, type BrowserNavigateRequest } from '../browserNavigation';
import { BrowserStreamView, stopLine } from './BrowserStreamView';
import { streamClient } from './streamClient';
import { useBrowserStream } from './useBrowserStream';
import { useStreamWatch } from './useStreamWatch';

const invokeHost = (channel: string, ...args: Parameters<Parameters<typeof useStreamWatch>[0]>[1][]): Promise<JsonValue> => window.electronAPI.invoke(channel, ...args);


/**
 * A browser tab on a desktop showing another computer's Pane: the page runs on that computer, with
 * its sign-ins, and this desktop draws its frames and sends input back (docs/BROWSER_AGENTS.md).
 * A host on an older Pane streams nothing: `ownCopy` then renders this desktop's own copy.
 */
export function StreamedBrowserPanel({ panel, isActive, ownCopy }: { panel: ToolPanel; isActive: boolean; ownCopy: () => ReactNode }) {
  const client = useMemo(() => streamClient((channel, ...args) => window.electronAPI.invoke(channel, ...args)), []);
  const stream = useBrowserStream(client, panel.id, isActive);
  // This desktop reports the stream's own box (below the address bar), so a Take over sizes the page to it.
  const rootRef = useRef<HTMLDivElement>(null);
  useStreamWatch(invokeHost, panel.id, 'desktop', rootRef, isActive && stream.stop !== 'older');
  const view = stream.view;
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState('');
  const host = view?.host ?? 'the host';
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // An editor's preview or a project's run URL asks this tab to load a page: it loads on the host.
  const shownUrl = useRef(view?.url);
  useEffect(() => { shownUrl.current = view?.url; }, [view?.url]);
  useEffect(() => {
    const onNavigate = (event: Event) => {
      // SAFETY: requestBrowserNavigation is the only sender of this event.
      const request = (event as CustomEvent<BrowserNavigateRequest>).detail;
      const action = navigateRequestAction(request, { panelId: panel.id, sessionId: panel.sessionId, shownUrl: shownUrl.current });
      if (action === 'reload') void client.input(panel.id, [{ kind: 'history', go: 'reload' }]).catch(() => undefined);
      else if (action === 'navigate') void client.input(panel.id, [{ kind: 'navigate', url: normalizeUrl(request.url) }]).catch(() => undefined);
    };
    window.addEventListener(BROWSER_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(BROWSER_NAVIGATE_EVENT, onNavigate);
  }, [client, panel.id, panel.sessionId]);

  if (stream.stop === 'older') {
    return (
      <div className="flex h-full flex-col">
        <p role="status" className="border-b border-border-primary bg-bg-chrome px-3 py-1 text-xs text-text-tertiary">{stopLine('older', host)}</p>
        <div className="min-h-0 flex-1">{ownCopy()}</div>
      </div>
    );
  }

  // While the host can't be reached nothing is sent; a refusal or a missed deadline shows under the address bar.
  const act = (input: BrowserInput) => {
    if (stream.stop === 'unreachable' || stream.stop === 'gone') return;
    if (stream.stop === 'asleep') stream.wake();
    void client.input(panel.id, [input]).catch((cause: unknown) => setError(`${host} didn't take that: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
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
    act({ kind: 'navigate', url });
  };
  const history = (to: 'back' | 'forward' | 'reload') => act({ kind: 'history', go: to });
  const button = 'p-1 rounded enabled:hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-bg-primary" data-browser-streamed={panel.id}>
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
        <button type="button" className={button} disabled={!view?.url} onClick={() => { if (view?.url) void navigator.clipboard.writeText(view.url).then(() => setCopied(true), () => undefined); }} title="Copy URL">
          {copied ? <Check className="h-3.5 w-3.5 text-status-success" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {error && <div className="border-b border-border-primary bg-bg-primary px-2 py-1 text-xs text-status-error">{error}</div>}
      <BrowserStreamView client={client} panelId={panel.id} stream={stream} hostName={host} />
    </div>
  );
}
