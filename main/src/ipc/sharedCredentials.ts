import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { getPaneEventSink } from '../core/runtime';
import { applySharedCredentials, readSharedCredentials, sharedCredentialsSchema } from '../services/sharedCredentials';
import type { AppServices } from './types';

const trustedSchema = boundary.object({ clientId: boundary.nonEmptyString });

/**
 * Lets a paired device read this host's integration keys and write newer ones.
 * HTTP appends the trusted second argument only after it has authenticated a paired client.
 * Never bound to the renderer: the desktop reads its own config directly.
 */
export function registerSharedCredentialHandlers(services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const { configManager } = services;
  commandRegistry.register('credentials:shared:get', (_input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    return readSharedCredentials(configManager.getConfig());
  });
  commandRegistry.register('credentials:shared:apply', async (input: PaneCommandValue, trusted: PaneCommandValue) => {
    decodeBoundary(trusted, trustedSchema);
    const { credentials, changed } = await applySharedCredentials(configManager, decodeBoundary(input, sharedCredentialsSchema));
    // Carries no values, so no key ever rides an event.
    if (changed.length > 0) getPaneEventSink().send('remote:settings-changed');
    return credentials;
  });
}
