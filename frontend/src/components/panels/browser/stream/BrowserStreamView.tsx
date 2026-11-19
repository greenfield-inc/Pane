import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { BrowserInput, BrowserInputResult } from '../../../../../../shared/types/browserStream';
import { cn } from '../../../../utils/cn';
import { DriverChip } from '../../device/DeviceToolViews';
import { browserInputQueue, clickCounter, fitFrame, modifiersOf, pagePoint, PhoneControl } from '../../../../../../shared/utils/browserStreamInput';
import type { BrowserStream, StreamStop } from './useBrowserStream';
import type { BrowserStreamClient } from './streamClient';

/** How long the agent's cursor stays at a click before it fades (as on the host's own tab). */
const CURSOR_SHOWN_MS = 1_200;
/** How long "The page reloaded on <host>" stays. */
const RELOADED_SHOWN_MS = 8_000;
/** The pointer's position goes to the host at most this often while it hovers. */
const HOVER_MS = 60;
/** A touch held this long without moving is a right click. */
const LONG_PRESS_MS = 550;
/** A touch that moves this far is a scroll, not a tap. */
const TAP_SLOP_PX = 8;
/** Named keys a screen sends to the page as keys; printable text arrives through the text field. */
const PAGE_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** Editing chords (with Cmd or Ctrl) the page gets; every other chord stays Pane's hotkey. */
const EDIT_CHORDS = new Set(['a', 'c', 'x', 'z']);
/**
 * The text field always holds this zero-width character, so a phone keyboard's Backspace on an
 * empty field still deletes something and shows up (Android sends no key for it).
 */
const SENTINEL = '\u200b';

/** The line a stopped stream shows over its last frame, dimmed. */
export function stopLine(stop: StreamStop, host: string, phone = false): string {
  switch (stop) {
    case 'unreachable': return `${host} can't be reached (asleep or offline). The page resumes when it's back.`;
    case 'asleep': return `This tab is asleep. ${phone ? 'Tap' : 'Click'} to wake it.`;
    case 'gone': return `This tab closed on ${host}.`;
    case 'older': return `${host} is on an older Pane. Showing your own copy.`;
  }
}

interface BrowserStreamViewProps {
  client: BrowserStreamClient;
  panelId: string;
  stream: BrowserStream & { wake(): void };
  /** The host's name until its state arrives. */
  hostName: string;
  /** A phone: the first tap only takes control (the page gets the phone's size), and a tap into a field opens the keyboard. */
  phone?: boolean;
  /** Set by the view: focuses its text field, opening a phone's keyboard (the keyboard button). */
  keyboardRef?: { current: (() => void) | null };
}

/**
 * A browser tab's page as frames from its host, driven with this screen's mouse, wheel, keys and
 * touch (docs/BROWSER_AGENTS.md). The frame is letterboxed in the view; input maps to page pixels
 * and goes to the host in order. Shows who drives, the agent's cursor, the page's dialogs and file
 * pickers, downloads and why the stream stopped.
 */
export function BrowserStreamView({ client, panelId, stream, hostName, phone = false, keyboardRef }: BrowserStreamViewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!keyboardRef) return;
    keyboardRef.current = () => keysRef.current?.focus({ preventScroll: true });
    return () => { keyboardRef.current = null; };
  }, [keyboardRef]);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [field, setField] = useState<'text' | 'password' | null>(null);
  const { frame, view, stop } = stream;
  const host = view?.host ?? hostName;
  const page = useMemo(() => (frame ? { width: frame.width, height: frame.height } : undefined), [frame]);

  const onResult = useCallback((result: BrowserInputResult) => {
    if (result.copied) void navigator.clipboard.writeText(result.copied).catch(() => undefined);
    if (result.field !== undefined) {
      setField(result.field);
      // A tap into a field opens the phone's keyboard; elsewhere it closes.
      if (phone && result.field) keysRef.current?.focus({ preventScroll: true });
      else if (phone) keysRef.current?.blur();
    }
  }, [phone]);
  const queue = useMemo(() => browserInputQueue(batch => client.input(panelId, batch), onResult), [client, panelId, onResult]);
  // Input made while the host can't be reached is dropped, never replayed late onto a page that may have changed.
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);
  const send = useCallback((input: BrowserInput | null) => {
    if (stopRef.current && stopRef.current !== 'older') return;
    // After Enter, Tab or a navigation the page may focus a password field by itself: type securely until the host says.
    if ((input?.kind === 'key' && (input.key === 'Enter' || input.key === 'Tab')) || input?.kind === 'navigate' || input?.kind === 'history') setField('password');
    queue(input);
  }, [queue]);

  // Hover goes on its own read channel, at most every HOVER_MS, one on its way at a time: the host
  // keeps no answer for it, so pointing around never uses up this screen's write allowance.
  const hover = useRef<{ next?: { x: number; y: number }; busy: boolean; last: number }>({ busy: false, last: 0 });
  const sendHover = useCallback((point: { x: number; y: number }) => {
    const state = hover.current;
    state.next = point;
    if (state.busy || stopRef.current) return;
    const go = () => {
      const next = state.next;
      if (!next) { state.busy = false; return; }
      state.next = undefined;
      state.last = performance.now();
      void client.pointer(panelId, next.x, next.y).catch(() => undefined).finally(() => {
        window.setTimeout(go, Math.max(0, HOVER_MS - (performance.now() - state.last)));
      });
    };
    state.busy = true;
    go();
  }, [client, panelId]);

  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setBox({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Draw one frame at a time; a frame that arrives while one decodes replaces the one waiting.
  const pending = useRef<string | undefined>(undefined);
  const decoding = useRef(false);
  useEffect(() => {
    if (!frame) return;
    pending.current = frame.data;
    const draw = async () => {
      if (decoding.current) return;
      decoding.current = true;
      while (pending.current) {
        const data = pending.current;
        pending.current = undefined;
        // Decoded from the data URL's bytes: Pane's content policy lets no fetch() read data: URLs.
        const bitmap = await createImageBitmap(jpegBlob(data)).catch((cause: unknown) => { console.warn('[browser stream] Could not decode a frame:', cause); return undefined; });
        const canvas = canvasRef.current;
        if (!bitmap || !canvas) continue;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      decoding.current = false;
    };
    void draw();
  }, [frame]);

  const drawn = page ? fitFrame(box, page) : { left: 0, top: 0, width: 0, height: 0 };
  const toPage = (event: { clientX: number; clientY: number }) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || !page) return undefined;
    return pagePoint(event.clientX - rect.left, event.clientY - rect.top, box, page);
  };
  // While a button is held, a point outside the page lands on its nearest edge, so a drag that ends outside still releases.
  const toPageClamped = (event: { clientX: number; clientY: number }) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || !page || drawn.width === 0) return undefined;
    const x = Math.min(Math.max(event.clientX - rect.left, drawn.left), drawn.left + drawn.width);
    const y = Math.min(Math.max(event.clientY - rect.top, drawn.top), drawn.top + drawn.height);
    return pagePoint(x, y, box, page);
  };
  const pressed = useRef<{ button: 'left' | 'middle' | 'right'; x: number; y: number } | null>(null);

  // A phone controls the page once it took control (the same rule as the phone app): its first touch only takes it.
  const control = useMemo(() => new PhoneControl(), []);
  useEffect(() => { if (view) control.view(view); }, [control, view]);
  const takesControl = () => {
    if (!phone || !control.touch()) return false;
    send(null);
    return true;
  };

  // Double and triple clicks: pointer events carry no count, so the view counts presses itself.
  const countClick = useMemo(() => clickCounter(), []);
  const clicks = useRef(1);

  // Touch: a tap clicks, a drag scrolls, a long press is a right click.
  const touch = useRef<{ x: number; y: number; lastX: number; lastY: number; moved: boolean; timer: number | undefined; longPressed: boolean; tookControl?: boolean } | undefined>(undefined);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (stop === 'asleep') { stream.wake(); return; }
    const point = toPage(event);
    if (!point) return;
    event.preventDefault();
    if (!phone) keysRef.current?.focus({ preventScroll: true });
    if (event.pointerType === 'touch') {
      const timer = window.setTimeout(() => {
        const current = touch.current;
        if (!current || current.moved) return;
        current.longPressed = true;
        if (takesControl()) return;
        send({ kind: 'mouse', action: 'down', x: point.x, y: point.y, button: 'right', clicks: 1, modifiers: 0 });
        send({ kind: 'mouse', action: 'up', x: point.x, y: point.y, button: 'right', clicks: 1, modifiers: 0 });
      }, LONG_PRESS_MS);
      touch.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, timer, longPressed: false };
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    clicks.current = countClick(event.clientX, event.clientY, event.timeStamp);
    const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
    pressed.current = { button, ...point };
    send({ kind: 'mouse', action: 'down', ...point, button, clicks: clicks.current, modifiers: modifiersOf(event) });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = touch.current;
    if (event.pointerType === 'touch' && current) {
      if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < TAP_SLOP_PX) return;
      if (!current.moved) {
        window.clearTimeout(current.timer);
        current.tookControl = takesControl();
      }
      current.moved = true;
      if (current.tookControl) return;
      const point = toPage(event);
      const scale = page && drawn.width ? page.width / drawn.width : 1;
      if (point) send({ kind: 'wheel', ...point, dx: (current.lastX - event.clientX) * scale, dy: (current.lastY - event.clientY) * scale });
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      return;
    }
    if (event.pointerType === 'touch') return;
    const button = event.buttons & 1 ? 'left' : event.buttons & 2 ? 'right' : event.buttons & 4 ? 'middle' : 'none';
    if (button === 'none') {
      const point = toPage(event);
      if (point) sendHover(point);
      return;
    }
    const point = toPageClamped(event);
    if (!point) return;
    send({ kind: 'mouse', action: 'move', ...point, button, clicks: 0, modifiers: modifiersOf(event) });
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = touch.current;
    if (event.pointerType === 'touch') {
      touch.current = undefined;
      if (!current) return;
      window.clearTimeout(current.timer);
      const point = toPage({ clientX: current.x, clientY: current.y });
      if (current.moved || current.longPressed) return;
      // The first tap only takes control: the page resizes to the phone and gets its phone layout.
      if (takesControl()) return;
      if (point) {
        // Focused inside the tap, or iOS opens no keyboard; the host's answer closes it again when no field took the tap.
        if (phone) keysRef.current?.focus({ preventScroll: true });
        // A tap goes as a mouse click: Chromium makes no click (or one in the wrong place) from a
        // synthetic touch on a page shown at another size.
        send({ kind: 'mouse', action: 'down', ...point, button: 'left', clicks: 1, modifiers: 0 });
        send({ kind: 'mouse', action: 'up', ...point, button: 'left', clicks: 1, modifiers: 0 });
      }
      return;
    }
    const point = toPageClamped(event);
    if (!point) return;
    pressed.current = null;
    send({ kind: 'mouse', action: 'up', ...point, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clicks: clicks.current, modifiers: modifiersOf(event) });
  };

  // Capture lost before the release (the window lost focus): release the button on the page too.
  const onLostCapture = () => {
    const held = pressed.current;
    pressed.current = null;
    if (held) send({ kind: 'mouse', action: 'up', x: held.x, y: held.y, button: held.button, clicks: clicks.current, modifiers: 0 });
  };

  // A wheel turn scrolls the page, never Pane: the listener must not be passive to keep it.
  useEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const rect = element.getBoundingClientRect();
      if (!page) return;
      const point = pagePoint(event.clientX - rect.left, event.clientY - rect.top, { width: rect.width, height: rect.height }, page);
      if (!point) return;
      event.preventDefault();
      const lines = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? rect.height : 1;
      send({ kind: 'wheel', ...point, dx: event.deltaX * lines, dy: event.deltaY * lines });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [page, send]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const chord = event.metaKey || event.ctrlKey;
    if (chord) {
      // Editing chords and chords on named keys (Cmd+Left, Cmd+Backspace, Cmd+Enter) go to the page;
      // paste reads this screen's clipboard (the paste event); every other chord stays Pane's.
      if (PAGE_KEYS.has(event.key)) {
        event.preventDefault();
        send({ kind: 'key', key: event.key, modifiers: modifiersOf(event) });
        return;
      }
      if (!EDIT_CHORDS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      send({ kind: 'key', key: event.key.toLowerCase(), modifiers: modifiersOf(event) });
      return;
    }
    // On a desktop one printable character goes as a key press, so the page sees keydown (Space, site
    // shortcuts). A phone's keyboard keeps its text path, for autocorrect and IME.
    if ((!phone && [...event.key].length === 1) || PAGE_KEYS.has(event.key)) {
      event.preventDefault();
      send({ kind: 'key', key: event.key, modifiers: modifiersOf(event) });
    }
  };

  // Typed, dictated and IME text, and phones' keyboards (whose keys arrive as "Unidentified").
  const onInput = () => {
    const keys = keysRef.current;
    if (!keys || composing.current) return;
    const typed = keys.value;
    keys.value = SENTINEL;
    if (!typed.includes(SENTINEL)) {
      // The keyboard deleted the sentinel: a Backspace, then whatever replaced it.
      send({ kind: 'key', key: 'Backspace', modifiers: 0 });
    }
    const text = typed.split(SENTINEL).join('');
    if (text) send({ kind: 'text', text });
  };
  const composing = useRef(false);

  const dialog = view?.dialog;
  const [promptText, setPromptText] = useState('');
  useEffect(() => { setPromptText(dialog?.defaultPrompt ?? ''); }, [dialog]);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) { send({ kind: 'files-cancel' }); return; }
    const read = await Promise.all([...files].map(async file => ({ name: file.name, data: await toBase64(file) })));
    send({ kind: 'files', files: read });
  };

  const [, rerender] = useState(0);
  useEffect(() => {
    if (stream.reloadedAt === undefined) return;
    const timer = window.setTimeout(() => rerender(count => count + 1), RELOADED_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [stream.reloadedAt]);
  const cursor = view?.agentCursor;
  // When this screen heard of the click and of the download: the host's clock may differ from this one.
  const [cursorSeenAt, setCursorSeenAt] = useState(0);
  useEffect(() => { if (cursor) setCursorSeenAt(Date.now()); }, [cursor?.at, cursor?.x, cursor?.y]);
  useEffect(() => {
    if (!cursorSeenAt) return;
    const timer = window.setTimeout(() => rerender(count => count + 1), CURSOR_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [cursorSeenAt]);
  const agentDriving = view?.driver?.by === 'agent';
  const cursorShown = cursor !== undefined && agentDriving && Date.now() - cursorSeenAt < CURSOR_SHOWN_MS && page !== undefined;
  const [lastAgent, setLastAgent] = useState<string | undefined>(undefined);
  useEffect(() => { if (view?.driver?.by === 'agent') setLastAgent(view.driver.agent); }, [view?.driver]);
  const download = view?.downloads.at(-1);
  const [downloadSeenAt, setDownloadSeenAt] = useState(0);
  const firstDownload = useRef<number | undefined | null>(null);
  useEffect(() => {
    // Downloads from before this screen opened the tab stay quiet.
    if (firstDownload.current === null) { firstDownload.current = download?.at; return; }
    if (download && download.at !== firstDownload.current) setDownloadSeenAt(Date.now());
  }, [download?.at]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const noticeSeen = dismissed === host || readNoticeSeen(host);
  const dismissNotice = () => {
    setDismissed(host);
    try { localStorage.setItem(noticeKey(host), 'seen'); } catch { /* storage blocked: the note shows again next time */ }
  };

  return (
    <div
      ref={boxRef}
      className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-bg-tertiary"
      style={{ cursor: view?.pointer ?? 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { window.clearTimeout(touch.current?.timer); touch.current = undefined; onLostCapture(); }}
      onLostPointerCapture={onLostCapture}
      onContextMenu={event => event.preventDefault()}
      data-testid="browser-stream"
      data-stream-stop={stop ?? 'none'}
    >
      <canvas
        ref={canvasRef}
        className={cn('absolute transition-opacity duration-200', stop ? 'opacity-40' : 'opacity-100')}
        style={{ left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }}
      />
      <input
        ref={keysRef}
        // A password field gets the keyboard's secure mode; nothing typed stays in this field.
        type={field === 'password' ? 'password' : 'text'}
        defaultValue={SENTINEL}
        aria-label="Type into the page"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect={field === 'password' ? 'off' : 'on'}
        spellCheck={false}
        enterKeyHint="go"
        // 16 px keeps iOS from zooming the page when the field takes focus.
        className="absolute left-0 top-0 h-px w-px border-0 bg-transparent p-0 text-[16px] opacity-0"
        onKeyDown={onKeyDown}
        onInput={onInput}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; onInput(); }}
        onPaste={event => {
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          if (text) send({ kind: 'text', text });
        }}
      />
      <div className={cn('pointer-events-none absolute inset-0 border-2 transition-colors duration-200', agentDriving ? 'border-interactive' : 'border-transparent')} data-testid="browser-agent-overlay" data-driving={agentDriving ? 'agent' : view?.driver?.by ?? 'none'}>
        {view?.driver && (
          <div className="pointer-events-auto absolute left-1/2 top-2 max-w-[calc(100%-16px)] -translate-x-1/2 whitespace-nowrap rounded-full bg-surface-primary text-xs shadow-md" data-testid="browser-driver-chip" onPointerDown={event => event.stopPropagation()}>
            <DriverChip driver={view.driver} agentName={lastAgent} onTakeOver={() => void client.driver(panelId, 'person')} onHandBack={() => void client.driver(panelId, 'agent')} />
          </div>
        )}
        {cursor && page && (
          <MousePointer2
            className={cn('absolute h-5 w-5 fill-interactive text-text-on-interactive drop-shadow transition-opacity duration-200', cursorShown ? 'opacity-100' : 'opacity-0')}
            style={{ left: drawn.left + (cursor.x / page.width) * drawn.width, top: drawn.top + (cursor.y / page.height) * drawn.height }}
            data-testid="browser-agent-cursor"
          />
        )}
      </div>
      {view && !noticeSeen && (
        <div role="note" className="absolute left-3 top-12 z-10 flex max-w-[min(32rem,calc(100%-24px))] items-start gap-3 rounded-md bg-surface-primary px-3 py-2 text-xs text-text-secondary shadow-md" onPointerDown={event => event.stopPropagation()} data-testid="browser-sign-in-notice">
          <span>This page runs on {host}, signed in as {host}. Sign in here once and every device sees it.</span>
          <button type="button" className="flex-shrink-0 text-interactive hover:text-interactive-hover" onClick={dismissNotice}>Got it</button>
        </div>
      )}
      {stop && stop !== 'older' && (
        <div role="status" className="absolute inset-x-0 bottom-0 flex justify-center p-3">
          <p className="rounded-md bg-surface-primary px-3 py-1.5 text-xs text-text-secondary shadow-md">{stopLine(stop, host, phone)}</p>
        </div>
      )}
      {!frame && !stop && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-xs text-text-tertiary">Loading the page on {host}…</div>
      )}
      {stream.reloadedAt !== undefined && Date.now() - stream.reloadedAt < RELOADED_SHOWN_MS && !stop && (
        <div role="status" className="absolute inset-x-0 bottom-0 flex justify-center p-3">
          <p className="rounded-md bg-surface-primary px-3 py-1.5 text-xs text-text-secondary shadow-md">The page reloaded on {host}.</p>
        </div>
      )}
      {download && downloadSeenAt > 0 && Date.now() - downloadSeenAt < 60_000 && (
        <div role="status" className="absolute bottom-3 right-3 rounded-md bg-surface-primary px-3 py-1.5 text-xs text-text-secondary shadow-md">
          Downloaded {download.name} on {host}
        </div>
      )}
      {dialog && (
        <div className="absolute inset-0 flex items-center justify-center bg-modal-overlay p-4" onPointerDown={event => event.stopPropagation()} data-testid="browser-stream-dialog">
          <div role="dialog" aria-label="The page asks" className="w-full max-w-sm rounded-lg border border-border-primary bg-surface-primary p-4 shadow-lg">
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{dialog.message}</p>
            {dialog.type === 'prompt' && (
              <input className="mt-3 w-full rounded border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary" value={promptText} onChange={event => setPromptText(event.target.value)} autoFocus />
            )}
            <div className="mt-4 flex justify-end gap-2">
              {dialog.type !== 'alert' && (
                <button type="button" className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-surface-hover" onClick={() => send({ kind: 'dialog', accept: false })}>Cancel</button>
              )}
              <button type="button" className="rounded bg-interactive px-3 py-1 text-sm text-text-on-interactive hover:bg-interactive-hover" onClick={() => send(dialog.type === 'prompt' ? { kind: 'dialog', accept: true, text: promptText } : { kind: 'dialog', accept: true })}>OK</button>
            </div>
          </div>
        </div>
      )}
      {view?.fileChooser && !dialog && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center p-3" onPointerDown={event => event.stopPropagation()} data-testid="browser-stream-files">
          <div className="flex items-center gap-3 rounded-md bg-surface-primary px-3 py-2 text-xs text-text-secondary shadow-md">
            <span>The page asks for {view.fileChooser.multiple ? 'files' : 'a file'}.</span>
            <button type="button" className="rounded bg-interactive px-2.5 py-1 text-text-on-interactive hover:bg-interactive-hover" onClick={() => fileInput.current?.click()}>Choose…</button>
            <button type="button" className="rounded px-2 py-1 hover:bg-surface-hover" onClick={() => send({ kind: 'files-cancel' })}>Cancel</button>
            <input ref={fileInput} type="file" className="hidden" multiple={view.fileChooser.multiple} onChange={event => void chooseFiles(event.target.files)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The image in a base64 data URL, as a Blob. */
function jpegBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/jpeg' });
}

/** Each host's one-time note about whose sign-ins its tabs use is remembered per screen. */
function noticeKey(host: string): string {
  return `pane.browserSignInNotice.${host}`;
}

function readNoticeSeen(host: string): boolean {
  try { return localStorage.getItem(noticeKey(host)) === 'seen'; } catch { return false; }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
