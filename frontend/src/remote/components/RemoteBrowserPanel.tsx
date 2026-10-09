import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, List, Loader2, RotateCw } from 'lucide-react';
import type { BrowserPanelState, ToolPanel } from '../../../../shared/types/panels';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import { PortsList } from '../../components/panels/browser/PortsList';
import { normalizeUrl } from '../../components/panels/browser/browserUrl';
import { cn } from '../../utils/cn';
import { phonePage, type PhonePage } from '../utils/phonePage';
import { isNativeMobile, openNativeExternalUrl } from '../runtime/nativeMobile';

interface RemoteBrowserPanelProps {
  panel: ToolPanel;
  ports: ListeningPortsSnapshot | null;
  /** Saves the host-relative URL every client shows for this panel. */
  onNavigate(url: string): void;
  onError(message: string): void;
}

const TOOL_BUTTON = 'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40';

/**
 * A browser tab on the phone: the page in a frame, loaded from the host through its phone
 * address, with the host-relative address in the bar. A cross-origin frame cannot report a page
 * that refuses framing, so "Open in Safari" is always offered.
 */
export function RemoteBrowserPanel({ panel, ports, onNavigate, onError }: RemoteBrowserPanelProps) {
  // SAFETY: The panel type discriminator determines the corresponding custom-state shape.
  const url = (panel.state.customState as BrowserPanelState | undefined)?.currentUrl ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [portsOpen, setPortsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);

  let page: PhonePage | null = null;
  if (url) {
    try {
      page = phonePage(url, ports, panel.id);
    } catch {
      page = { kind: 'unavailable', address: url, host: ports?.host ?? 'the host', reason: 'This address is not a valid URL.' };
    }
  }
  const src = page?.kind === 'frame' ? page.src : null;

  useEffect(() => {
    if (src) setLoading(true);
  }, [src, reloadKey]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!portsOpen) return;
    const close = (event: PointerEvent) => {
      // SAFETY: pointer events on the document target DOM nodes.
      if (!toolbarRef.current?.contains(event.target as Node)) setPortsOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [portsOpen]);

  const navigate = (input: string) => {
    const next = normalizeUrl(input);
    let parsed: URL;
    try {
      parsed = new URL(next);
    } catch {
      onError('Enter a valid http or https URL.');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      onError('Enter a valid http or https URL.');
      return;
    }
    setPortsOpen(false);
    setDraft(null);
    if (next === url) {
      setReloadKey(key => key + 1);
      return;
    }
    onNavigate(next);
  };

  const copy = () => {
    if (!src) return;
    navigator.clipboard.writeText(src).then(() => setCopied(true), () => onError('Could not copy the address.'));
  };

  const openOutside = () => {
    if (!src) return;
    if (isNativeMobile()) void openNativeExternalUrl(src);
    else window.open(src, '_blank', 'noopener,noreferrer');
  };

  const openPort = (port: number) => navigate(`http://localhost:${port}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      <div ref={toolbarRef} className="relative flex-shrink-0 border-b border-border-primary bg-bg-secondary">
        <div className="flex items-center gap-1 px-2 py-1.5">
          <form
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border-primary bg-surface-primary px-2 focus-within:border-interactive"
            onSubmit={event => {
              event.preventDefault();
              if (draft !== null && draft.trim()) navigate(draft);
            }}
          >
            <input
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-label="Address"
              placeholder="Enter a URL"
              value={draft ?? page?.address ?? ''}
              onFocus={event => {
                setDraft(page?.address ?? '');
                event.currentTarget.select();
              }}
              onBlur={() => setDraft(null)}
              onChange={event => setDraft(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
            {draft === null && page?.host && (
              <span className="min-w-0 max-w-[35%] truncate text-xs text-text-tertiary" title={`on ${page.host}`}>on {page.host}</span>
            )}
          </form>
          <button
            type="button"
            className={cn(TOOL_BUTTON, portsOpen && 'bg-surface-hover text-text-primary')}
            aria-label="Ports"
            aria-expanded={portsOpen}
            title="Ports"
            onClick={() => setPortsOpen(open => !open)}
          >
            <List className="h-4 w-4" />
          </button>
          <button type="button" className={TOOL_BUTTON} aria-label="Reload" title="Reload" disabled={!src} onClick={() => setReloadKey(key => key + 1)}>
            {/* The spinner and the reload icon share one box. */}
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          </button>
          <button type="button" className={TOOL_BUTTON} aria-label="Copy URL" title="Copy URL" disabled={!src} onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-status-success" /> : <Copy className="h-4 w-4" />}
          </button>
          <button type="button" className={TOOL_BUTTON} aria-label="Open in Safari" title="Open in Safari" disabled={!src} onClick={openOutside}>
            <ExternalLink className="h-4 w-4" />
          </button>
        </div>
        {portsOpen && (
          <div className="absolute inset-x-2 top-full z-30 mt-1 max-h-[min(28rem,70dvh)] overflow-y-auto rounded-lg border border-border-primary bg-surface-primary shadow-dropdown">
            <PortsList snapshot={ports} currentPort={currentPortOf(url)} canOpen tcpLabel="desktop only" onOpen={openPort} />
          </div>
        )}
      </div>

      {!page && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-2 py-4">
            <h2 className="px-3 text-sm font-medium text-text-primary">Ports on {ports?.host ?? 'the host'}</h2>
            <p className="mt-0.5 px-3 text-xs text-text-tertiary">Tap a web port to open it here, or enter a URL above.</p>
            <div className="mt-2">
              <PortsList snapshot={ports} canOpen tcpLabel="desktop only" onOpen={openPort} />
            </div>
          </div>
        </div>
      )}
      {page?.kind === 'unavailable' && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <p className="max-w-sm text-center text-sm text-text-secondary">{page.reason}</p>
        </div>
      )}
      {src && (
        <iframe
          key={`${src}#${reloadKey}`}
          src={src}
          title={panel.title}
          // Each page keeps its own origin; leaving out allow-top-navigation stops it from navigating Pane away.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={() => setLoading(false)}
          className="min-h-0 w-full flex-1 border-0"
        />
      )}
    </div>
  );
}

function currentPortOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(parsed.hostname)) return null;
    return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}
