import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { AutopilotDocument as AutopilotDocumentContent } from '../../../../shared/types/autopilot';
import { SHARED_BROWSER_PARTITION } from '../../../../shared/constants/browserPartitions';
import { guestColorSchemeScript } from './guestColorScheme';
import { Bone, Skeleton, SkeletonSwap, LoadingStatus } from '../ui/Skeleton';

/**
 * A page shown in a stack tab keeps Pane's scrollbars (D-70): the theme's own scrollbar tokens,
 * so they are dark in dark mode whatever the page itself styles.
 */
function scrollbarCss(): string {
  // Tokens can hold var(...) chains the page can't resolve, so read each as a real colour.
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const token = (name: string, fallback: string) => {
    probe.style.backgroundColor = fallback;
    probe.style.backgroundColor = `var(${name})`;
    return getComputedStyle(probe).backgroundColor || fallback;
  };
  const track = token('--color-scrollbar-track', 'transparent');
  const thumb = token('--color-scrollbar-thumb', 'rgb(110 118 129 / 0.5)');
  const hover = token('--color-scrollbar-thumb-hover', thumb);
  probe.remove();
  return `::-webkit-scrollbar{width:10px;height:10px;background:${track}}`
    + `::-webkit-scrollbar-track{background:${track}}`
    + `::-webkit-scrollbar-thumb{background:${thumb};border-radius:8px;border:2px solid transparent;background-clip:padding-box}`
    + `::-webkit-scrollbar-thumb:hover{background:${hover};background-clip:padding-box}`
    + `::-webkit-scrollbar-corner{background:${track}}`;
}

/** A live page (an HTML document or the app's URL) in the stack. */
export function AutopilotWebPage({ src, title }: { src: string; title: string }) {
  const ref = useRef<Electron.WebviewTag>(null);
  useEffect(() => {
    const webview = ref.current;
    if (!webview) return;
    let ready = false;
    let inserted: Promise<string | undefined> = Promise.resolve(undefined);
    // Replaces the page's scrollbar CSS with the current theme's, and gives the page Pane's light or
    // dark (D-163: a guest otherwise follows the Mac's): on load, and whenever Pane's theme changes.
    const apply = () => {
      if (!ready) return;
      const root = document.documentElement.classList;
      const scheme = root.contains('dark') || root.contains('oled') ? 'dark' : 'light';
      void webview.executeJavaScript(guestColorSchemeScript(scheme)).catch(() => undefined);
      const css = scrollbarCss();
      inserted = inserted.then(async (key) => {
        if (key) await webview.removeInsertedCSS(key).catch(() => undefined);
        return webview.insertCSS(css).catch(() => undefined);
      });
    };
    const onReady = () => { ready = true; inserted = Promise.resolve(undefined); apply(); };
    webview.addEventListener('dom-ready', onReady);
    // The theme is a class on the root element (light, dark, oled); focus classes change there too, so compare the theme only.
    const themeOf = () => ['light', 'dark', 'oled'].filter(name => document.documentElement.classList.contains(name)).join(' ');
    let theme = themeOf();
    const themeWatch = new MutationObserver(() => { const next = themeOf(); if (next !== theme) { theme = next; apply(); } });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => { themeWatch.disconnect(); webview.removeEventListener('dom-ready', onReady); };
  }, [src]);
  return (
    <webview
      ref={ref}
      src={src}
      title={title}
      partition={SHARED_BROWSER_PARTITION}
      className="min-h-0 w-full min-w-0 flex-1 border-0"
      style={{ display: 'flex', width: '100%' }}
      data-testid="autopilot-webview"
      data-find-webview=""
    />
  );
}

/** Line widths (percent) of the text a document opens to; 0 is a blank line. */
const DOC_LINES = [38, 0, 92, 86, 71, 0, 88, 94, 63, 0, 45, 90, 82, 57, 0, 91, 76];

/** A document tab: an HTML file renders as a page; any other file shows as text. */
export function AutopilotDocument({ path, label }: { path: string; label: string }) {
  const [content, setContent] = useState<AutopilotDocumentContent | null>(null);
  useEffect(() => {
    let live = true;
    setContent(null);
    void window.electronAPI.autopilot.readDoc(path)
      .then((result) => { if (live) setContent(result); })
      .catch((error: Error) => { if (live) setContent({ kind: 'missing', path, message: error.message }); });
    return () => { live = false; };
  }, [path]);

  if (content?.kind === 'missing') {
    return (
      <div className="m-auto max-w-sm text-center text-[13px] text-text-secondary" role="status" data-testid="autopilot-doc-missing">
        <p>{content.message}</p>
        <button type="button" onClick={() => void window.electronAPI.openExternal(`file://${content.path}`)} className="mt-2 inline-flex items-center gap-1 text-text-tertiary hover:text-text-primary">
          Open {label} outside Pane <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <SkeletonSwap loading={!content} skeleton={
      <>
        <LoadingStatus label={`Opening ${label}`} />
        <Skeleton className="min-h-0 flex-1 px-5 py-4">
          {DOC_LINES.map((width, index) => (
            <div key={index} className="flex h-[20.3px] items-center">{width > 0 && <Bone className="h-2.5" style={{ width: `${width}%` }} />}</div>
          ))}
        </Skeleton>
      </>
    }>
      {content?.kind === 'html' ? <AutopilotWebPage src={content.url} title={label} /> : content?.kind === 'text' && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12.5px] leading-relaxed text-text-primary" data-testid="autopilot-text-doc">
          {content.text}
        </pre>
      )}
    </SkeletonSwap>
  );
}
