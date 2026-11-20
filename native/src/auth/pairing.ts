import { decodeRemoteConnectionCode, RemoteAuthError } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { createDaemonClient } from '@/daemon/createClient';

import { assertSavableHost } from './hosts';

/** A code whose computer has not answered by then fails, so the phone says why instead of loading. */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Decodes a pane-remote:// code and proves the token works with one
 * authenticated read. `/health` is unauthenticated, so connecting alone would
 * accept a revoked code.
 */
export async function verifyConnectionCode(code: string): Promise<RemotePaneConnectionProfile> {
  const profile = decodeRemoteConnectionCode(code);
  assertSavableHost(profile);
  const client = createDaemonClient(profile);
  try {
    await client.read('sessions:get-all-with-projects', [], { timeoutMs: VERIFY_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof RemoteAuthError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${profile.label} at ${profile.baseUrl}. Check that Pane is open on ${profile.label} and this phone can reach it (Tailscale, SSH tunnel or HTTPS proxy), then try again. ${detail}`);
  } finally {
    client.disconnect();
  }
  return profile;
}
