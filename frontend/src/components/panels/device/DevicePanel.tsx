import { useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { Camera, Check, Home, Info, Laptop, Loader2, Lock, MoreHorizontal, Power, RotateCcw, WifiOff, X } from 'lucide-react';
import type { DevicePanelState, DeviceSettingsView } from '../../../../../shared/types/devices';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { cn } from '../../../utils/cn';
import { deviceCaption, devicePhaseCopy } from './deviceCopy';
import { requestOpenSettings } from '../../../utils/openSettings';
import { useAddDeviceStore } from '../../addDevice/addDeviceStore';
import { useConfigStore } from '../../../stores/configStore';
import { FRAME_POLL_MS, jpegToPng, useDeviceFrames } from './deviceFrames';
import { DeviceClientContext, desktopDeviceClient, type DeviceTabClient } from './deviceClient';

/** The tab's screen size when the device has not sent a frame yet (iPhone 17 Pro points). */
const DEFAULT_ASPECT = { ios: 402 / 874, android: 412 / 915 } satisfies Record<DevicePanelState['platform'], number>;

export interface DevicePanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

/**
 * A phone simulator or emulator's live screen (option 2 of the D-71 mockups): the phone fills the
 * tab, a small rail beside it holds Home, Screenshot and More, and a caption under it names the
 * device, OS and machine. Every state covers the screen inside the same frame.
 */
export function DevicePanel({ panel, isActive }: DevicePanelProps) {
  // SAFETY: the panel type discriminator determines the custom-state shape.
  const state = panel.state.customState as DevicePanelState;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);
  const live = state.phase === 'live';
  // A desktop switched to another computer reads frames from it; this one's own devices stream.
  const remote = useConfigStore(store => store.config?.remoteDaemon?.client.mode === 'remote');
  const provided = useContext(DeviceClientContext);
  const client = useMemo(() => provided ?? desktopDeviceClient(remote), [provided, remote]);
  const lastFrame = useLastFrame(client, panel.id, state.deviceId, !live && state.phase !== 'booting' && state.phase !== 'installing');
  // The screen's shape as its frames show it, so landscape, an iPad or a folded phone fit uncropped.
  const [aspect, setAspect] = useState<number>(DEFAULT_ASPECT[state.platform]);
  const onScreenSize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    const next = width / height;
    setAspect(current => (Math.abs(current - next) / current < 0.01 ? current : next));
  }, []);
  const streaming = live && isActive && client.streamUrl !== undefined && state.platform === 'ios';
  const frameRate = useFrameRate(client, panel.id, streaming);

  useEffect(() => {
    if (!state.deviceId) return;
    const report = (visible: boolean) => { void client.visible(panel.id, visible).catch(() => undefined); };
    const onVisibility = () => report(isActive && document.visibilityState === 'visible');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      report(false);
    };
  }, [client, panel.id, state.deviceId, isActive, state.phase]);

  const run = useCallback(async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(undefined);
    }
  }, []);

  const copyScreen = useCallback(() => run('copy', async () => {
    // Clipboard images must be PNG; the frame is a JPEG data URL.
    const png = await jpegToPng(await client.frame(panel.id));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }), [client, panel.id, run]);

  if (state.phase === 'no-mac' || state.phase === 'mac-offline') {
    return <NoMacView state={state} panelId={panel.id} client={client} />;
  }

  const showBanner = !bannerHidden && state.machineReason && state.machineReason.kind !== 'local';
  const moreItems: DropdownItem[] = [
    { id: 'restart', label: 'Restart', icon: RotateCcw, onClick: () => { void run('restart', () => client.power(panel.id, 'restart')); }, disabled: !live },
    { id: 'shutdown', label: 'Shut down', icon: Power, onClick: () => { void run('shutdown', () => client.power(panel.id, 'shutdown')); }, disabled: !live },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-primary" data-testid="device-panel" data-phase={state.phase}>
      {showBanner && state.machineReason && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-bg-chrome px-3 py-1.5 text-xs text-text-secondary">
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 truncate">{state.machineReason.text}</span>
          {!provided && <MacMenu />}
          <button type="button" aria-label="Hide" className="text-text-tertiary hover:text-text-primary" onClick={() => setBannerHidden(true)}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3 p-4">
        <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center">
          <PhoneFrame aspect={aspect} footer={<DeviceCaption state={state} frameRate={streaming ? frameRate : undefined} />}>
            {live && isActive ? <LiveScreen client={client} panelId={panel.id} platform={state.platform} onScreenSize={onScreenSize} /> : (
              <div className="absolute inset-0 bg-device-screen">
                {lastFrame && <img src={lastFrame} alt="" className="h-full w-full object-contain opacity-60" onLoad={(event) => onScreenSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />}
              </div>
            )}
            <PhaseOverlay state={state} busy={busy} onBoot={() => run('boot', () => client.power(panel.id, 'boot'))} onTakeOver={() => run('take-over', () => client.takeOver(panel.id))} />
          </PhoneFrame>
          {error && <p className="mt-1 max-w-sm text-center text-xs text-status-error" role="alert">{error}</p>}
        </div>
        <div className="flex flex-shrink-0 flex-col items-center gap-1 self-center rounded-full border border-border-primary bg-surface-primary p-1 shadow-sm" data-testid="device-rail">
          <RailButton label="Home" disabled={!live} onClick={() => { void client.input(panel.id, { kind: 'button', button: 'home' }).catch(() => undefined); }}><Home className="h-4 w-4" /></RailButton>
          <RailButton label={copied ? 'Copied' : 'Copy screenshot'} disabled={!live} onClick={() => { void copyScreen(); }}>{copied ? <Check className="h-4 w-4 text-status-success" /> : <Camera className="h-4 w-4" />}</RailButton>
          <div className="my-0.5 h-px w-5 bg-border-primary" />
          <Dropdown trigger={<RailButton label="More" disabled={false}><MoreHorizontal className="h-4 w-4" /></RailButton>} items={moreItems} position="bottom-right" width="sm" />
        </div>
      </div>
    </div>
  );
}

/**
 * Change, on the banner of a device that runs on a linked Mac: Automatic and each saved Mac with
 * whether it is online, then Devices settings. The choice applies to the next device_open.
 */
function MacMenu() {
  const [view, setView] = useState<DeviceSettingsView>();
  const load = (open: boolean) => {
    if (!open) return;
    void window.electronAPI.devices.settings().then((response) => { if (response.success) setView(response.data); });
  };
  const pick = (iosMachineId: string | null) => { void window.electronAPI.devices.updateSettings({ iosMachineId }).then(() => load(true)); };
  const pinned = view?.settings.iosMachineId;
  const automatic = view?.macs.find(mac => mac.online);
  const items: DropdownItem[] = [
    { id: 'automatic', label: 'Automatic', description: automatic?.name, onClick: () => pick(null) },
    ...(view?.macs ?? []).map((mac): DropdownItem => ({ id: mac.id, label: mac.name, description: mac.online ? 'Online' : 'Offline', showDot: true, dotColor: mac.online ? 'bg-status-success' : 'bg-status-neutral', onClick: () => pick(mac.id) })),
    { id: 'settings', label: 'Devices settings', separatorBefore: true, onClick: () => requestOpenSettings({ category: 'devices' }) },
  ];
  return (
    <Dropdown
      trigger={<button type="button" className="text-interactive hover:text-interactive-hover">Change</button>}
      items={items}
      selectedId={pinned ?? 'automatic'}
      selectedMark="check"
      header="iOS devices run on a linked Mac. This computer has no Xcode."
      position="bottom-right"
      width="md"
      onOpenChange={load}
    />
  );
}

function RailButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function DeviceCaption({ state, frameRate }: { state: DevicePanelState; frameRate?: number | null }) {
  return (
    <p className="mt-3 flex max-w-full items-center truncate text-xs text-text-tertiary" data-testid="device-caption">
      {frameRate !== undefined && (
        // A fixed box, so the caption never shifts as the number changes.
        <span className="mr-3 inline-flex w-[52px] flex-shrink-0 items-center gap-1.5 tabular-nums" title="Frames per second the screen streams now. A still screen sends fewer." data-testid="device-frame-rate">
          <span className={cn('h-1.5 w-1.5 rounded-full', frameRate ? 'bg-status-success' : 'bg-status-neutral')} />
          {frameRate ?? '–'} fps
        </span>
      )}
      <span className="font-medium text-text-primary">{state.name}</span>
      {deviceCaption(state)}
    </p>
  );
}

/** The last frame of a device that is not live, faded behind its state's message. */
function useLastFrame(client: DeviceTabClient, panelId: string, deviceId: string | undefined, wanted: boolean): string | undefined {
  const [frame, setFrame] = useState<string>();
  useEffect(() => {
    if (!wanted || !deviceId) {
      setFrame(undefined);
      return;
    }
    let cancelled = false;
    void client.frame(panelId).then((next) => { if (!cancelled) setFrame(next); }, () => undefined);
    return () => { cancelled = true; };
  }, [client, panelId, deviceId, wanted]);
  return frame;
}

/** The stream's frame rate, read every second while `enabled`; null until known. */
function useFrameRate(client: DeviceTabClient, panelId: string, enabled: boolean): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !client.frameRate) {
      setRate(null);
      return;
    }
    const read = client.frameRate.bind(client);
    let cancelled = false;
    const tick = () => { void read(panelId).then((next) => { if (!cancelled) setRate(next); }, () => undefined); };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, panelId, enabled]);
  return rate;
}

/** Room under the phone for its caption. */
const FOOTER_PX = 32;

/** How long a reshape (rotate, fold, another device) stays masked while the bezel moves to its new shape. */
const TURN_MASK_MS = 220;

/**
 * The phone: a bezel at the screen's aspect ratio (width over height), as large as its box allows,
 * with its caption under it. A change of shape eases the bezel to the new size behind a mask, so
 * the screen never shows a raw resize.
 */
function PhoneFrame({ aspect, children, dashed = false, footer }: { aspect: number; children: ReactNode; dashed?: boolean; footer?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const hasFooter = footer !== undefined;
  const [size, setSize] = useState<{ width: number; height: number }>();
  const masking = useTurnMask(aspect);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => {
      const { width, height: boxHeight } = element.getBoundingClientRect();
      const height = Math.max(0, boxHeight - (hasFooter ? FOOTER_PX : 0));
      const fitted = width / height > aspect ? { width: height * aspect, height } : { width, height: width / aspect };
      setSize({ width: Math.floor(fitted.width), height: Math.floor(fitted.height) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aspect, hasFooter]);
  const short = size ? Math.min(size.width, size.height) : 0;
  const radius = Math.round(short * 0.14);
  return (
    <div ref={box} className="flex min-h-0 w-full flex-1 flex-col items-center justify-center">
      {size && (
        <>
        <div
          className={cn('relative flex-shrink-0', masking && 'transition-[width,height] duration-200 ease-out', dashed ? 'border-2 border-dashed border-border-secondary' : 'bg-device-bezel shadow-lg ring-1 ring-border-secondary')}
          style={{ width: size.width, height: size.height, borderRadius: radius, padding: dashed ? 0 : Math.max(4, Math.round(short * 0.03)) }}
        >
          <div className="relative h-full w-full overflow-hidden" style={{ borderRadius: dashed ? radius : Math.round(radius * 0.86) }}>
            {children}
            <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-device-screen transition-opacity duration-200', masking ? 'opacity-100' : 'opacity-0')} data-testid="device-turn-mask" />
          </div>
        </div>
        {footer}
        </>
      )}
    </div>
  );
}

/** True for a moment after `aspect` changes, while the frame moves to its new shape. */
function useTurnMask(aspect: number): boolean {
  const shown = useRef(aspect);
  const [masking, setReshaping] = useState(false);
  useEffect(() => {
    if (shown.current === aspect) return;
    shown.current = aspect;
    setReshaping(true);
    const timer = window.setTimeout(() => setReshaping(false), TURN_MASK_MS);
    return () => window.clearTimeout(timer);
  }, [aspect]);
  return masking;
}

/** Stream sizes step by this many pixels, so resizing the tab reconnects the stream only now and then. */
const STREAM_STEP_PX = 160;
const STREAM_RESIZE_SETTLE_MS = 400;

/**
 * The device's screen with touch. Locally it is the MJPEG stream main serves at
 * pane-media://device/<panelId>, sized to this screen box, so the hub token never reaches the
 * renderer; on another computer it is frames read over the connection, about twice a second.
 * Pointer events become normalized touches on the drawn image; moves are sent once a frame.
 */
function LiveScreen({ client, panelId, platform, onScreenSize }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; onScreenSize: (width: number, height: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const streamPx = useStreamPx(box);
  // Simulators stream MJPEG where the client can; an emulator's screen comes as frames.
  const streams = platform === 'ios' && client.streamUrl !== undefined;
  const stream = streams && streamPx ? client.streamUrl?.(panelId, streamPx) : undefined;
  const polled = useDeviceFrames(client, panelId, streams ? undefined : FRAME_POLL_MS);
  // A hidden window drops the stream, which closes its connection; the last polled frame stays.
  const pageVisible = usePageVisible();
  const src = stream ? (pageVisible ? stream : undefined) : polled;
  return (
    <div ref={box} className="absolute inset-0 bg-device-screen">
      {src && <TouchScreen client={client} panelId={panelId} platform={platform} src={src} onScreenSize={onScreenSize} />}
    </div>
  );
}

/**
 * The longest side of `box` in device pixels, rounded up to a step, for sizing the stream. It
 * follows a resize once it settles; undefined until measured.
 */
function useStreamPx(box: RefObject<HTMLDivElement | null>): number | undefined {
  const [px, setPx] = useState<number>();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let timer: number | undefined;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const longest = Math.max(width, height) * window.devicePixelRatio;
      return longest > 0 ? Math.ceil(longest / STREAM_STEP_PX) * STREAM_STEP_PX : undefined;
    };
    setPx(measure());
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { const next = measure(); if (next) setPx(next); }, STREAM_RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [box]);
  return px;
}

/** Whether the window is visible (not minimized or behind another app's full screen). */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/** How often the stream's frame size is checked: an MJPEG image changes size without an event. */
const SIZE_CHECK_MS = 250;

/** Where a pointer falls on the image as drawn (letterboxed, never cropped), from 0 to 1 on each axis. */
function pointOnImage(image: HTMLImageElement, clientX: number, clientY: number) {
  const rect = image.getBoundingClientRect();
  const natural = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : rect.width / rect.height;
  const width = Math.min(rect.width, rect.height * natural);
  const height = width / natural;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { x: (clientX - left) / width, y: (clientY - top) / height };
}

function TouchScreen({ client, panelId, platform, src, onScreenSize }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; src: string; onScreenSize: (width: number, height: number) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const down = useRef(false);
  const pendingMove = useRef<{ x: number; y: number }>(undefined);
  useEffect(() => {
    const timer = window.setInterval(() => { const element = image.current; if (element) onScreenSize(element.naturalWidth, element.naturalHeight); }, SIZE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [onScreenSize]);
  const point = (event: ReactPointerEvent<HTMLImageElement>) => pointOnImage(event.currentTarget, event.clientX, event.clientY);
  const send = (phase: 'begin' | 'move' | 'end', at: { x: number; y: number }) => {
    void client.input(panelId, { kind: 'touch', phase, x: Math.min(1, Math.max(0, at.x)), y: Math.min(1, Math.max(0, at.y)) }).catch(() => undefined);
  };
  const end = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!down.current) return;
    down.current = false;
    pendingMove.current = undefined;
    send('end', point(event));
  };
  return (
    <img
      ref={image}
      src={src}
      alt={`${platform === 'ios' ? 'iOS' : 'Android'} screen`}
      draggable={false}
      data-testid="device-screen"
      className="absolute inset-0 h-full w-full touch-none select-none object-contain"
      onLoad={(event) => onScreenSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
      onPointerDown={(event) => { down.current = true; event.currentTarget.setPointerCapture(event.pointerId); send('begin', point(event)); }}
      onPointerMove={(event) => {
        if (!down.current) return;
        const first = pendingMove.current === undefined;
        pendingMove.current = point(event);
        if (first) requestAnimationFrame(() => { const at = pendingMove.current; pendingMove.current = undefined; if (at && down.current) send('move', at); });
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}

/** What covers the screen when it is not live: installing, booting, off, in use, closed, failed. */
function PhaseOverlay({ state, busy, onBoot, onTakeOver }: { state: DevicePanelState; busy?: string; onBoot: () => void; onTakeOver: () => void }) {
  const copy = devicePhaseCopy(state);
  if (state.phase === 'live' || !copy) return null;
  const dark = state.phase === 'installing' || state.phase === 'booting';
  const icon = state.phase === 'in-use' ? <Lock className="h-5 w-5" /> : dark ? <Loader2 className="h-5 w-5 animate-spin" /> : <Power className="h-5 w-5" />;
  return (
    <div
      className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center', dark ? 'bg-device-screen text-device-screen-text' : 'bg-bg-primary/80 text-text-primary')}
      data-testid="device-overlay"
    >
      <span className="flex h-6 w-6 items-center justify-center">{icon}</span>
      <p className="text-sm font-medium">{copy.title}</p>
      {copy.detail && <p className={cn('text-xs', dark ? 'opacity-70' : 'text-text-secondary')}>{copy.detail}</p>}
      {copy.action === 'boot' && (
        <button type="button" disabled={busy !== undefined} onClick={onBoot} className="mt-1 rounded bg-interactive px-3 py-1 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-60">
          {busy ? 'Booting…' : 'Boot'}
        </button>
      )}
      {copy.action === 'take-over' && (
        <button type="button" disabled={busy !== undefined} onClick={onTakeOver} className="mt-1 rounded border border-border-primary bg-surface-primary px-3 py-1 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:opacity-60">
          Take over
        </button>
      )}
    </div>
  );
}

/** iOS on a PC with no Mac, or with its Mac offline: a message inside a dashed phone outline. */
function NoMacView({ state, panelId, client }: { state: DevicePanelState; panelId: string; client: DeviceTabClient }) {
  const openAddDevice = () => useAddDeviceStore.getState().open('computer');
  const offline = state.phase === 'mac-offline';
  return (
    <div className="flex h-full flex-col bg-bg-primary p-6" data-testid="device-panel" data-phase={state.phase}>
      <PhoneFrame aspect={DEFAULT_ASPECT.ios} dashed>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-[10%] text-center">
          <span className="flex h-6 w-6 items-center justify-center text-text-secondary">{offline ? <WifiOff className="h-5 w-5" /> : <Laptop className="h-5 w-5" />}</span>
          {offline ? (
            <>
              <p className="text-sm font-medium text-text-primary">{state.macName ?? 'Your Mac'} is offline</p>
              <p className="text-xs text-text-secondary">This PC has no Xcode, so iOS runs on that Mac. Open Pane on it, then try again.</p>
              <button type="button" onClick={() => { void client.power(panelId, 'boot').catch(() => undefined); }} className="mt-1 rounded bg-interactive px-3 py-1 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover">Try again</button>
              <button type="button" onClick={openAddDevice} className="text-xs text-interactive hover:text-interactive-hover">Link another Mac</button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-text-primary">iOS needs a Mac</p>
              <p className="text-xs text-text-secondary">This PC has no Xcode. Link a Mac to run iOS here.</p>
              <ol className="mt-1 space-y-1 text-left text-[11px] text-text-secondary">
                <li>1. On the Mac: <span className="text-text-primary">Add a device › Computer › Copy link</span></li>
                <li>2. Here: <span className="text-text-primary">Add a device › Computer</span> › paste under <span className="text-text-primary">Or finish here</span></li>
              </ol>
              <button type="button" onClick={openAddDevice} className="mt-1 rounded bg-interactive px-3 py-1 text-xs font-medium text-text-on-interactive hover:bg-interactive-hover">Add a device</button>
              <p className="font-mono text-[11px] text-text-tertiary">or runpane link &apos;&lt;link&gt;&apos;</p>
            </>
          )}
        </div>
      </PhoneFrame>
    </div>
  );
}
