import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Keyboard, Loader2, RotateCw } from 'lucide-react';
import type { BrowserPanelState, ToolPanel } from '../../../../shared/types/panels';
import { isHostLocalUrl } from '../../../../shared/utils/browserUrl';
import type { BrowserInput } from '../../../../shared/types/browserStream';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { normalizeUrl } from '../../components/panels/browser/browserUrl';
import { BrowserStreamView, stopLine } from '../../components/panels/browser/stream/BrowserStreamView';
import { streamClient } from '../../components/panels/browser/stream/streamClient';
import { useBrowserStream } from '../../components/panels/browser/stream/useBrowserStream';
import { useStreamWatch } from '../../components/panels/browser/stream/useStreamWatch';
import { useStreamChoice } from '../../components/panels/browser/stream/useStreamChoice';
import { VIEWER_ID } from '../../components/panels/browser/browserWatch';
import { LiveChip } from '../../components/panels/browser/stream/LiveChip';
import { cn } from '../../utils/cn';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { isNativeMobile } from '../runtime/nativeMobile';

/** Narrower than this, the tab uses the phone layout: address on top, controls at the bottom. */
const PHONE_WIDTH_PX = 640;

const TOOL_BUTTON = 'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40';

/**
 * A browser tab in the web app (PWA). It shows the page's own copy (`ownCopy`, through the host's
 * phone addresses) until an agent acts on the page; then it streams the host's page, where the agent
 * works, with touch, the phone's keyboard or a mouse, until 30 s after the last input by anyone or
 * Back to my copy; a page the agent typed into, or one the person chose View live on, streams until
 * Back to my copy (docs/BROWSER_AGENTS.md). Host files and dev servers always stay a copy.
 */
export function RemoteStreamedBrowser({ adapter, panel, hostName, ownCopy }: { adapter: RemoteRuntimeAdapter; panel: ToolPanel; hostName: string; ownCopy: (onViewLive?: () => void) => ReactNode }) {
  // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
  const state = panel.state.customState as BrowserPanelState | undefined;
  const choice = useStreamChoice(panel.id, state);
  if (isHostLocalUrl(state?.currentUrl) || !choice.stream) {
    const driver = state?.driver;
    const onViewLive = state?.agentUse && !isHostLocalUrl(state.currentUrl) ? choice.live : undefined;
    if (driver?.by !== 'person') return <>{ownCopy(onViewLive)}</>;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <HandBackRow adapter={adapter} panelId={panel.id} agent={driver.agentWaiting} />
        <div className="flex min-h-0 flex-1 flex-col">{ownCopy(onViewLive)}</div>
      </div>
    );
  }
  return <HostStream adapter={adapter} panel={panel} hostName={hostName} ownCopy={ownCopy} onBack={choice.back} onInput={choice.input} />;
}

/** On the own copy while the person drives the tab (they took over): hand it back to the agent from here. */
function HandBackRow({ adapter, panelId, agent }: { adapter: RemoteRuntimeAdapter; panelId: string; agent: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const handBack = () => {
    setFailed(false);
    void adapter.invoke<JsonValue>('browser:driver', [panelId, 'agent', VIEWER_ID]).catch(() => setFailed(true));
  };
  return (
    <div className="flex h-7 flex-shrink-0 items-center gap-1.5 border-b border-border-primary bg-bg-chrome px-3 text-xs text-text-secondary" data-testid="browser-hand-back">
      <span className={cn('min-w-0 flex-1 truncate', failed && 'text-status-error')}>{failed ? "That didn't reach the computer. Try again." : agent ? `You're driving · ${agent} is waiting` : "You're driving"}</span>
      <button type="button" className="flex-shrink-0 text-interactive hover:text-interactive-hover" onClick={handBack}>Hand to {agent ?? 'agent'}</button>
    </div>
  );
}

/** The host's page as a stream; a host on an older Pane streams nothing and `ownCopy` shows instead. */
function HostStream({ adapter, panel, hostName, ownCopy, onBack, onInput }: { adapter: RemoteRuntimeAdapter; panel: ToolPanel; hostName: string; ownCopy: (onViewLive?: () => void) => ReactNode; onBack(): void; onInput(): void }) {
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

  // While the host can't be reached nothing is sent; a refusal or a missed deadline shows under the address bar.
  const act = (input: BrowserInput) => {
    if (stream.stop === 'unreachable' || stream.stop === 'gone') return;
    onInput();
    if (stream.stop === 'asleep') stream.wake();
    void client.input(panel.id, [input]).catch((cause: unknown) => setError(`${host} didn't take that: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
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
    act({ kind: 'navigate', url });
  };
  const history = (to: 'back' | 'forward' | 'reload') => act({ kind: 'history', go: to });
  const controls = (
    <>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.canGoBack} onClick={() => history('back')} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.canGoForward} onClick={() => history('forward')} aria-label="Forward"><ArrowRight className="h-4 w-4" /></button>
      <button type="button" className={TOOL_BUTTON} disabled={!view?.url} onClick={() => history('reload')} aria-label="Reload">
        {view?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
      </button>
    </>
  );

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
        </form>
      </div>
      <LiveChip host={host} onBack={onBack} />
      {error && <div className="border-b border-border-primary px-3 py-1 text-xs text-status-error">{error}</div>}
      <BrowserStreamView client={client} panelId={panel.id} stream={stream} hostName={host} phone={touchScreen} keyboardRef={keyboard} onPersonInput={onInput} openOutside={url => { window.open(url, '_blank', 'noopener,noreferrer'); }} />
      {phone && (
        <div className="flex flex-shrink-0 items-center gap-1 border-t border-border-primary bg-bg-chrome px-2 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
          {controls}
          <button type="button" className={TOOL_BUTTON} onClick={() => keyboard.current?.()} aria-label="Keyboard"><Keyboard className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  );
}
