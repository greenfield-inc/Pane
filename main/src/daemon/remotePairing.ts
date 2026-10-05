import { randomUUID } from 'crypto';
import type {
  PaneRemoteConnectionImportPayload,
  RemoteDaemonConnectionPair,
} from '../../../shared/types/remoteDaemon';
import { isRemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import { createRemoteDaemonToken, hashRemoteDaemonToken } from './auth';

export interface CreateRemoteDaemonConnectionPairInput {
  label: string;
  baseUrl: string;
  id?: string;
  createdAt?: string;
}

export function createRemoteDaemonConnectionPair(
  input: CreateRemoteDaemonConnectionPairInput,
): RemoteDaemonConnectionPair {
  const label = input.label.trim();
  const baseUrl = input.baseUrl.trim();
  if (label.length === 0) {
    throw new Error('Remote daemon connection pair label is required');
  }
  if (baseUrl.length === 0) {
    throw new Error('Remote daemon connection pair base URL is required');
  }

  const token = createRemoteDaemonToken();
  const id = input.id ?? randomUUID();
  const client = {
    id,
    label,
    createdAt: input.createdAt ?? new Date().toISOString(),
    tokenHash: hashRemoteDaemonToken(token),
  };
  const profile = {
    id,
    label,
    baseUrl,
    token,
    transport: 'http+sse' as const,
  };

  if (!isRemotePaneConnectionProfile(profile)) {
    throw new Error('Generated remote daemon connection profile is invalid');
  }

  return {
    client,
    profile,
    token,
  };
}

export function createPaneRemoteConnectionImportPayload(
  pair: RemoteDaemonConnectionPair,
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'],
  vaultKey?: string,
): PaneRemoteConnectionImportPayload {
  const payload: PaneRemoteConnectionImportPayload = {
    v: 1,
    label: pair.profile.label,
    baseUrl: pair.profile.baseUrl,
    token: pair.token,
    transport: pair.profile.transport,
  };
  if (tunnel) payload.tunnel = tunnel;
  if (vaultKey) payload.vaultKey = vaultKey;
  return payload;
}
