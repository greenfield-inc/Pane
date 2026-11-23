import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { getPaneEventSink } from '../core/runtime';
import {
  applyNotifySwitch,
  applySharedCredentials,
  readNotifySwitch,
  readSharedCredentials,
  sharedCredentialsSchema,
  sharedNotifySwitchSchema,
} from '../services/sharedCredentials';
import { paneSecretStore, secretsVolume, type PaneSecretStore } from '../services/paneSecrets';
import { refuseLocalCaller } from './paneSecrets';
import { exportCloudSignIns, receiveCloudSecrets } from '../services/cloudSecrets';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { SharedCredentials } from '../../../shared/types/sharedCredentials';
import type { AppServices } from './types';

const trustedSchema = boundary.object({ clientId: boundary.nonEmptyString });

/**
 * Lets a paired device, or this computer's owner over a workspace, read this host's integration keys
 * and write newer ones. HTTP appends the trusted second argument only after it has authenticated one.
 * Never bound to the renderer: the desktop reads its own config directly.
 */
export function registerSharedCredentialHandlers(
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  secrets: PaneSecretStore = paneSecretStore(),
  /** On a machine with a secrets volume (a Pane Cloud VM): the environment its agent panels inherit, which gets the sign-ins it holds. */
  cloudVm: { env: NodeJS.ProcessEnv } | null = secretsVolume() ? { env: process.env } : null,
): void {
  const { configManager } = services;
  if (cloudVm) void exportCloudSignIns(secrets, cloudVm.env).catch((error) => console.warn('[SharedCredentials] Could not export the cloud sign-ins:', reasonOf(error)));
  const readAll = async (): Promise<SharedCredentials> => ({
    ...readSharedCredentials(configManager.getConfig()),
    paneSecrets: await secrets.exportForSync(),
    paneSecretReferences: secrets.exportReferencesForSync(),
    paneCloudSecretChoice: secrets.exportCloudChoiceForSync(),
  });
  commandRegistry.register('credentials:shared:get', async (_input: PaneCommandValue, trusted: PaneCommandValue) => {
    // The local socket passes a caller's own "trusted" argument, so only paired devices over HTTP may sync.
    refuseLocalCaller();
    decodeBoundary(trusted, trustedSchema);
    // A cloud VM's secrets come one way, from the person's computers, and none leave it.
    if (cloudVm) return {};
    return readAll();
  });
  commandRegistry.register('credentials:shared:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    refuseLocalCaller();
    decodeBoundary(trusted, trustedSchema);
    const incoming = decodeBoundary(input, sharedCredentialsSchema);
    if (cloudVm) {
      // A cloud VM keeps only Pane secrets, on its secrets volume, filtered by the person's choice whoever
      // sent them. Integration keys live in config.json, which there is the Session disk the scans read (D-55).
      const changedSecrets = await receiveCloudSecrets(secrets, incoming, cloudVm.env);
      if (changedSecrets.length > 0) getPaneEventSink().send('remote:settings-changed');
      return {};
    }
    const { changed } = await applySharedCredentials(configManager, incoming);
    const changedSecrets = [
      ...(incoming.paneSecrets ? await secrets.applyFromSync(incoming.paneSecrets) : []),
      ...(incoming.paneSecretReferences ? await secrets.applyReferencesFromSync(incoming.paneSecretReferences) : []),
      ...(incoming.paneCloudSecretChoice && await secrets.applyCloudChoiceFromSync(incoming.paneCloudSecretChoice) ? ['paneCloudSecretChoice'] : []),
    ];
    // Carries no values, so no key ever rides an event.
    if (changed.length + changedSecrets.length > 0) getPaneEventSink().send('remote:settings-changed');
    // The keys only, as before secrets: callers ignore the answer, so secret values never travel back.
    return readSharedCredentials(configManager.getConfig());
  });
  // What a computer sends a cloud VM it knows as one. A machine without a secrets volume refuses, so a
  // new cloud Session is never started without its secrets, or with them on its Session disk.
  commandRegistry.register('credentials:cloud:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    refuseLocalCaller();
    decodeBoundary(trusted, trustedSchema);
    if (!cloudVm) {
      throw new PaneError(
        'ERR_CLOUD_SECRETS_NOT_STORED',
        'This machine has no secrets volume, so it stored none of the secrets it was sent.',
        'Delete this cloud Session and create a new one. If it happens again, write to Pane Cloud support: the machine\'s secrets volume may be missing.',
      );
    }
    const changedSecrets = await receiveCloudSecrets(secrets, decodeBoundary(input, sharedCredentialsSchema), cloudVm.env);
    if (changedSecrets.length > 0) getPaneEventSink().send('remote:settings-changed');
    return {};
  });
  // The Approvals on/off switch, with the same callers. Their own commands, so a host too old for them refuses them plainly.
  commandRegistry.register('notify:switch:get', (_input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    // A cloud VM answers with a switch that never wins, so a device that syncs with it takes nothing back.
    if (cloudVm) return { enabled: true, changedAt: 0 };
    return readNotifySwitch(configManager.getConfig());
  });
  commandRegistry.register('notify:switch:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    const { notifySwitch, changed } = await applyNotifySwitch(configManager, decodeBoundary(input, sharedNotifySwitchSchema));
    if (changed) getPaneEventSink().send('remote:settings-changed');
    return notifySwitch;
  });
}
