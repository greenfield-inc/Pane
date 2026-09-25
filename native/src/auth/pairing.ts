import { decodeRemoteConnectionCode, RemoteAuthError } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { createDaemonClient } from '@/daemon/createClient';

/**
 * Decodes a pane-remote:// code and proves the token works with one
 * authenticated read. `/health` is unauthenticated, so connecting alone would
 * accept a revoked code.
 */
export async function verifyConnectionCode(code: string): Promise<RemotePaneConnectionProfile> {
  const profile = decodeRemoteConnectionCode(code);
  const client = createDaemonClient(profile);
  try {
    await client.invoke('sessions:get-all-with-projects');
  } catch (error) {
    if (error instanceof RemoteAuthError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${profile.label} at ${profile.baseUrl}. Check that the host is running and this phone can reach it (Tailscale, SSH tunnel or HTTPS proxy). ${detail}`);
  } finally {
    client.disconnect();
  }
  return profile;
}
