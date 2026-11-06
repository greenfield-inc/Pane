import {
  decodeRemoteConnectionCode,
  redeemRemoteConnectionCode,
  RemoteAuthError,
  RemoteRequestError,
  type RemoteDaemonClient,
} from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

import { createDaemonClient, DEVICE_LABEL } from '@/daemon/createClient';

import { assertSavableHost } from './hosts';

/**
 * Decodes a pane-remote:// code and proves it works. A single-use code is claimed, which trades
 * it for this phone's own token; any other code is proved with one authenticated read.
 * `/health` is unauthenticated, so connecting alone would accept a revoked code.
 */
export async function verifyConnectionCode(code: string): Promise<RemotePaneConnectionProfile> {
  const decoded = decodeRemoteConnectionCode(code);
  assertSavableHost(decoded);
  const profile = await redeemRemoteConnectionCode(
    code,
    (claimProfile, channel, args) => reach(claimProfile, (client) => client.invoke<JsonValue>(channel, args)),
    DEVICE_LABEL,
  );
  if (profile.token === decoded.token) {
    await reach(profile, (client) => client.invoke('sessions:get-all-with-projects'));
  }
  return profile;
}

/** Runs one request against the host; a host that answered with a refusal says why. */
async function reach<T>(profile: RemotePaneConnectionProfile, run: (client: RemoteDaemonClient) => Promise<T>): Promise<T> {
  const client = createDaemonClient(profile);
  try {
    return await run(client);
  } catch (error) {
    if (error instanceof RemoteAuthError || error instanceof RemoteRequestError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${profile.label} at ${profile.baseUrl}. Check that the host is running and this phone can reach it (Tailscale, SSH tunnel or HTTPS proxy). ${detail}`);
  } finally {
    client.disconnect();
  }
}
