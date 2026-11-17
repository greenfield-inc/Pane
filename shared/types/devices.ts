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

/** One touch or button from the person's device tab. */
export type DeviceInput =
  | { kind: 'touch'; phase: 'begin' | 'move' | 'end'; x: number; y: number }
  | { kind: 'button'; button: 'home' | 'back' };

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

