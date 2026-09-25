import type {
  PaneRemoteConnectionImportPayload,
  RemotePaneConnectionProfile,
} from '../types/remoteDaemon';
import { decodePaneRemoteConnection } from '../types/remoteDaemon';
import { BoundaryDecodeError } from '../validation/boundaryDecoder';

const PROFILE_PREFIX = 'pane-remote://';

export function decodeRemoteConnectionCode(code: string): RemotePaneConnectionProfile {
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
