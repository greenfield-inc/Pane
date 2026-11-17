import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { BookOpen, Camera, CircleDot, Columns2, Copy, Download, FileText, Home, Info, Laptop, Loader2, Lock, MoreHorizontal, Pencil, Power, RotateCcw, RotateCw, Smartphone, Square, WifiOff, X } from 'lucide-react';
import type { DeviceControls, DeviceInput, DeviceOrientation, DevicePanelState, DevicePosture, DeviceSettingsView } from '../../../../../shared/types/devices';
import { Tooltip } from '../../ui/Tooltip';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { cn } from '../../../utils/cn';
import { deviceCaption, devicePhaseCopy } from './deviceCopy';
import { requestOpenSettings } from '../../../utils/openSettings';
import { useAddDeviceStore } from '../../addDevice/addDeviceStore';
import { useConfigStore } from '../../../stores/configStore';
import { FRAME_POLL_MS, useDeviceFrames } from './deviceFrames';
import { usePanelStore } from '../../../stores/panelStore';
import { DeviceLogs } from './DeviceLogs';
import { DeviceMarkup } from './DeviceMarkup';
import { agentTabOf, captureName, clock, copyImage, deliverCapture, deliverText, saveImage, useDeviceLogs, useRecording, type CaptureNotice } from './deviceTools';
import { CaptureCard, DriverChip } from './DeviceToolViews';
import { DeviceClientContext, desktopDeviceClient, type DeviceTabClient } from './deviceClient';

/** The tab's screen size when the device has not sent a frame yet (iPhone 17 Pro points). */
const DEFAULT_ASPECT = { ios: 402 / 874, android: 412 / 915 } satisfies Record<DevicePanelState['platform'], number>;

export interface DevicePanelProps {
  panel: ToolPanel;
  isActive: boolean;
  /** The Pane's tabs, where screenshots and log lines go; the desktop reads them from its panel store. */
  panels?: readonly ToolPanel[];
}

/** Narrower than this, the rail lies under the phone as a bar (phones, a narrow split). */
const NARROW_PX = 520;

/**
 * A phone simulator or emulator's live screen: the phone at full height, a grouped
 * rail beside it (Home and Rotate; the fold postures on a foldable; Screenshot to chat, Record and
 * Mark up; Logs; More), and under it the frame rate, the device's name and who is driving. Every
 * state covers the screen inside the same frame.
 */
export function DevicePanel({ panel, isActive, panels }: DevicePanelProps) {
  // SAFETY: the panel type discriminator determines the custom-state shape.
  const state = panel.state.customState as DevicePanelState;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [bannerHidden, setBannerHidden] = useState(false);
  const live = state.phase === 'live';
  // A desktop switched to another computer reads frames from it; this one's own devices stream.
  const remote = useConfigStore(store => store.config?.remoteDaemon?.client.mode === 'remote');
  const provided = useContext(DeviceClientContext);
  const client = useMemo(() => provided ?? desktopDeviceClient(remote), [provided, remote]);
  const storePanels = usePanelStore(store => store.panels[panel.sessionId]);
  const agentTab = useMemo(() => agentTabOf(panels ?? storePanels ?? [], state.openedBy), [panels, storePanels, state.openedBy]);
  const lastFrame = useLastFrame(client, panel.id, state.deviceId, !live && state.phase !== 'booting' && state.phase !== 'installing');
  // The screen's shape as its frames show it, so landscape, an iPad or a folded phone fit uncropped.
  const [aspect, setAspect] = useState<number>(DEFAULT_ASPECT[state.platform]);
  const onScreenSize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    const next = width / height;
    setAspect(current => (Math.abs(current - next) / current < 0.01 ? current : next));
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);

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

  const [controls, refreshControls] = useDeviceControls(client, panel.id, live && isActive);
  const send = useCallback((input: DeviceInput) => { void client.input(panel.id, input).catch(() => undefined); }, [client, panel.id]);
  const act = useCallback((input: DeviceInput) => run(input.kind, async () => {
    await client.input(panel.id, input);
    refreshControls();
  }), [client, panel.id, refreshControls, run]);
  const streaming = live && isActive && client.streamUrl !== undefined && state.platform === 'ios';
  const frameRate = useFrameRate(client, panel.id, streaming);

  const [notice, setNotice] = useState<CaptureNotice>();
  const closeNotice = useCallback(() => setNotice(undefined), []);
  const [markup, setMarkup] = useState<CaptureNotice>();
  const [logsOpen, setLogsOpen] = useState(false);
  const logs = useDeviceLogs(client, panel.id, logsOpen && live);
  const recorder = useRecording(client, panel.id);
  const [recordingNote, setRecordingNote] = useState<string>();
  useEffect(() => {
    if (!recordingNote) return;
    const timer = window.setTimeout(() => setRecordingNote(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [recordingNote]);

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

  /** Screenshot to chat: a full-resolution capture, put in front of the agent unsent, then the card. */
  const screenshotToChat = useCallback(() => run('screenshot', async () => {
    const capture = await client.capture(panel.id);
    const name = captureName(state.name, 'png');
    const title = agentTab ? await deliverCapture(client, panel.id, agentTab, capture, name) : 'Screenshot saved';
    setNotice({ capture, name, title });
  }), [agentTab, client, panel.id, run, state.name]);

  const toggleRecording = useCallback(() => run('record', async () => {
    if (!recorder.recording) {
      await recorder.start();
      return;
    }
    const saved = await recorder.stop();
    const where = saved.machine ? ` on ${saved.machine}` : '';
    // A terminal agent gets the video's path at its prompt, as a screenshot's.
    const staged = agentTab?.kind === 'terminal' && !saved.machine;
    if (staged) await client.stage(panel.id, agentTab.id, `${saved.path} `);
    setRecordingNote(`Recording saved${where}${staged ? `, path typed at ${agentTab.agent}'s prompt` : ''}: ${saved.path}`);
  }), [agentTab, client, panel.id, recorder, run]);

  const markUp = useCallback(() => run('markup', async () => {
    const capture = await client.capture(panel.id);
    setMarkup({ capture, name: captureName(state.name, 'png'), title: '' });
  }), [client, panel.id, run, state.name]);

  /** Keys while the tab has focus: the simulator's shortcuts, then typing into the device. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only keys pressed on the tab itself: a focused button, the logs or a text field keep theirs.
    if (!live || markup || event.target !== event.currentTarget) return;
    const mod = event.metaKey || event.ctrlKey;
    const shortcut = mod && event.shiftKey && event.key.toLowerCase() === 'h' ? () => send({ kind: 'button', button: 'home' })
      : mod && event.key === 'ArrowRight' && controls.orientation ? () => { void act({ kind: 'rotate', orientation: nextOrientation(controls.orientation) }); }
      : mod && !event.shiftKey && event.key.toLowerCase() === 's' ? () => { void screenshotToChat(); }
      : mod && !event.shiftKey && event.key.toLowerCase() === 'r' ? () => { void toggleRecording(); }
      : undefined;
    if (shortcut) {
      event.preventDefault();
      shortcut();
      return;
    }
    if (mod || event.altKey || event.key.length > 1 && !TYPED_KEYS.has(event.key)) return;
    event.preventDefault();
    send({ kind: 'key', key: event.key });
  };

  if (state.phase === 'no-mac' || state.phase === 'mac-offline') {
    return <NoMacView state={state} panelId={panel.id} client={client} />;
  }

  const showBanner = !bannerHidden && state.machineReason && state.machineReason.kind !== 'local';
  const moreItems: DropdownItem[] = [
    { id: 'copy', label: 'Copy screenshot', icon: Copy, onClick: () => { void run('copy', async () => copyImage((await client.capture(panel.id)).dataUrl)); }, disabled: !live },
    { id: 'save', label: 'Save screenshot', icon: Download, onClick: () => { void run('save', async () => saveImage((await client.capture(panel.id)).dataUrl, captureName(state.name, 'png'))); }, disabled: !live },
    { id: 'restart', label: 'Restart', icon: RotateCcw, separatorBefore: true, onClick: () => { void run('restart', () => client.power(panel.id, 'restart')); }, disabled: !live },
    { id: 'shutdown', label: 'Shut down', icon: Power, onClick: () => { void run('shutdown', () => client.power(panel.id, 'shutdown')); }, disabled: !live },
  ];
  const agentDriving = state.driver?.by === 'agent';

  const rail = (
    <div className={cn('flex flex-shrink-0 items-center gap-1 rounded-full border border-border-primary bg-surface-primary p-1 shadow-sm', narrow ? 'flex-row self-center' : 'flex-col self-center')} data-testid="device-rail">
      <RailButton label="Home" shortcut="⇧⌘H" disabled={!live} onClick={() => send({ kind: 'button', button: 'home' })}><Home className="h-4 w-4" /></RailButton>
      <RailButton label="Rotate" shortcut="⌘→" disabled={!live || !controls.orientation} onClick={() => { void act({ kind: 'rotate', orientation: nextOrientation(controls.orientation) }); }}><RotateCw className="h-4 w-4" /></RailButton>
      {controls.fold && (
        <>
          <RailDivider vertical={narrow} />
          {FOLDS.map(({ posture, label, Icon }) => (
            <RailButton key={posture} label={label} disabled={!live} selected={controls.fold?.posture === posture} onClick={() => { void act({ kind: 'fold', posture }); }}><Icon className="h-4 w-4" /></RailButton>
          ))}
        </>
      )}
      <RailDivider vertical={narrow} />
      <RailButton label={agentTab ? 'Screenshot to chat' : 'Screenshot'} shortcut="⌘S" accent disabled={!live || busy === 'screenshot'} onClick={() => { void screenshotToChat(); }}><Camera className="h-4 w-4" /></RailButton>
      <RailButton label={recorder.recording ? `Stop recording (${clock(recorder.elapsed)})` : 'Record'} shortcut="⌘R" disabled={!live || busy === 'record'} selected={recorder.recording} onClick={() => { void toggleRecording(); }}>
        {recorder.recording ? <Square className="h-3.5 w-3.5 fill-current text-status-error" /> : <CircleDot className="h-4 w-4" />}
      </RailButton>
      <RailButton label="Mark up" disabled={!live || busy === 'markup'} onClick={() => { void markUp(); }}><Pencil className="h-4 w-4" /></RailButton>
      <RailDivider vertical={narrow} />
      <RailButton label="Logs" disabled={!live} selected={logsOpen} onClick={() => setLogsOpen(open => !open)}><FileText className="h-4 w-4" /></RailButton>
      <Dropdown trigger={<RailButton label="More" disabled={false}><MoreHorizontal className="h-4 w-4" /></RailButton>} items={moreItems} position="bottom-right" width="sm" />
    </div>
  );

  return (
    <div ref={root} className="flex h-full flex-col bg-bg-primary outline-none" data-testid="device-panel" data-phase={state.phase} tabIndex={-1} onKeyDown={onKeyDown}>
      {showBanner && state.machineReason && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-bg-chrome px-3 py-1.5 text-xs text-text-secondary">
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 truncate">{state.machineReason.text}</span>
          {!provided && <MacMenu />}
          <button type="button" aria-label="Hide" className="text-text-tertiary hover:text-text-primary" onClick={() => setBannerHidden(true)}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <div className={cn('relative flex min-h-0 flex-1 items-center justify-center gap-3 p-4', narrow && 'flex-col')}>
        <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center justify-center">
          <PhoneFrame aspect={aspect} highlighted={agentDriving} footer={(
            <DeviceCaption state={state} frameRate={streaming ? frameRate : undefined} recording={recorder.recording ? recorder.elapsed : undefined} compact={narrow && state.driver !== undefined}>
              <DriverChip
                driver={state.driver}
                agentName={agentTab?.agent}
                onTakeOver={() => { void run('driver', () => client.driver(panel.id, 'person')); }}
                onHandBack={() => { void run('driver', () => client.driver(panel.id, 'agent')); }}
              />
            </DeviceCaption>
          )}>
            {live && isActive ? <LiveScreen client={client} panelId={panel.id} platform={state.platform} onScreenSize={onScreenSize} onInput={send} /> : (
              <div className="absolute inset-0 bg-device-screen">
                {lastFrame && <img src={lastFrame} alt="" className="h-full w-full object-contain opacity-60" onLoad={(event) => onScreenSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />}
              </div>
            )}
            <PhaseOverlay state={state} busy={busy} onBoot={() => run('boot', () => client.power(panel.id, 'boot'))} onTakeOver={() => run('take-over', () => client.takeOver(panel.id))} />
          </PhoneFrame>
          {error && <p className="mt-1 max-w-sm text-center text-xs text-status-error" role="alert">{error}</p>}
          {recordingNote && !error && <p className="mt-1 max-w-sm truncate text-center text-xs text-text-secondary" title={recordingNote}>{recordingNote}</p>}
        </div>
        {rail}
        {notice && !markup && (
          <CaptureCard
            key={notice.capture.dataUrl.length + notice.name}
            notice={notice}
            onCopy={() => { void run('copy', () => copyImage(notice.capture.dataUrl)); }}
            onSave={() => saveImage(notice.capture.dataUrl, notice.name)}
            onMarkUp={() => { setMarkup(notice); setNotice(undefined); }}
            onClose={closeNotice}
          />
        )}
        {markup && (
          <DeviceMarkup
            image={markup.capture.dataUrl}
            canSendToChat={agentTab !== undefined}
            onCancel={() => setMarkup(undefined)}
            onDone={(png, action) => {
              setMarkup(undefined);
              void run('markup', async () => {
                if (action === 'copy' || !agentTab) {
                  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
                  return;
                }
                const dataUrl = await blobDataUrl(png);
                // A terminal agent needs the image as a file on the host; a chat takes it directly.
                const capture = agentTab.kind === 'terminal' ? await client.capture(panel.id, dataUrl) : { path: '', dataUrl };
                setNotice({ capture, name: markup.name, title: await deliverCapture(client, panel.id, agentTab, capture, markup.name) });
              });
            }}
          />
        )}
      </div>
      {logsOpen && live && (
        <div className="h-[38%] min-h-[140px] flex-shrink-0">
          <DeviceLogs
            lines={logs.lines}
            problem={logs.problem}
            canSendToChat={agentTab !== undefined}
            onClose={() => setLogsOpen(false)}
            onToChat={(text) => { if (agentTab) void run('logs', () => deliverText(client, panel.id, agentTab, text, captureName(`${state.name} log`, 'txt'))); }}
          />
        </div>
      )}
    </div>
  );
}

/** Keys with names that type into the device; other named keys (F1, Shift…) stay with Pane. */
const TYPED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result instanceof ArrayBuffer || reader.result === null ? reject(new Error('The image could not be read')) : resolve(reader.result));
    reader.onerror = () => reject(new Error('The image could not be read'));
    reader.readAsDataURL(blob);
  });
}

/** Whether `root` is narrower than NARROW_PX, so the rail becomes a bar under the phone. */
function useNarrow(root: RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setNarrow(element.getBoundingClientRect().width < NARROW_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return narrow;
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

/** The fold postures a foldable offers, in the rail's order. */
const FOLDS: { posture: DevicePosture; label: string; Icon: typeof Smartphone }[] = [
  { posture: 'closed', label: 'Closed', Icon: Smartphone },
  { posture: 'half', label: 'Half open', Icon: BookOpen },
  { posture: 'open', label: 'Open', Icon: Columns2 },
];

const ORIENTATIONS: DeviceOrientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'];

/** A quarter turn on from `orientation`, as Rotate turns the device. */
function nextOrientation(orientation: DeviceOrientation | undefined): DeviceOrientation {
  return ORIENTATIONS[(ORIENTATIONS.indexOf(orientation ?? 'portrait') + 1) % ORIENTATIONS.length];
}

/** How often a live tab rereads the device's turn and fold, so a change an agent makes shows in the rail. */
const CONTROLS_POLL_MS = 2_000;

/** What the device can do and how it is turned and folded; the second value rereads it now. */
function useDeviceControls(client: DeviceTabClient, panelId: string, enabled: boolean): [DeviceControls, () => void] {
  const [controls, setControls] = useState<DeviceControls>({});
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const read = () => { void client.controls(panelId).then((next) => { if (!cancelled) setControls(current => (JSON.stringify(current) === JSON.stringify(next) ? current : next)); }, () => undefined); };
    read();
    const timer = window.setInterval(read, CONTROLS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, panelId, enabled, generation]);
  return [controls, useCallback(() => setGeneration(value => value + 1), [])];
}

function RailDivider({ vertical = false }: { vertical?: boolean }) {
  return <div className={vertical ? 'mx-0.5 h-5 w-px bg-border-primary' : 'my-0.5 h-px w-5 bg-border-primary'} />;
}

function RailButton({ label, shortcut, disabled, selected = false, accent = false, onClick, children }: { label: string; shortcut?: string; disabled: boolean; selected?: boolean; accent?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip side="left" content={shortcut ? <span className="flex items-center gap-2">{label}<span className="text-text-tertiary">{shortcut}</span></span> : label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected || undefined}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent',
          selected && 'bg-surface-hover text-text-primary',
          accent && 'text-interactive hover:text-interactive-hover',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** The line under the phone. `compact` (a narrow tab showing who drives) leaves the name to the tab's title. */
function DeviceCaption({ state, frameRate, recording, compact = false, children }: { state: DevicePanelState; frameRate?: number | null; recording?: number; compact?: boolean; children?: ReactNode }) {
  if (compact) return <div className="mt-2 flex h-6 w-full min-w-0 items-center justify-center text-xs text-text-tertiary" data-testid="device-caption">{children}</div>;
  return (
    // Three columns, so the name stays centred under the phone as the readouts and the chip come and go.
    <div className="mt-2 grid h-6 w-full grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-3 whitespace-nowrap text-xs text-text-tertiary" data-testid="device-caption">
      <span className="flex min-w-0 justify-end">
      {recording !== undefined && (
        <span className="ml-3 inline-flex w-[56px] flex-shrink-0 items-center gap-1.5 tabular-nums text-status-error" data-testid="device-recording">
          <span className="h-1.5 w-1.5 rounded-full bg-status-error" />
          {clock(recording)}
        </span>
      )}
      {frameRate !== undefined && (
        // A fixed box, so the caption never shifts as the number changes.
        <span className="ml-3 inline-flex w-[52px] flex-shrink-0 items-center gap-1.5 tabular-nums" title="Frames per second the screen streams now. A still screen sends fewer." data-testid="device-frame-rate">
          <span className={cn('h-1.5 w-1.5 rounded-full', frameRate ? 'bg-status-success' : 'bg-status-neutral')} />
          {frameRate ?? '–'} fps
        </span>
      )}
      </span>
      <span className="min-w-0 truncate"><span className="font-medium text-text-primary">{state.name}</span>{deviceCaption(state)}</span>
      <span className="flex min-w-0 justify-start">{children}</span>
    </div>
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
function PhoneFrame({ aspect, children, dashed = false, highlighted = false, footer }: { aspect: number; children: ReactNode; dashed?: boolean; highlighted?: boolean; footer?: ReactNode }) {
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
          className={cn('relative flex-shrink-0', masking && 'transition-[width,height] duration-200 ease-out', dashed ? 'border-2 border-dashed border-border-secondary' : 'bg-device-bezel shadow-lg ring-1 ring-border-secondary', highlighted && 'outline outline-2 outline-offset-4 outline-interactive')}
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
function LiveScreen({ client, panelId, platform, onScreenSize, onInput }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; onScreenSize: (width: number, height: number) => void; onInput: (input: DeviceInput) => void }) {
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
      {src && <TouchScreen client={client} panelId={panelId} platform={platform} src={src} onScreenSize={onScreenSize} onInput={onInput} />}
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

function TouchScreen({ client, panelId, platform, src, onScreenSize, onInput }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; src: string; onScreenSize: (width: number, height: number) => void; onInput: (input: DeviceInput) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const down = useRef(false);
  // Wheel and trackpad scrolls, gathered into one scroll a frame, as fractions of the screen.
  const pendingScroll = useRef<{ x: number; y: number; dx: number; dy: number }>(undefined);
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
      onWheel={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const at = pointOnImage(event.currentTarget, event.clientX, event.clientY);
        const first = pendingScroll.current === undefined;
        const previous = pendingScroll.current ?? { ...at, dx: 0, dy: 0 };
        pendingScroll.current = { ...previous, dx: previous.dx + event.deltaX / rect.width, dy: previous.dy + event.deltaY / rect.height };
        if (first) requestAnimationFrame(() => { const scroll = pendingScroll.current; pendingScroll.current = undefined; if (scroll) onInput({ kind: 'scroll', ...scroll }); });
      }}
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
