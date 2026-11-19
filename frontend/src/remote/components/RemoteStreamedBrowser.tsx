import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Keyboard, Loader2, RotateCw } from 'lucide-react';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { normalizeUrl } from '../../components/panels/browser/browserUrl';
import { BrowserStreamView, stopLine } from '../../components/panels/browser/stream/BrowserStreamView';
import { streamClient } from '../../components/panels/browser/stream/streamClient';
import { useBrowserStream } from '../../components/panels/browser/stream/useBrowserStream';
import { useStreamWatch } from '../../components/panels/browser/stream/useStreamWatch';
import { cn } from '../../utils/cn';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { isNativeMobile } from '../runtime/nativeMobile';

/** Narrower than this, the tab uses the phone layout: address on top, controls at the bottom. */
const PHONE_WIDTH_PX = 640;

const TOOL_BUTTON = 'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40';

/**
 * A browser tab in the web app (PWA): the page runs on the host, signed in as the host, and this
 * screen draws its frames and drives it with touch, the phone's keyboard, or a mouse
 * (docs/BROWSER_AGENTS.md). A host on an older Pane streams nothing: `ownCopy` renders the page
 * loaded through its phone address, as before.
 */
export function RemoteStreamedBrowser({ adapter, panel, hostName, ownCopy }: { adapter: RemoteRuntimeAdapter; panel: ToolPanel; hostName: string; ownCopy: () => ReactNode }) {
  const client = useMemo(() => streamClient((channel, ...args) => adapter.invoke<JsonValue>(channel, args)), [adapter]);
  const stream = useBrowserStream(client, panel.id, true);
  const view = stream.view;
  const host = view?.host ?? hostName;
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const keyboard = useRef<(() => void) | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState('');
  const phone = width < PHONE_WIDTH_PX;
  const touchScreen = isNativeMobile() || window.matchMedia('(pointer: coarse)').matches;

  // Tells the host this screen shows the tab, with the room its stream gives the page.
  const invokeHost = useCallback((channel: string, ...args: Parameters<Parameters<typeof useStreamWatch>[0]>[1][]) => adapter.invoke<JsonValue>(channel, args), [adapter]);
  useStreamWatch(invokeHost, panel.id, touchScreen ? 'phone' : 'web', rootRef, stream.stop !== 'older');
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (stream.stop === 'older') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p role="status" className="border-b border-border-primary bg-bg-chrome px-3 py-1 text-xs text-text-tertiary">{stopLine('older', host)}</p>
        <div className="flex min-h-0 flex-1 flex-col">{ownCopy()}</div>
      </div>
    );
  }

  const go = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeUrl(typed ?? view?.url ?? '');
    if (!/^https?:\/\//i.test(url)) {
      setError('Enter a web address, like localhost:5173 or example.com.');
      return;
    }
    setError('');
    setTyped(null);
    // Closes the phone's keyboard once the address goes.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    void client.input(panel.id, [{ kind: 'navigate', url }]);
  };
  const history = (to: 'back' | 'forward' | 'reload') => void client.input(panel.id, [{ kind: 'history', go: to }]);
  const controls = (
    <>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.canGoBack} onClick={() => history('back')} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.canGoForward} onClick={() => history('forward')} aria-label="Forward"><ArrowRight className="h-4 w-4" /></button>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.url} onClick={() => history('reload')} aria-label="Reload">
        {view?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
      </button>
    </>
  );
  const onHost = <span className="min-w-0 truncate text-xs text-text-tertiary" title={`This page runs on ${host}, signed in as ${host}`}>on {host}</span>;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col bg-bg-primary" data-browser-streamed={panel.id}>
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border-primary bg-bg-chrome px-2 py-1.5">
        {!phone && controls}
        <form onSubmit={go} className={cn('flex min-w-0 flex-1 items-center rounded-md border border-border-primary bg-bg-primary focus-within:border-border-focus', error && 'border-status-error')}>
          <input
            type="url"
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="off"
            autoCorrect="off"
            value={typed ?? view?.url ?? ''}
            onChange={event => { setTyped(event.target.value); setError(''); }}
            onBlur={() => { if (typed === (view?.url ?? '')) setTyped(null); }}
            placeholder="Enter a URL"
            aria-label="Address"
            className="min-w-0 flex-1 bg-transparent px-2.5 py-1.5 text-[16px] text-text-primary placeholder-text-tertiary focus:outline-none sm:text-sm"
          />
          {!phone && <span className="mr-2 flex-shrink-0">{onHost}</span>}
        </form>
      </div>
      {error && <div className="border-b border-border-primary px-3 py-1 text-xs text-status-error">{error}</div>}
      <BrowserStreamView client={client} panelId={panel.id} stream={stream} hostName={host} phone={touchScreen} keyboardRef={keyboard} />
      {phone && (
        <div className="flex flex-shrink-0 items-center gap-1 border-t border-border-primary bg-bg-chrome px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          {controls}
          <button type="button" className={TOOL_BUTTON} onClick={() => keyboard.current?.()} aria-label="Keyboard"><Keyboard className="h-4 w-4" /></button>
          <span className="ml-auto flex min-w-0 pr-1">{onHost}</span>
        </div>
      )}
    </div>
  );
}
