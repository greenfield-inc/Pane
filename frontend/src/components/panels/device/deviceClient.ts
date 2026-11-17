import { createContext } from 'react';
import type { DeviceInput } from '../../../../../shared/types/devices';

/** How a device tab reaches the device on the host its client shows. Each call throws on failure. */
export interface DeviceTabClient {
  /** Names this client's view of the tab, so the lease knows where the tab is on screen. */
  clientId: string;
  /** A URL that streams the screen, when this client can stream; else the tab polls frames. */
  streamUrl(panelId: string): string | undefined;
  frame(panelId: string): Promise<string>;
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
    streamUrl: panelId => (remote ? undefined : `pane-media://device/${panelId}`),
    frame: panelId => unwrap(devices.frame(panelId)),
    input: async (panelId, input) => { await unwrap(devices.input(panelId, input)); },
    visible: async (panelId, visible) => { await unwrap(devices.visible(panelId, 'desktop', visible)); },
    takeOver: async panelId => { await unwrap(devices.takeOver(panelId)); },
    power: async (panelId, action) => { await unwrap(devices.power(panelId, action)); },
  };
}

/** Set by the browser app and phones; the desktop's client otherwise. */
export const DeviceClientContext = createContext<DeviceTabClient | null>(null);
