import type { IpcMain } from 'electron';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue, PaneCommandRegistry } from '../daemon/commandRegistry';
import { getMobilePushSender, type MobilePushRegistrationRequest } from '../daemon/mobilePushSender';
import type { AppServices } from './types';

const platformSchema = boundary.enumeration('ios', 'android');
const trustedSchema = boundary.object({ clientId: boundary.nonEmptyString });
const registrationSchema = boundary.object({
  platform: platformSchema, token: boundary.nonEmptyString, installationId: boundary.nonEmptyString,
  hostProfileId: boundary.nonEmptyString, needsInputEnabled: boundary.optional(boundary.boolean), completedEnabled: boundary.optional(boundary.boolean),
  notifyButtons: boundary.optional(boundary.boolean),
});
const installationSchema = boundary.object({ platform: platformSchema, installationId: boundary.nonEmptyString });
const controlsSchema = boundary.object({ platform: platformSchema, installationId: boundary.nonEmptyString, needsInputEnabled: boundary.optional(boundary.boolean), completedEnabled: boundary.optional(boundary.boolean) });

/** HTTP appends the trusted client id: a paired client's, or `tailnet:<login>` for this computer's owner. */
export function registerMobilePushHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const sender = getMobilePushSender(services.configManager);
  commandRegistry.register('mobile:push-status', (input: PaneCommandValue, trusted: PaneCommandValue) => {
    const request = decodeBoundary(input, installationSchema);
    return sender.getStatus(clientIdFrom(trusted), request.platform, request.installationId);
  });
  commandRegistry.register('mobile:push-register', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    const request = decodeBoundary(input, registrationSchema);
    return sender.register(clientIdFrom(trusted), request);
  });
  commandRegistry.register('mobile:push-controls', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    const request = decodeBoundary(input, controlsSchema);
    return sender.updateControls(clientIdFrom(trusted), request.platform, request.installationId, controlsFrom(request));
  });
  commandRegistry.register('mobile:push-revoke', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    const request = decodeBoundary(input, installationSchema);
    await sender.revoke(clientIdFrom(trusted), request.platform, request.installationId);
    return { ok: true };
  });
  commandRegistry.bindChannels(ipcMain, ['mobile:push-status', 'mobile:push-register', 'mobile:push-controls', 'mobile:push-revoke']);
}

function clientIdFrom(value: PaneCommandValue): string {
  return decodeBoundary(value, trustedSchema).clientId;
}
function controlsFrom(request: { needsInputEnabled?: boolean; completedEnabled?: boolean }): Pick<MobilePushRegistrationRequest, 'needsInputEnabled' | 'completedEnabled'> {
  const controls: Pick<MobilePushRegistrationRequest, 'needsInputEnabled' | 'completedEnabled'> = {};
  if (request.needsInputEnabled !== undefined) controls.needsInputEnabled = request.needsInputEnabled;
  if (request.completedEnabled !== undefined) controls.completedEnabled = request.completedEnabled;
  return controls;
}
