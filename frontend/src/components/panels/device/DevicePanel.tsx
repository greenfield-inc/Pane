import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { BookOpen, Camera, CircleDot, Columns2, Copy, Download, FileText, Home, Info, Laptop, Loader2, Lock, MoreHorizontal, Pencil, Power, RotateCcw, RotateCw, Smartphone, Square, WifiOff, X } from 'lucide-react';
import type { DeviceControls, DeviceInput, DeviceOrientation, DevicePanelState, DevicePosture, DeviceSettingsView } from '../../../../../shared/types/devices';
import { Tooltip } from '../../ui/Tooltip';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { cn } from '../../../utils/cn';
import { deviceCaption, devicePhaseCopy, recordingEndCopy } from './deviceCopy';
import { deviceInputQueue } from './deviceInputQueue';
import { frameDelta, framePoint, screenTurn, type ScreenTurn } from './deviceTurn';
import { requestOpenSettings } from '../../../utils/openSettings';
import { useAddDeviceStore } from '../../addDevice/addDeviceStore';
import { useConfigStore } from '../../../stores/configStore';
import { FRAME_POLL_MS, useDeviceFrames } from './deviceFrames';
import { usePanelStore } from '../../../stores/panelStore';
import { DeviceLogs } from './DeviceLogs';
import { DeviceMarkup } from './DeviceMarkup';
import { captureName, clock, copyImage, deliverCapture, deliverText, saveImage, useDeviceLogs, useRecording, type CaptureNotice } from './deviceTools';
import { CaptureCard, DriverChip } from './DeviceToolViews';
import { agentTabOf } from '../../../../../shared/deviceAgentTab';
import { DeviceClientContext, desktopDeviceClient, type DeviceTabClient } from './deviceClient';
import { DeviceScreenSkeleton } from './DeviceScreenSkeleton';
import { useSkeletonHold } from '../../ui/Skeleton';

/** The tab's screen size when the device has not sent a frame yet (iPhone 17 Pro points). */
const DEFAULT_ASPECT = { ios: 402 / 874, android: 412 / 915 } satisfies Record<DevicePanelState['platform'], number>;

/** Each tab's screen shape as its last frame showed it, so the tab mounted again opens in that shape. */
const screenAspects = new Map<string, number>();

export interface DevicePanelProps {
  panel: ToolPanel;
  isActive: boolean;
  /** The Pane's tabs, where screenshots and log lines go; the desktop reads them from its panel store. */
  panels?: readonly ToolPanel[];
}

/** Narrower than this, the rail lies under the phone as a bar (phones, a narrow split). */
const NARROW_PX = 520;
/** Narrower than this, the bar wraps onto rows, which read best without the group dividers. */
const ONE_ROW_PX = 380;

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
  // The host names its own machine "This Mac"; a desktop showing it from another computer names that computer.
  const hostName = useConfigStore(store => {
    const remoteClient = store.config?.remoteDaemon?.client;
    return remoteClient?.mode === 'remote' ? remoteClient.computers.find(computer => computer.id === remoteClient.activeProfileId)?.label : undefined;
  });
  const captionState = hostName && !state.machineId ? { ...state, machine: hostName } : state;
  const provided = useContext(DeviceClientContext);
  const client = useMemo(() => provided ?? desktopDeviceClient(remote), [provided, remote]);
  const storePanels = usePanelStore(store => store.panels[panel.sessionId]);
  const agentTab = useMemo(() => agentTabOf(panels ?? storePanels ?? [], state.openedBy), [panels, storePanels, state.openedBy]);
  const lastFrame = useLastFrame(client, panel.id, state.deviceId, !live && state.phase !== 'booting' && state.phase !== 'installing');
  // The screen's shape as its frames show it, so landscape, an iPad or a folded phone fit uncropped.
  const [aspect, setAspect] = useState<number>(() => screenAspects.get(panel.id) ?? DEFAULT_ASPECT[state.platform]);
  const onScreenSize = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    const next = width / height;
    screenAspects.set(panel.id, next);
    setAspect(current => (Math.abs(current - next) / current < 0.01 ? current : next));
  }, [panel.id]);
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const narrow = width < NARROW_PX;
  const wraps = width < ONE_ROW_PX;

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

  const pageVisible = usePageVisible();
  const shown = live && isActive && pageVisible;
  const streaming = live && isActive && client.streamUrl !== undefined && state.platform === 'ios';
  const [controls, frameRate, refreshControls] = useDeviceStatus(client, panel.id, shown, streaming);
  // Booting (or reaching a linked Mac), then until the shown screen paints its first frame: a skeleton.
  // A hidden window starts no wait, so showing it again gets the full delay before any bones.
  const [painted, setPainted] = useState(false);
  const skeletonChain = `device:${panel.id}`;
  const screenHold = useSkeletonHold(state.phase === 'booting' || (shown && !painted), skeletonChain);
  // A frame read right after each input lands, so a remote screen shows it without waiting for the next poll.
  const readFrameNow = useRef<() => void>(() => undefined);
  const send = useMemo(() => deviceInputQueue(input => client.input(panel.id, input), () => readFrameNow.current()), [client, panel.id]);
  const act = useCallback((input: DeviceInput) => run(input.kind, async () => {
    await client.input(panel.id, input);
    refreshControls();
  }), [client, panel.id, refreshControls, run]);

  const [notice, setNotice] = useState<CaptureNotice>();
  const closeNotice = useCallback(() => setNotice(undefined), []);
  const [markup, setMarkup] = useState<CaptureNotice>();
  const [logsOpen, setLogsOpen] = useState(false);
  const logs = useDeviceLogs(client, panel.id, logsOpen && shown);
  const recorder = useRecording(client, panel.id, state.recording?.startedAt);
  const recordingNote = useRecordingNote(state.recordingEnded);
  /** The recording whose path this tab typed at the agent's prompt, and that agent. */
  const [staged, setStaged] = useState<{ path: string; agent: string }>();

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
    // A terminal agent gets the video's path at its prompt, as a screenshot's.
    if (agentTab?.kind === 'terminal' && !saved.machine) {
      await client.stage(panel.id, agentTab.id, `${saved.path} `);
      setStaged({ path: saved.path, agent: agentTab.agent });
    }
  }), [agentTab, client, panel.id, recorder, run]);

  /** The screenshot on screen in the card, or a new one: Copy, Save and Mark up reuse one capture. */
  const currentCapture = useCallback(async () => notice?.capture ?? client.capture(panel.id), [client, notice, panel.id]);
  const markUp = useCallback(() => run('markup', async () => {
    const capture = await currentCapture();
    setMarkup({ capture, name: captureName(state.name, 'png'), title: '' });
  }), [currentCapture, run, state.name]);

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
    { id: 'copy', label: 'Copy screenshot', icon: Copy, onClick: () => { void run('copy', async () => copyImage((await currentCapture()).dataUrl)); }, disabled: !live },
    { id: 'save', label: 'Save screenshot', icon: Download, onClick: () => { void run('save', async () => saveImage((await currentCapture()).dataUrl, captureName(state.name, 'png'))); }, disabled: !live },
    { id: 'restart', label: 'Restart', icon: RotateCcw, separatorBefore: true, onClick: () => { void run('restart', () => client.power(panel.id, 'restart')); }, disabled: !live },
    { id: 'shutdown', label: 'Shut down', icon: Power, onClick: () => { void run('shutdown', () => client.power(panel.id, 'shutdown')); }, disabled: !live },
  ];
  const agentDriving = state.driver?.by === 'agent';

  const rail = (
    // In a narrow tab the rail wraps onto rows under the phone, so every control stays inside the tab.
    <div className={cn('flex flex-shrink-0 items-center gap-1 border border-border-primary bg-surface-primary p-1 shadow-sm', narrow ? 'max-w-full flex-row flex-wrap justify-center self-center rounded-2xl' : 'flex-col self-center rounded-full')} data-testid="device-rail">
      <RailButton label="Home" shortcut="⇧⌘H" disabled={!live} onClick={() => send({ kind: 'button', button: 'home' })}><Home className="h-4 w-4" /></RailButton>
      <RailButton label="Rotate" shortcut="⌘→" disabled={!live || !controls.orientation} onClick={() => { void act({ kind: 'rotate', orientation: nextOrientation(controls.orientation) }); }}><RotateCw className="h-4 w-4" /></RailButton>
      {controls.fold && (
        <>
          {!wraps && <RailDivider vertical={narrow} />}
          {FOLDS.map(({ posture, label, Icon }) => (
            <RailButton key={posture} label={label} disabled={!live} selected={controls.fold?.posture === posture} onClick={() => { void act({ kind: 'fold', posture }); }}><Icon className="h-4 w-4" /></RailButton>
          ))}
        </>
      )}
      {!wraps && <RailDivider vertical={narrow} />}
      <RailButton label={agentTab ? 'Screenshot to chat' : 'Screenshot'} shortcut="⌘S" accent disabled={!live || busy === 'screenshot'} onClick={() => { void screenshotToChat(); }}><Camera className="h-4 w-4" /></RailButton>
      <RailButton label={recorder.recording ? `Stop recording (${clock(recorder.elapsed)})` : 'Record'} shortcut="⌘R" disabled={!live || busy === 'record'} selected={recorder.recording} onClick={() => { void toggleRecording(); }}>
        {recorder.recording ? <Square className="h-3.5 w-3.5 fill-current text-status-error" /> : <CircleDot className="h-4 w-4" />}
      </RailButton>
      <RailButton label="Mark up" disabled={!live || busy === 'markup'} onClick={() => { void markUp(); }}><Pencil className="h-4 w-4" /></RailButton>
      {!wraps && <RailDivider vertical={narrow} />}
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
            <DeviceCaption state={captionState} frameRate={streaming ? frameRate : undefined} recording={recorder.recording ? recorder.elapsed : undefined} compact={narrow && state.driver !== undefined}>
              <DriverChip
                driver={state.driver}
                agentName={agentTab?.agent}
                onTakeOver={() => { void run('driver', () => client.driver(panel.id, 'person')); }}
                onHandBack={() => { void run('driver', () => client.driver(panel.id, 'agent')); }}
              />
            </DeviceCaption>
          )}>
            {live && isActive ? <LiveScreen client={client} panelId={panel.id} platform={state.platform} orientation={controls.orientation} onScreenSize={onScreenSize} onPainted={setPainted} onInput={send} readFrameNow={readFrameNow} /> : (
              <div className="absolute inset-0 bg-device-screen">
                {lastFrame && <img src={lastFrame} alt="" className="h-full w-full object-contain opacity-60" onLoad={(event) => onScreenSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />}
              </div>
            )}
            {(screenHold.holding || screenHold.reveal) && (
              <DeviceScreenSkeleton chain={skeletonChain} label={state.phase === 'booting' ? `Booting ${state.name}` : `Connecting to ${state.name}`} fading={!screenHold.holding} />
            )}
            <PhaseOverlay state={state} busy={busy} onBoot={() => run('boot', () => client.power(panel.id, 'boot'))} onTakeOver={() => run('take-over', () => client.takeOver(panel.id))} />
          </PhoneFrame>
          {error && <p className="mt-1 max-w-sm text-center text-xs text-status-error" role="alert">{error}</p>}
          {recordingNote && !error && (
            <p className="mt-1 max-w-md break-words text-center text-xs text-text-secondary" role="status" data-testid="device-recording-note">
              {recordingNote.text}
              {staged && staged.path === recordingNote.path && ` Its path is typed at ${staged.agent}'s prompt.`}
            </p>
          )}
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
                  await copyImage(png);
                  return;
                }
                // A terminal agent needs the image as a file on the host; a chat takes it directly.
                const capture = agentTab.kind === 'terminal' ? await client.capture(panel.id, png) : { path: '', dataUrl: png };
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

/** How long the note under the phone says how a recording ended. */
const RECORDING_NOTE_MS = 15_000;

/**
 * How the tab's last recording ended, for the note under the phone: shown when it ends while the
 * tab is open (not for one that ended before), for RECORDING_NOTE_MS.
 */
function useRecordingNote(ended: DevicePanelState['recordingEnded']): { text: string; path?: string } | undefined {
  // Every panel update brings a new object, so the note follows the end's time, not the object.
  const at = ended?.at;
  const firstSeen = useRef(at);
  const [shownAt, setShownAt] = useState<number>();
  useEffect(() => {
    if (at === undefined || at === firstSeen.current) return;
    setShownAt(at);
    const timer = window.setTimeout(() => setShownAt(undefined), RECORDING_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [at]);
  return ended && shownAt === ended.at ? { text: recordingEndCopy(ended), path: ended.recording?.path } : undefined;
}

/** Keys with names that type into the device; other named keys (F1, Shift…) stay with Pane. */
const TYPED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** The width of `root` as it resizes; Infinity until measured, so the rail starts beside the phone. */
function useWidth(root: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return width;
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

/** How often a shown, live tab rereads the device's turn and fold and its frame rate. */
const STATUS_POLL_MS = 2_000;

/**
 * The device's turn and fold, and the stream's frame rate when `frameRate` is set, read every
 * 2 s while `enabled` (the tab shown in a visible window), each read after the last answered.
 * The second value rereads now.
 */
function useDeviceStatus(client: DeviceTabClient, panelId: string, enabled: boolean, frameRate: boolean): [DeviceControls, number | null, () => void] {
  const [controls, setControls] = useState<DeviceControls>({});
  const [rate, setRate] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const [next, fps] = await Promise.all([
        client.controls(panelId).catch(() => undefined),
        frameRate && client.frameRate ? client.frameRate(panelId).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (next) setControls(current => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      setRate(fps);
      timer = window.setTimeout(() => { void tick(); }, STATUS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, panelId, enabled, frameRate, generation]);
  return [controls, enabled && frameRate ? rate : null, useCallback(() => setGeneration(value => value + 1), [])];
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
function LiveScreen({ client, panelId, platform, orientation, onScreenSize, onPainted, onInput, readFrameNow }: { client: DeviceTabClient; panelId: string; platform: DevicePanelState['platform']; orientation: DeviceOrientation | undefined; onScreenSize: (width: number, height: number) => void; onPainted: (painted: boolean) => void; onInput: (input: DeviceInput) => void; readFrameNow: RefObject<() => void> }) {
  const box = useRef<HTMLDivElement>(null);
  const streamPx = useStreamPx(box);
  // Simulators stream MJPEG where the client can; an emulator's screen comes as frames, sized to this box.
  const streams = platform === 'ios' && client.streamUrl !== undefined;
  const stream = streams && streamPx ? client.streamUrl?.(panelId, streamPx) : undefined;
  // A client without a local stream reads frames over a connection: sized to this box so the host
  // sends no pixels the tab throws away. This desktop's own Android frames come whole, over IPC.
  const remoteFrames = client.streamUrl === undefined;
  const [polled, readNow] = useDeviceFrames(client, panelId, streams || !streamPx ? undefined : FRAME_POLL_MS, remoteFrames ? streamPx : undefined);
  useEffect(() => {
    readFrameNow.current = readNow;
    return () => { readFrameNow.current = () => undefined; };
  }, [readFrameNow, readNow]);
  // A hidden window drops the stream, which closes its connection; the last polled frame stays.
  const pageVisible = usePageVisible();
  const src = stream ? (pageVisible ? stream : undefined) : polled;
  // Painted once the image has a frame; not while it has no source, nor once this screen is gone.
  useEffect(() => { if (!src) onPainted(false); }, [src, onPainted]);
  useEffect(() => () => onPainted(false), [onPainted]);
  const onFrameSize = useCallback((width: number, height: number) => {
    if (width > 0 && height > 0) onPainted(true);
    onScreenSize(width, height);
  }, [onPainted, onScreenSize]);
  return (
    <div ref={box} className="absolute inset-0 bg-device-screen">
      {/* A simulator streams its portrait framebuffer however the device turns, as Simulator shows it before turning the window. */}
      {src && <TouchScreen platform={platform} orientation={platform === 'ios' ? orientation : undefined} box={box} src={src} onScreenSize={onFrameSize} onInput={onInput} />}
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

/**
 * Where a pointer falls on the image as drawn (letterboxed, never cropped, turned `turn` degrees),
 * from 0 to 1 on each axis of the upright screen.
 */
function pointOnImage(image: HTMLImageElement, clientX: number, clientY: number, turn: ScreenTurn = 0) {
  // The bounding box of a turned image is the upright screen's box.
  const rect = image.getBoundingClientRect();
  const sideways = turn === 90 || turn === 270;
  const natural = image.naturalWidth > 0 && image.naturalHeight > 0 ? (sideways ? image.naturalHeight / image.naturalWidth : image.naturalWidth / image.naturalHeight) : rect.width / rect.height;
  const width = Math.min(rect.width, rect.height * natural);
  const height = width / natural;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  return { x: (clientX - left) / width, y: (clientY - top) / height };
}

/** The size of `box` as it resizes. */
function useBoxSize(box: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => { const { width, height } = element.getBoundingClientRect(); setSize(current => (current.width === width && current.height === height ? current : { width, height })); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return size;
}

/**
 * The device's screen as an image that takes touches. A simulator turned to landscape still
 * streams a portrait frame, so the image is turned upright and touches are turned back onto the frame.
 */
function TouchScreen({ platform, orientation, box, src, onScreenSize, onInput }: { platform: DevicePanelState['platform']; orientation: DeviceOrientation | undefined; box: RefObject<HTMLDivElement | null>; src: string; onScreenSize: (width: number, height: number) => void; onInput: (input: DeviceInput) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const down = useRef(false);
  // Wheel and trackpad scrolls, gathered into one scroll a frame, as fractions of the screen.
  const pendingScroll = useRef<{ x: number; y: number; dx: number; dy: number }>(undefined);
  const pendingMove = useRef<{ x: number; y: number }>(undefined);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const turn = screenTurn(orientation, natural.width, natural.height);
  const sideways = turn === 90 || turn === 270;
  const boxSize = useBoxSize(box);
  useEffect(() => {
    const measure = () => {
      const element = image.current;
      if (!element) return;
      const { naturalWidth: width, naturalHeight: height } = element;
      setNatural(current => (current.width === width && current.height === height ? current : { width, height }));
      // The phone takes the shape the person sees: a turned frame's sides swap.
      if (sideways) onScreenSize(height, width);
      else onScreenSize(width, height);
    };
    measure();
    const timer = window.setInterval(measure, SIZE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [onScreenSize, sideways]);
  const point = (event: ReactPointerEvent<HTMLImageElement>) => framePoint(turn, pointOnImage(event.currentTarget, event.clientX, event.clientY, turn));
  const send = (phase: 'begin' | 'move' | 'end', at: { x: number; y: number }) => {
    onInput({ kind: 'touch', phase, x: Math.min(1, Math.max(0, at.x)), y: Math.min(1, Math.max(0, at.y)) });
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
      className={cn('absolute touch-none select-none object-contain', turn === 0 && 'inset-0 h-full w-full')}
      // A sideways image is laid out with the box's sides swapped, then turned to fill it.
      style={turn === 0 ? undefined : sideways
        ? { width: boxSize.height, height: boxSize.width, left: (boxSize.width - boxSize.height) / 2, top: (boxSize.height - boxSize.width) / 2, transform: `rotate(${turn}deg)` }
        : { inset: 0, width: '100%', height: '100%', transform: `rotate(${turn}deg)` }}
      // The first frame paints now, not at the next size check, so the skeleton lifts with it.
      onLoad={(event) => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        setNatural({ width, height });
        if (sideways) onScreenSize(height, width);
        else onScreenSize(width, height);
      }}
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
        const at = framePoint(turn, pointOnImage(event.currentTarget, event.clientX, event.clientY, turn));
        const first = pendingScroll.current === undefined;
        const previous = pendingScroll.current ?? { ...at, dx: 0, dy: 0 };
        const delta = frameDelta(turn, { dx: event.deltaX / rect.width, dy: event.deltaY / rect.height });
        pendingScroll.current = { ...previous, dx: previous.dx + delta.dx, dy: previous.dy + delta.dy };
        if (first) requestAnimationFrame(() => { const scroll = pendingScroll.current; pendingScroll.current = undefined; if (scroll) onInput({ kind: 'scroll', ...scroll }); });
      }}
    />
  );
}

/** What covers the screen when it is not live: installing, off, in use, closed, failed. Booting shows the skeleton. */
function PhaseOverlay({ state, busy, onBoot, onTakeOver }: { state: DevicePanelState; busy?: string; onBoot: () => void; onTakeOver: () => void }) {
  const copy = devicePhaseCopy(state);
  if (state.phase === 'live' || !copy) return null;
  const dark = state.phase === 'installing';
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
