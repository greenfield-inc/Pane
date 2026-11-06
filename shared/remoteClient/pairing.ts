import type {
  PaneRemoteConnectionImportPayload,
  RemotePaneConnectionProfile,
} from '../types/remoteDaemon';
import { decodePaneRemoteConnection, remoteImportPayloadToProfile } from '../types/remoteDaemon';
import { boundary, BoundaryDecodeError, decodeBoundary, type JsonValue } from '../validation/boundaryDecoder';

const PROFILE_PREFIX = 'pane-remote://';

/** The host channel that trades a single-use code's token for this device's own. */
export const CLAIM_CODE_CHANNEL = 'remote:claim-code';

/** Sends one command to the host a profile names, signed in with that profile's token. */
export type ConnectionCodeInvoke = (
  profile: RemotePaneConnectionProfile,
  channel: string,
  args: JsonValue[],
) => Promise<JsonValue | undefined>;

/**
 * Redeems a single-use code: its token is traded, once, for a token of this device's own that
 * the code never contained. Any other code comes back unchanged. `device` names this device on
 * the host, which shows it to the person who made the code.
 */
export async function claimConnectionCode(
  payload: PaneRemoteConnectionImportPayload,
  invoke: ConnectionCodeInvoke,
  device?: string,
): Promise<PaneRemoteConnectionImportPayload> {
  if (!payload.claim) return payload;
  const args: JsonValue[] = device ? [{ device }] : [{}];
  const answer = await invoke(remoteImportPayloadToProfile(payload), CLAIM_CODE_CHANNEL, args);
  const { token } = decodeBoundary(answer, boundary.object({ token: boundary.nonEmptyString }));
  const { claim: _used, ...claimed } = payload;
  return { ...claimed, token };
}

/** Decodes a connection code and redeems it when it is single-use; see `claimConnectionCode`. */
export async function redeemRemoteConnectionCode(
  code: string,
  invoke: ConnectionCodeInvoke,
  device?: string,
): Promise<RemotePaneConnectionProfile> {
  const payload = decodeImportPayload(code);
  const profile = profileFromPayload(payload);
  const claimed = await claimConnectionCode(payload, (_profile, channel, args) => invoke(profile, channel, args), device);
  // The profile id ends with the token, so it is made from the claimed one.
  return claimed === payload ? profile : profileFromPayload(claimed);
}

export function decodeRemoteConnectionCode(code: string): RemotePaneConnectionProfile {
  return profileFromPayload(decodeImportPayload(code));
}

function decodeImportPayload(code: string): PaneRemoteConnectionImportPayload {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PROFILE_PREFIX)) {
    throw new Error('Connection code must start with pane-remote://');
  }

  if (!trimmed.slice(PROFILE_PREFIX.length)) {
    throw new Error('Connection code is empty');
  }

  let importPayload: PaneRemoteConnectionImportPayload;
  try {
    importPayload = decodePaneRemoteConnection(trimmed);
  } catch (error) {
    if (error instanceof BoundaryDecodeError) throw error;
    throw new Error('Connection code is not valid');
  }
  return importPayload;
}

function profileFromPayload(importPayload: PaneRemoteConnectionImportPayload): RemotePaneConnectionProfile {
  return {
    id: createProfileId(importPayload),
    label: importPayload.label,
    baseUrl: normalizeBaseUrl(importPayload.baseUrl),
    token: importPayload.token,
    transport: importPayload.transport,
    tunnel: importPayload.tunnel,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function createProfileId(payload: PaneRemoteConnectionImportPayload): string {
  const tokenTail = payload.token.slice(-8);
  return `${payload.label}:${normalizeBaseUrl(payload.baseUrl)}:${tokenTail}`;
}
