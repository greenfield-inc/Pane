import { useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
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
  }, [client, panel.id, state.deviceId, isActive]);

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
          <PhoneFrame platform={state.platform} footer={<DeviceCaption state={state} />}>
            {live && isActive ? <LiveScreen client={client} panelId={panel.id} platform={state.platform} /> : (
              <div className="absolute inset-0 bg-device-screen">
                {lastFrame && <img src={lastFrame} alt="" className="h-full w-full object-cover opacity-60" />}
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

function DeviceCaption({ state }: { state: DevicePanelState }) {
  return (
    <p className="mt-3 truncate text-xs text-text-tertiary" data-testid="device-caption">
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

/** Room under the phone for its caption. */
const FOOTER_PX = 32;

/** The phone: a bezel at the screen's aspect ratio, as large as its box allows, with its caption under it. */
function PhoneFrame({ platform, children, dashed = false, footer }: { platform: DevicePanelState['platform']; children: ReactNode; dashed?: boolean; footer?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const hasFooter = footer !== undefined;
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const aspect = DEFAULT_ASPECT[platform];
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
  }, [platform, hasFooter]);
  const radius = size ? Math.round(size.width * 0.14) : 0;
  return (
    <div ref={box} className="flex min-h-0 w-full flex-1 flex-col items-center justify-center">
      {size && (
        <>
        <div
          className={cn('relative flex-shrink-0', dashed ? 'border-2 border-dashed border-border-secondary' : 'bg-device-bezel shadow-lg')}
          style={{ width: size.width, height: size.height, borderRadius: radius, padding: dashed ? 0 : Math.max(4, Math.round(size.width * 0.03)) }}
        >
          <div className="relative h-full w-full overflow-hidden" style={{ borderRadius: dashed ? radius : Math.round(radius * 0.86) }}>{children}</div>
        </div>
        {footer}
        </>
      )}
    </div>
  );
}

/**
 * The device's screen with touch. Locally it is the MJPEG stream main serves at
 * pane-media://device/<panelId>, so the hub token never reaches the renderer; on another computer
 * it is frames read over the connection, about twice a second. Pointer events become normalized
 * touches; moves are sent once a frame.
 */
function LiveScreen({ client, panelId, platform }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform'] }) {
  const stream = client.streamUrl(panelId);
  const polled = useDeviceFrames(client, panelId, stream ? undefined : FRAME_POLL_MS);
  const src = stream ?? polled;
  return src ? <TouchScreen client={client} panelId={panelId} platform={platform} src={src} /> : <div className="absolute inset-0 bg-device-screen" />;
}

function TouchScreen({ client, panelId, platform, src }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; src: string }) {
  const down = useRef(false);
  const pendingMove = useRef<{ x: number; y: number }>(undefined);
  const point = (event: ReactPointerEvent<HTMLImageElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
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
      src={src}
      alt={`${platform === 'ios' ? 'iOS' : 'Android'} screen`}
      draggable={false}
      data-testid="device-screen"
      className="absolute inset-0 h-full w-full touch-none select-none object-cover"
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
      className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center', dark ? 'bg-device-screen text-text-interactive-on-dark' : 'bg-bg-primary/90 text-text-primary backdrop-blur-sm')}
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
      <PhoneFrame platform="ios" dashed>
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
