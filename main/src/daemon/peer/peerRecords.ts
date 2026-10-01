import { randomUUID } from 'crypto';
import type {
  PaneRemoteConnectionImportPayload,
  RemoteDaemonClientRecord,
  RemoteDaemonConfig,
  RemoteDaemonHostAccess,
} from '../../../../shared/types/remoteDaemon';
import { encodePaneRemoteConnection } from '../../../../shared/types/remoteDaemon';
import { createRemoteDaemonToken, hashRemoteDaemonToken } from '../auth';

/** A peer record as shown to users and callers: never the token or its hash. */
export interface PeerSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  scope: 'peer';
  allowedSessionIds: string[];
}

export interface PeerAccessChange {
  config: RemoteDaemonConfig;
  peer: PeerSummary;
}

export interface PeerRevocation {
  config: RemoteDaemonConfig;
  peerId: string;
}

export interface MintedPeer {
  config: RemoteDaemonConfig;
  peer: PeerSummary;
  connectionCode: string;
}

export function mintPeerRecord(
  config: RemoteDaemonConfig,
  input: { label: string; allowedSessionIds: readonly string[]; access: RemoteDaemonHostAccess },
  now = new Date(),
): MintedPeer {
  const label = input.label.trim();
  if (!label) throw new Error('A peer needs a label: the sending Session\'s name.');
  const token = createRemoteDaemonToken();
  const record: RemoteDaemonClientRecord = {
    id: randomUUID(),
    label,
    createdAt: now.toISOString(),
    tokenHash: hashRemoteDaemonToken(token),
    scope: 'peer',
    allowedSessionIds: [...new Set(input.allowedSessionIds)],
  };
  const payload: PaneRemoteConnectionImportPayload = {
    v: 1,
    label,
    baseUrl: input.access.baseUrl,
    token,
    transport: 'http+sse',
  };
  if (input.access.tunnel) payload.tunnel = input.access.tunnel;
  const connectionCode = encodePaneRemoteConnection(payload);
  return {
    config: withClients(config, [...config.host.clients, record]),
    peer: toPeerSummary(record),
    connectionCode,
  };
}

export function listPeers(config: RemoteDaemonConfig, sessionId?: string): PeerSummary[] {
  return config.host.clients
    .filter(isPeerRecord)
    .filter(record => sessionId === undefined || (record.allowedSessionIds ?? []).includes(sessionId))
    .map(toPeerSummary);
}

function findPeer(config: RemoteDaemonConfig, selector: string): RemoteDaemonClientRecord {
  const trimmed = selector.trim();
  const peers = config.host.clients.filter(isPeerRecord);
  const byId = peers.find(record => record.id === trimmed);
  if (byId) return byId;
  const byLabel = peers.filter(record => record.label === trimmed);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`More than one peer is labelled "${trimmed}"; use its id.`);
  throw new Error(`No peer "${trimmed}" on this host.`);
}

export function setPeerSessionAccess(
  config: RemoteDaemonConfig,
  peerSelector: string,
  sessionId: string,
  allowed: boolean,
): PeerAccessChange {
  const target = findPeer(config, peerSelector);
  const current = new Set(target.allowedSessionIds ?? []);
  if (allowed) current.add(sessionId);
  else current.delete(sessionId);
  const updated: RemoteDaemonClientRecord = { ...target, allowedSessionIds: [...current] };
  return {
    config: withClients(config, config.host.clients.map(record => record.id === target.id ? updated : record)),
    peer: toPeerSummary(updated),
  };
}

export function revokePeer(
  config: RemoteDaemonConfig,
  peerSelector: string,
): PeerRevocation {
  const target = findPeer(config, peerSelector);
  return {
    config: withClients(config, config.host.clients.filter(record => record.id !== target.id)),
    peerId: target.id,
  };
}

function isPeerRecord(record: RemoteDaemonClientRecord): boolean {
  return record.scope === 'peer';
}

function toPeerSummary(record: RemoteDaemonClientRecord): PeerSummary {
  const summary: PeerSummary = {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    scope: 'peer',
    allowedSessionIds: [...(record.allowedSessionIds ?? [])],
  };
  if (record.lastUsedAt) summary.lastUsedAt = record.lastUsedAt;
  return summary;
}

function withClients(config: RemoteDaemonConfig, clients: RemoteDaemonClientRecord[]): RemoteDaemonConfig {
  return { ...config, host: { ...config.host, clients } };
}
