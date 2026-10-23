import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { agentChatManager } from '../services/agentChat/agentChatManager';
import { installClaudeAdapter } from '../services/agentChat/adapterSetup';

const interfaceSchema = boundary.enumeration('terminal', 'chat');
const sendSchema = boundary.object({
  generation: boundary.number,
  operationId: boundary.nonEmptyString,
  text: boundary.string,
  images: boundary.optional(boundary.array(boundary.object({ mimeType: boundary.string, data: boundary.string }))),
});

/** One command surface for Electron, daemon clients and the remote PWA. */
export function registerAgentChatHandlers(ipcMain: IpcMain, registry: PaneCommandRegistry): void {
  registry.register('agent-chat:get', (panelId: string) => agentChatManager.view(decodeBoundary(panelId, boundary.nonEmptyString)));
  registry.register('agent-chat:identify', (panelId: string, nativeId: string, socketPath: string) => agentChatManager.identify(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(nativeId, boundary.nonEmptyString), decodeBoundary(socketPath, boundary.nonEmptyString)));
  registry.register('agent-chat:setup', async () => { await installClaudeAdapter(); return { installed: true }; });
  registry.register('agent-chat:switch', (panelId: string, mode: PaneCommandValue, generation: number) => agentChatManager.switchTo(
    decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(mode, interfaceSchema), decodeBoundary(generation, boundary.number),
  ));
  registry.register('agent-chat:recover', (panelId: string, mode: PaneCommandValue, generation: number) => agentChatManager.recover(
    decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(mode, interfaceSchema), decodeBoundary(generation, boundary.number),
  ));
  registry.register('agent-chat:send', (panelId: string, request: PaneCommandValue) => agentChatManager.send(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(request, sendSchema)));
  registry.register('agent-chat:receipt', (panelId: string, operationId: string) => agentChatManager.receipt(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(operationId, boundary.nonEmptyString)));
  registry.register('agent-chat:cancel', async (panelId: string, generation: number) => {
    await agentChatManager.cancel(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(generation, boundary.number));
  });
  registry.register('agent-chat:permission', (panelId: string, generation: number, requestId: string, optionId: string) => {
    agentChatManager.answerPermission(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(generation, boundary.number), decodeBoundary(requestId, boundary.nonEmptyString), decodeBoundary(optionId, boundary.string));
    return undefined;
  });
  registry.register('agent-chat:configure', (panelId: string, generation: number, configId: string, value: string) => agentChatManager.configure(decodeBoundary(panelId, boundary.nonEmptyString), decodeBoundary(generation, boundary.number), decodeBoundary(configId, boundary.nonEmptyString), decodeBoundary(value, boundary.string)));
  registry.register('agent-chat:stop', (panelId: string) => agentChatManager.stop(decodeBoundary(panelId, boundary.nonEmptyString)));
  for (const operation of ['get', 'identify', 'setup', 'switch', 'recover', 'send', 'receipt', 'cancel', 'permission', 'stop', 'configure']) registry.bindChannel(ipcMain, `agent-chat:${operation}`);
}
