import type { DeviceTabClient } from '../../components/panels/device/deviceClient';
import { addDraftAttachment } from '../../components/chatTab/chatDrafts';
import type { DeviceCapture, DeviceControls, DeviceLogPage, DeviceRecording } from '../../../../shared/types/devices';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

/**
 * The browser app and phones reach the host's device over their own Pane connection: frames
 * about twice a second, and taps and buttons as device-tab input. The host forwards input for a
 * device on a linked Mac with its own computer token.
 */
export function remoteDeviceClient(adapter: RemoteRuntimeAdapter, clientId: string): DeviceTabClient {
  return {
    clientId,
    frame: panelId => adapter.invoke<string>('devices:frame', [panelId]),
    controls: panelId => adapter.invoke<DeviceControls>('devices:controls', [panelId]),
    capture: (panelId, image) => adapter.invoke<DeviceCapture>('devices:capture', image === undefined ? [panelId] : [panelId, image]),
    stage: async (panelId, agentPanelId, text) => { await adapter.invoke('devices:stage', [panelId, agentPanelId, text]); },
    attachToChat: (chatPanelId, file) => addDraftAttachment(adapter.chatTab, chatPanelId, file),
    record: (panelId, action) => adapter.invoke<DeviceRecording | null>('devices:record', [panelId, action]),
    logs: (panelId, since) => adapter.invoke<DeviceLogPage>('devices:logs', [panelId, since]),
    driver: async (panelId, who) => { await adapter.invoke('devices:driver', [panelId, who]); },
    input: async (panelId, input) => { await adapter.invoke('devices:input', [panelId, input]); },
    visible: async (panelId, visible) => { await adapter.invoke('devices:visible', [panelId, clientId, visible]); },
    takeOver: async panelId => { await adapter.invoke('devices:take-over', [panelId]); },
    power: async (panelId, action) => { await adapter.invoke('devices:power', [panelId, action]); },
  };
}
