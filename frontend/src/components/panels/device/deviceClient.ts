import { createContext } from 'react';
import type { DeviceCapture, DeviceControls, DeviceInput, DeviceLogPage, DeviceRecording } from '../../../../../shared/types/devices';
import { addDraftAttachment } from '../../chatTab/ChatTabPanel';

/** How a device tab reaches the device on the host its client shows. Each call throws on failure. */
export interface DeviceTabClient {
  /** Names this client's view of the tab, so the lease knows where the tab is on screen. */
  clientId: string;
  /**
   * A URL that streams the screen sized so its longest side is `maxPx` device pixels. Clients
   * that cannot stream leave it out, and the tab polls frames.
   */
  streamUrl?(panelId: string, maxPx: number): string;
  /** Frames per second the stream delivers now, for clients that stream; null when unknown. */
  frameRate?(panelId: string): Promise<number | null>;
  frame(panelId: string): Promise<string>;
  /** Whether the device turns and folds, and how it is turned and folded now. */
  controls(panelId: string): Promise<DeviceControls>;
  /** A full-resolution screenshot saved as a PNG on the host; given `image` (a PNG data URL), that image saved instead. */
  capture(panelId: string, image?: string): Promise<DeviceCapture>;
  /** Types `text` at the prompt of a terminal agent tab in the same Pane, unsent. */
  stage(panelId: string, agentPanelId: string, text: string): Promise<void>;
  /** Adds a file to a chat tab's unsent draft. */
  attachToChat(chatPanelId: string, file: File): Promise<void>;
  /** Starts a recording (answering null) or stops it (answering the saved recording). */
  record(panelId: string, action: 'start' | 'stop'): Promise<DeviceRecording | null>;
  logs(panelId: string, since: number): Promise<DeviceLogPage>;
  /** Take over (`person`), or hand the device back to the agent. */
  driver(panelId: string, who: 'person' | 'agent'): Promise<void>;
  input(panelId: string, input: DeviceInput): Promise<void>;
  visible(panelId: string, visible: boolean): Promise<void>;
  takeOver(panelId: string): Promise<void>;
  power(panelId: string, action: 'boot' | 'restart' | 'shutdown'): Promise<void>;
}

async function unwrap<Data>(response: Promise<{ success: boolean; data?: Data; error?: string }>): Promise<Data> {
  const result = await response;
  if (!result.success || result.data === undefined) throw new Error(result.error ?? 'Pane could not reach the device.');
  return result.data;
}

/**
 * The desktop app: its own computer's devices stream from main (pane-media://device/<panelId>);
 * while it is switched to another computer, frames come over the connection.
 */
export function desktopDeviceClient(remote: boolean): DeviceTabClient {
  const devices = window.electronAPI.devices;
  return {
    clientId: 'desktop',
    streamUrl: remote ? undefined : (panelId, maxPx) => `pane-media://device/${panelId}?max=${maxPx}`,
    frameRate: remote ? undefined : panelId => unwrap(devices.frameRate(panelId)),
    frame: panelId => unwrap(devices.frame(panelId)),
    controls: panelId => unwrap(devices.controls(panelId)),
    capture: (panelId, image) => unwrap(devices.capture(panelId, image)),
    stage: async (panelId, agentPanelId, text) => { await unwrap(devices.stage(panelId, agentPanelId, text)); },
    attachToChat: (chatPanelId, file) => addDraftAttachment(window.electronAPI.chatTab, chatPanelId, file),
    record: (panelId, action) => unwrap(devices.record(panelId, action)),
    logs: (panelId, since) => unwrap(devices.logs(panelId, since)),
    driver: async (panelId, who) => { await unwrap(devices.driver(panelId, who)); },
    input: async (panelId, input) => { await unwrap(devices.input(panelId, input)); },
    visible: async (panelId, visible) => { await unwrap(devices.visible(panelId, 'desktop', visible)); },
    takeOver: async panelId => { await unwrap(devices.takeOver(panelId)); },
    power: async (panelId, action) => { await unwrap(devices.power(panelId, action)); },
  };
}

/** Set by the browser app and phones; the desktop's client otherwise. */
export const DeviceClientContext = createContext<DeviceTabClient | null>(null);
