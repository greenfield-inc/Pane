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
import { GITHUB_SIGN_IN_KEY, receiveCloudSecrets, startCloudSignIns } from '../services/cloudSecrets';
import { PaneError } from '../../../shared/paneError';
import type { SharedCredentials } from '../../../shared/types/sharedCredentials';
import { sendsToCloud } from '../../../shared/types/paneCloudSecrets';
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
  /**
   * On a machine with a secrets volume (a Pane Cloud VM): the volume, and the environment its agent panels
   * inherit, which gets the sign-ins it holds.
   */
  cloudVm: { env: NodeJS.ProcessEnv; volume?: string } | null = secretsVolume() ? { env: process.env, volume: secretsVolume() } : null,
): void {
  const { configManager } = services;
  // The GitHub token the machine was given at creation first, then the sign-ins it holds (D-107).
  if (cloudVm) void startCloudSignIns(secrets, cloudVm.volume, cloudVm.env).catch((error: Error) => {
    // A PaneError's text never quotes the token file; for anything else only its code, never its message.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
    console.warn('[SharedCredentials] Could not start the cloud sign-ins:', error instanceof PaneError ? `${error.code}: ${error.message}` : code);
  });
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
    if (cloudVm) {
      // A cloud VM answers every reader, old or new, only with Pane secrets the person's choice allows and the
      // choice, and says it is one. Its GitHub token is a sign-in a computer carried here, not a secret to spread.
      const choice = secrets.cloudChoice();
      const records = await secrets.exportForSync();
      const answer: SharedCredentials = {
        cloudVm: true,
        paneSecrets: Object.fromEntries(Object.entries(records).filter(([key, record]) => key !== GITHUB_SIGN_IN_KEY && sendsToCloud(choice, key, record.source))),
      };
      const choiceRecord = secrets.exportCloudChoiceForSync();
      if (choiceRecord) answer.paneCloudSecretChoice = choiceRecord;
      return answer;
    }
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
      return readSharedCredentials(configManager.getConfig());
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
    return readNotifySwitch(configManager.getConfig());
  });
  commandRegistry.register('notify:switch:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    const { notifySwitch, changed } = await applyNotifySwitch(configManager, decodeBoundary(input, sharedNotifySwitchSchema));
    if (changed) getPaneEventSink().send('remote:settings-changed');
    return notifySwitch;
  });
}
