import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { getPaneEventSink } from '../core/runtime';
import { applySharedCredentials, readSharedCredentials, sharedCredentialsSchema } from '../services/sharedCredentials';
import { paneSecretStore, type PaneSecretStore } from '../services/paneSecrets';
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
): void {
  const { configManager } = services;
  const readAll = async () => ({ ...readSharedCredentials(configManager.getConfig()), paneSecrets: await secrets.exportForSync() });
  commandRegistry.register('credentials:shared:get', async (_input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    return readAll();
  });
  commandRegistry.register('credentials:shared:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    const incoming = decodeBoundary(input, sharedCredentialsSchema);
    const { changed } = await applySharedCredentials(configManager, incoming);
    const changedSecrets = incoming.paneSecrets ? await secrets.applyFromSync(incoming.paneSecrets) : [];
    // Carries no values, so no key ever rides an event.
    if (changed.length + changedSecrets.length > 0) getPaneEventSink().send('remote:settings-changed');
    // The keys only, as before secrets: callers ignore the answer, so secret values never travel back.
    return readSharedCredentials(configManager.getConfig());
  });
}
