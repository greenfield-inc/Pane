/** Phone simulators and emulators that agents open in a device tab (docs/DEVICES.md). */
export type DevicePlatform = 'ios' | 'android';

/** One device a Pane can open, as `runpane devices list` reports it. */
export interface DeviceSummary {
  id: string;
  platform: DevicePlatform;
  name: string;
  os: string;
  /** The machine's name; "This computer" for the local one. */
  machine: string;
  state: 'booted' | 'shutdown';
  paneMade: boolean;
  /** The Pane holding it, when one is. */
  heldBy?: { paneId: string; paneName: string };
}

/** Where a device tab's screen comes from. Kept in the tab's state, so it never holds a token. */
export interface DevicePanelState {
  deviceId?: string;
  platform: DevicePlatform;
  name: string;
  os?: string;
  machine: string;
  /** The saved computer the device runs on; absent for this machine. */
  machineId?: string;
  /** Why that machine runs it ("pinned", or "automatic" with a reason). */
  machineReason?: { kind: 'local' | 'automatic' | 'pinned'; text: string };
  phase: DevicePanelPhase;
  /** Who holds the device when `phase` is `in-use`. */
  heldBy?: { paneId: string; paneName: string };
  /** Set with `no-mac` and `mac-offline`. */
  macName?: string;
  /** The tab that opened it (the agent). */
  openedBy?: string;
  /** Why the device stopped, set with `off` and `closed`. */
  stoppedBy?: DeviceStopCause;
  /** The tab's screen recording while one runs: when it started (epoch ms). */
  recording?: { startedAt: number };
  /** How the tab's last recording ended, so every client can say so. */
  recordingEnded?: DeviceRecordingEnd;
  /**
   * Who is driving now: an agent while its device tool runs, or the person after Take over. While
   * the person drives, the agent's device_act waits (`agentWaiting` names it) until they hand it back.
   */
  driver?: DeviceDriver;
}

export type DeviceDriver =
  | { by: 'agent'; agent: string }
  | { by: 'person'; agentWaiting?: string };

/** One line of a device's app log, as the device tab shows it. */
export interface DeviceLogLine {
  seq: number;
  /** When it was logged, as epoch milliseconds. */
  at: number;
  level: 'debug' | 'info' | 'warning' | 'error';
  /** The process or tag that logged it. */
  source: string;
  message: string;
}

/** Log lines after a sequence number, and the number to ask from next. */
export interface DeviceLogPage {
  lines: DeviceLogLine[];
  next: number;
  /** Why lines are not arriving. */
  problem?: string;
}

/** A full-resolution screenshot from the device tab, saved as a PNG file on the host. */
export interface DeviceCapture {
  path: string;
  /** The PNG as a data URL. */
  dataUrl: string;
}

/** A finished recording: an MP4 file, on the host or on the linked Mac that runs the device. */
export interface DeviceRecording {
  path: string;
  /** The Mac it was saved on, when the device runs on a linked Mac. */
  machine?: string;
}

/**
 * Why a device stopped: the person's Shut down, an agent's device_close, the idle timer, `runpane
 * devices free`, its Pane archived, Pane quitting, or something outside Pane (Simulator, a crash).
 */
export type DeviceStopCause = 'person' | 'agent' | 'idle' | 'freed' | 'archived' | 'quit' | 'outside';

/** How a recording ended: the person's Stop, its 10-minute limit, an agent's record stop, the device stopping, or Pane quitting. */
export interface DeviceRecordingEnd {
  by: 'person' | 'limit' | 'agent' | 'device' | 'quit';
  /** The saved MP4, when it saved. */
  recording?: DeviceRecording;
  /** Why it did not save, when it did not. */
  problem?: string;
  /** When it ended (epoch ms). */
  at: number;
}

export type DevicePanelPhase = 'installing' | 'booting' | 'live' | 'off' | 'in-use' | 'closed' | 'no-mac' | 'mac-offline' | 'error';

/** Where main reads a device's screen and sends its input. Main only: it carries the hub token. */
export interface DeviceStreamInfo {
  /** MJPEG stream URL on loopback. */
  streamUrl: string;
  /** WebSocket URL for touch and buttons. */
  inputUrl: string;
  /** The hub's token, sent as a Bearer header. Never logged, printed or sent to a renderer. */
  token: string;
}

/** Which way the device's screen faces, as the hub names it. */
export type DeviceOrientation = 'portrait' | 'landscape_left' | 'portrait_upside_down' | 'landscape_right';

/** A foldable's posture: shut, half open (a laptop or book), or flat open. */
export type DevicePosture = 'closed' | 'half' | 'open';

/** One touch, button, turn, fold, scroll or key from the person's device tab. */
export type DeviceInput =
  | { kind: 'touch'; phase: 'begin' | 'move' | 'end'; x: number; y: number }
  | { kind: 'button'; button: 'home' | 'back' }
  | { kind: 'rotate'; orientation: DeviceOrientation }
  | { kind: 'fold'; posture: DevicePosture }
  /** A wheel or trackpad scroll at (x, y); dx and dy are fractions of the screen. */
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  /** One key pressed and released: `key` is a KeyboardEvent key (a character, or Enter, Backspace, an arrow…). */
  | { kind: 'key'; key: string };

/** What the device can do now, for the tab's controls. */
export interface DeviceControls {
  orientation?: DeviceOrientation;
  /** Present on a foldable: its posture now, when the device reports one. */
  fold?: { posture?: DevicePosture };
}

/** The marker device_open puts in its result so a chat card can find the device tab. */
export interface DeviceOpenMarker {
  kind: 'pane-device';
  panelId: string;
  name: string;
  os?: string;
  machine: string;
}

/** Settings > Devices. */
export interface DeviceSettings {
  /** Agents get the device tools (on by default). */
  enabled: boolean;
  /** The saved computer that runs iOS for a machine without Xcode; absent means automatic. */
  iosMachineId?: string;
  /** Booted devices per platform at once (1 to 4). */
  maxBooted: number;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { enabled: true, maxBooted: 1 };

/** What Settings > Devices shows about this machine. */
export interface DeviceSettingsView {
  settings: DeviceSettings;
  capabilities: {
    ios: { ready: true } | { ready: false; reason: string };
    android: { ready: true } | { ready: false; reason: string };
    simslim: boolean;
    npm: boolean;
  };
  helpersInstalled: boolean;
  /** Saved Macs that can run iOS for this machine, for the iOS machine picker. */
  macs: DeviceMac[];
}

/** A saved Mac, as the iOS machine picker lists it. */
export interface DeviceMac {
  id: string;
  name: string;
  online: boolean;
}

