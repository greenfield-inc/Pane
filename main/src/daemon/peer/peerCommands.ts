import type { PaneCommandRegistry, PaneCommandValue } from '../commandRegistry';
import {
  normalizeRemoteDaemonConfig,
  type RemoteDaemonConfig,
  type RemoteDaemonHostAccess,
} from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import {
  listPeers,
  mintPeerRecord,
  revokePeer,
  setPeerSessionAccess,
  type PeerSummary,
} from './peerRecords';

export const PEER_MANAGEMENT_CHANNELS = [
  'runpane:peers:mint',
  'runpane:peers:list',
  'runpane:peers:allow',
  'runpane:peers:deny',
  'runpane:peers:revoke',
] as const;

interface PeerMintResult {
  ok: true;
  peer: PeerSummary;
  connectionCode: string;
}

interface PeerListResult {
  ok: true;
  peers: PeerSummary[];
}

interface PeerUpdateResult {
  ok: true;
  peer: PeerSummary;
}

interface PeerRevokeResult {
  ok: true;
  revoked: true;
  peerId: string;
}

export interface PeerCommandDependencies {
  readRemoteConfig(): RemoteDaemonConfig;
  writeRemoteConfig(config: RemoteDaemonConfig): Promise<void>;
  /** Resolves a Session id or exact name on this host to its id; throws when unknown. */
  resolveSessionId(selector: string): Promise<string>;
  /** The URL other Sessions reach this host at (Tailscale Serve on cloud hosts). */
  resolveHostAccess(config: RemoteDaemonConfig): Promise<RemoteDaemonHostAccess>;
}

const mintRequestSchema = boundary.object({
  label: boundary.nonEmptyString,
  sessions: boundary.optional(boundary.array(boundary.nonEmptyString)),
});
const listRequestSchema = boundary.object({
  session: boundary.optional(boundary.nonEmptyString),
});
const accessRequestSchema = boundary.object({
  peer: boundary.nonEmptyString,
  session: boundary.nonEmptyString,
});
const revokeRequestSchema = boundary.object({
  peer: boundary.nonEmptyString,
});

// Each channel takes one request object, or the positional strings a contract
// `daemonAction` sends (`runpane peers mint --name <label>` passes the label).
function readRequest<Value>(
  args: readonly PaneCommandValue[],
  schema: BoundarySchema<Value>,
  positional: readonly string[],
): Value {
  const [first] = args;
  if (decodeOptionalBoundary(first, boundary.string) === undefined) return decodeBoundary(first ?? {}, schema);
  return decodeBoundary(Object.fromEntries(positional.map((key, index) => [key, args[index]])), schema);
}

/**
 * Peer management for full clients and the local socket. Peers themselves
 * never reach these: the HTTP peer gate allows only its own short list.
 */
export function registerPeerCommands(registry: PaneCommandRegistry, deps: PeerCommandDependencies): void {
  let queue: Promise<void> = Promise.resolve();
  // Config writes are read-modify-write; serialize them so two mints never drop one.
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  const commit = async (next: RemoteDaemonConfig) => {
    await deps.writeRemoteConfig(normalizeRemoteDaemonConfig(next));
  };

  registry.register('runpane:peers:mint', (...args: PaneCommandValue[]): Promise<PeerMintResult> => serialize(async () => {
    const input = readRequest(args, mintRequestSchema, ['label']);
    const allowedSessionIds = await Promise.all((input.sessions ?? []).map(deps.resolveSessionId));
    const current = deps.readRemoteConfig();
    const access = await deps.resolveHostAccess(current);
    const minted = mintPeerRecord(current, { label: input.label, allowedSessionIds, access });
    await commit({ ...minted.config, host: { ...minted.config.host, access } });
    return { ok: true, peer: minted.peer, connectionCode: minted.connectionCode };
  }));

  registry.register('runpane:peers:list', async (...args: PaneCommandValue[]): Promise<PeerListResult> => {
    const input = readRequest(args, listRequestSchema, ['session']);
    const sessionId = input.session ? await deps.resolveSessionId(input.session) : undefined;
    return { ok: true, peers: listPeers(deps.readRemoteConfig(), sessionId) };
  });

  const registerAccess = (channel: 'runpane:peers:allow' | 'runpane:peers:deny', allowed: boolean) => {
    registry.register(channel, (...args: PaneCommandValue[]): Promise<PeerUpdateResult> => serialize(async () => {
      const input = readRequest(args, accessRequestSchema, ['peer', 'session']);
      const sessionId = await deps.resolveSessionId(input.session);
      const updated = setPeerSessionAccess(deps.readRemoteConfig(), input.peer, sessionId, allowed);
      await commit(updated.config);
      return { ok: true, peer: updated.peer };
    }));
  };
  registerAccess('runpane:peers:allow', true);
  registerAccess('runpane:peers:deny', false);

  registry.register('runpane:peers:revoke', (...args: PaneCommandValue[]): Promise<PeerRevokeResult> => serialize(async () => {
    const input = readRequest(args, revokeRequestSchema, ['peer']);
    const revoked = revokePeer(deps.readRemoteConfig(), input.peer);
    await commit(revoked.config);
    return { ok: true, revoked: true, peerId: revoked.peerId };
  }));
}
