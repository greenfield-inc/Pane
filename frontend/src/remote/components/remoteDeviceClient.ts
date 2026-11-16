import type { DeviceTabClient } from '../../components/panels/device/deviceClient';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

/**
 * The browser app and phones reach the host's device over their own Pane connection: frames
 * about twice a second, and taps and buttons as device-tab input. The host forwards input for a
 * device on a linked Mac with its own computer token.
 */
export function remoteDeviceClient(adapter: RemoteRuntimeAdapter, clientId: string): DeviceTabClient {
  return {
    clientId,
    streamUrl: () => undefined,
    frame: panelId => adapter.invoke<string>('devices:frame', [panelId]),
    input: async (panelId, input) => { await adapter.invoke('devices:input', [panelId, input]); },
    visible: async (panelId, visible) => { await adapter.invoke('devices:visible', [panelId, clientId, visible]); },
    takeOver: async panelId => { await adapter.invoke('devices:take-over', [panelId]); },
    power: async (panelId, action) => { await adapter.invoke('devices:power', [panelId, action]); },
  };
}
