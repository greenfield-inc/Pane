import { randomUUID } from 'crypto';
import type {
  PaneRemoteConnectionImportPayload,
  RemoteDaemonClientRecord,
  RemoteDaemonConnectionPair,
} from '../../../shared/types/remoteDaemon';
import { CONNECTION_CODE_CLAIM_MS, isRemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import { PaneError } from '../../../shared/paneError';
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

export interface CreateSingleUseConnectionPairInput extends CreateRemoteDaemonConnectionPairInput {
  person: string;
}

/**
 * A pair for a single-use code made for one person. Its token only claims a device's own token
 * and stops working after CONNECTION_CODE_CLAIM_MS. The token starts with the record id, so a
 * second claim of a used code can say which device took it.
 */
export function createSingleUseConnectionPair(
  input: CreateSingleUseConnectionPairInput,
): RemoteDaemonConnectionPair & { person: string; expiresAt: string } {
  const person = input.person.trim();
  if (person.length === 0 || person.length > 80) {
    throw new PaneError(
      'ERR_REMOTE_DAEMON_CODE_PERSON',
      'A connection code needs the name of the person it is for, up to 80 characters. No code was made.',
      'Enter who the code is for, then create it again.',
    );
  }
  const pair = createRemoteDaemonConnectionPair(input);
  const token = `${pair.client.id}.${pair.token}`;
  const expiresAt = new Date(Date.now() + CONNECTION_CODE_CLAIM_MS).toISOString();
  return {
    client: { ...pair.client, tokenHash: hashRemoteDaemonToken(token), person, claimBy: expiresAt },
    profile: { ...pair.profile, token },
    token,
    person,
    expiresAt,
  };
}

/** Single-use codes nobody claimed in time; they can never be claimed, so they need not be kept. */
export function withoutExpiredCodes(clients: RemoteDaemonClientRecord[]): RemoteDaemonClientRecord[] {
  const now = Date.now();
  return clients.filter((client) => !client.claimBy || Date.parse(client.claimBy) > now);
}

/** The client list after a claim, and the claiming device's own token. */
export interface ClaimedCode {
  clients: RemoteDaemonClientRecord[];
  token: string;
}

/**
 * Claims a single-use code for one device: a new token replaces the code's, so the code stops
 * working at this write. Returns the client list to save and the device's token.
 */
export function claimSingleUseCode(
  clients: readonly RemoteDaemonClientRecord[],
  codeToken: string,
  device: string | null,
): ClaimedCode {
  const tokenHash = hashRemoteDaemonToken(codeToken);
  const record = clients.find((client) => client.claimBy && client.tokenHash === tokenHash);
  if (!record?.claimBy) {
    const used = clients.find((client) => client.claimedAt && codeToken.startsWith(`${client.id}.`));
    throw new PaneError(
      'ERR_REMOTE_DAEMON_CODE_USED',
      used?.claimedAt
        ? `This connection code was already used on ${used.claimedDevice ?? 'another device'} at ${formatClaimTime(used.claimedAt)}. A code works for one device.`
        : 'This connection code was already used, or it was revoked. A code works for one device.',
      'Ask the person who sent it for a new code.',
    );
  }
  if (Date.parse(record.claimBy) <= Date.now()) {
    throw new PaneError(
      'ERR_REMOTE_DAEMON_CODE_EXPIRED',
      `This connection code expired at ${formatClaimTime(record.claimBy)}. A code works for 15 minutes after it is made.`,
      'Ask the person who sent it for a new code.',
    );
  }
  const token = createRemoteDaemonToken();
  const { claimBy: _claimed, ...rest } = record;
  const claimed: RemoteDaemonClientRecord = { ...rest, tokenHash: hashRemoteDaemonToken(token), claimedAt: new Date().toISOString() };
  if (device) claimed.claimedDevice = device.slice(0, 80);
  return { clients: clients.map((client) => (client === record ? claimed : client)), token };
}

function formatClaimTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function createPaneRemoteConnectionImportPayload(
  pair: RemoteDaemonConnectionPair,
  tunnel?: PaneRemoteConnectionImportPayload['tunnel'],
): PaneRemoteConnectionImportPayload {
  const payload: PaneRemoteConnectionImportPayload = {
    v: 1,
    label: pair.profile.label,
    baseUrl: pair.profile.baseUrl,
    token: pair.token,
    transport: pair.profile.transport,
  };
  if (pair.client.claimBy) payload.claim = true;
  if (tunnel) payload.tunnel = tunnel;
  return payload;
}
