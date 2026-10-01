import { randomUUID } from 'crypto';
import type { RemoteDaemonClientRecord, RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { createRemoteDaemonToken, hashRemoteDaemonToken } from '../auth';
import { isCoordinatorClient } from './coordinatorScope';

/** The label `runpane cloud new` pairs the coordinator under (`pane --remote-setup --client-scope coordinator`). */
const COORDINATOR_CLIENT_LABEL = 'runpane-cloud-coordinator';

export interface CoordinatorClientRevocation {
  config: RemoteDaemonConfig;
  revokedClientIds: string[];
}

export interface CoordinatorClientPairing {
  config: RemoteDaemonConfig;
  clientId: string;
  /** Returned once; only its hash is stored. */
  token: string;
  revokedClientIds: string[];
}

/** Drops every `scope: 'coordinator'` record; the auth check reads the live config, so the tokens stop at once. */
export function revokeCoordinatorClients(config: RemoteDaemonConfig): CoordinatorClientRevocation {
  const revokedClientIds = config.host.clients.filter(isCoordinatorClient).map(record => record.id);
  return {
    config: withClients(config, config.host.clients.filter(record => !isCoordinatorClient(record))),
    revokedClientIds,
  };
}

/** Pairs a new coordinator client in place of any old one, so a single coordinator token is ever valid. */
export function pairCoordinatorClient(config: RemoteDaemonConfig, now = new Date()): CoordinatorClientPairing {
  const revoked = revokeCoordinatorClients(config);
  const token = createRemoteDaemonToken();
  const record: RemoteDaemonClientRecord = {
    id: randomUUID(),
    label: COORDINATOR_CLIENT_LABEL,
    createdAt: now.toISOString(),
    tokenHash: hashRemoteDaemonToken(token),
    scope: 'coordinator',
  };
  return {
    config: withClients(revoked.config, [...revoked.config.host.clients, record]),
    clientId: record.id,
    token,
    revokedClientIds: revoked.revokedClientIds,
  };
}

function withClients(config: RemoteDaemonConfig, clients: RemoteDaemonClientRecord[]): RemoteDaemonConfig {
  return { ...config, host: { ...config.host, clients } };
}
