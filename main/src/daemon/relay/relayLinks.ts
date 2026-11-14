import { createHash, randomBytes, randomUUID } from 'crypto';
import { pinnedServerIdentity } from './keyPinning';
import https from 'https';
import tls from 'tls';
import { PaneError } from '../../../../shared/paneError';
import {
  normalizeRemoteDaemonConfig,
  type RemoteDaemonClientRecord,
  type RemoteDaemonConfig,
  type RemotePaneConnectionProfile,
} from '../../../../shared/types/remoteDaemon';
import type { RelayComputer, RelayComputerGrant, RelayDevice } from '../../../../shared/types/relay';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../../types/config';

/** Commands only a linked computer may call, with its link token. */
export const RELAY_COMPUTER_COMMANDS = {
  /** `{label, phoneId}` → `{token}`: a token for a phone that paired with the caller. */
  grantPhone: 'relay:client:grant-phone',
  /** `{phoneId}`: revoke that phone here ("Remove from all your computers"). */
  removePhone: 'relay:client:remove-phone',
  /** `{computerId}`: forget that computer ("Unlink from all your computers"). */
  forgetComputer: 'relay:client:forget-computer',
} as const;

interface RelayLinksConfig {
  getConfig(): Pick<AppConfig, 'remoteDaemon'>;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<object>;
}

/** Calls a linked computer's `/invoke` with its link token; the key fingerprint is checked. Resolves with its JSON result. */
export type CallComputer = (profile: RemotePaneConnectionProfile, channel: string, args: unknown[]) => Promise<JsonValue | undefined>;

export const relayComputerSchema: BoundarySchema<RelayComputer> = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  domain: boundary.nonEmptyString,
  address: boundary.nonEmptyString,
  local: boundary.array(boundary.string),
  fingerprint: boundary.nonEmptyString,
});

/** A linked computer's `/invoke` answer. */
const invokeAnswerSchema = boundary.object({
  ok: boundary.optional(boundary.json),
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.json),
});
const invokeErrorSchema = boundary.object({ message: boundary.string });
const grantedTokenSchema = boundary.object({ token: boundary.string });

export interface RelayLinksDeps {
  config: RelayLinksConfig;
  /** This computer, or undefined while phone access is off. */
  self(): RelayComputer | undefined;
  call: CallComputer;
  /** Drops live connections of revoked clients. */
  disconnect(clientIds: string[]): void;
  connectedClientIds(): ReadonlySet<string>;
  log?(line: string): void;
}

function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

function profileId(computerId: string): string {
  return `relay-${computerId}`;
}

/**
 * Removes clients here with everything they vouched for: links a removed phone minted, and for each
 * computer whose link goes, the phone tokens it handed out and the profile that calls it.
 */
export function revokeClients(
  remote: RemoteDaemonConfig,
  seed: { clients?: (client: RemoteDaemonClientRecord) => boolean; computers?: readonly string[] },
) {
  const clients = new Set(remote.host.clients.filter((client) => seed.clients?.(client) === true).map((client) => client.id));
  const computers = new Set(seed.computers);
  for (let grew = true; grew;) {
    grew = false;
    for (const client of remote.host.clients) {
      const linkedComputer = client.kind === 'computer' ? client.computerId : undefined;
      if (!clients.has(client.id)) {
        const vouched = (client.mintedBy !== undefined && clients.has(client.mintedBy))
          || (linkedComputer !== undefined && computers.has(linkedComputer))
          || (client.grantedBy !== undefined && computers.has(client.grantedBy));
        if (!vouched) continue;
        clients.add(client.id);
        grew = true;
      }
      if (linkedComputer !== undefined && !computers.has(linkedComputer)) {
        computers.add(linkedComputer);
        grew = true;
      }
    }
  }
  const forgetsActive = remote.client.activeProfileId !== null && [...computers].some((id) => remote.client.activeProfileId === profileId(id));
  return {
    revoked: [...clients],
    remote: {
      ...remote,
      host: { ...remote.host, clients: remote.host.clients.filter((client) => !clients.has(client.id)) },
      client: {
        ...remote.client,
        profiles: remote.client.profiles.filter((profile) => profile.relay === undefined || !computers.has(profile.relay.computerId)),
        activeProfileId: forgetsActive ? null : remote.client.activeProfileId,
        mode: forgetsActive ? 'local' : remote.client.mode,
      },
    },
  };
}

/**
 * "Your computers" (D-16): each computer a phone pairs with links to the phone's other computers
 * with no prompt. Links are client records of kind "computer" (the token a peer uses to call this
 * computer) and client profiles with `relay` (the token this computer uses to call the peer), so
 * "Switch to", ports and runpane workspace reach linked computers through today's client code.
 */
export class RelayLinks {
  constructor(private readonly deps: RelayLinksDeps) {}

  private remote(): RemoteDaemonConfig {
    return normalizeRemoteDaemonConfig(this.deps.config.getConfig().remoteDaemon);
  }

  private async update(change: (remote: RemoteDaemonConfig) => RemoteDaemonConfig): Promise<void> {
    await this.deps.config.updateConfigWith((current) => ({ remoteDaemon: change(normalizeRemoteDaemonConfig(current.remoteDaemon)) }));
  }

  private caller(clientId: string): RemoteDaemonClientRecord {
    const record = this.remote().host.clients.find((client) => client.id === clientId);
    if (!record) throw new PaneError('ERR_RELAY_CALLER_UNKNOWN', 'This device is no longer paired with this computer.', 'Pair again by scanning the code in Pane on this computer.');
    return record;
  }

  private callerPhone(clientId: string): RemoteDaemonClientRecord {
    const record = this.caller(clientId);
    if (record.kind !== undefined) {
      throw new PaneError('ERR_RELAY_PHONE_ONLY', 'Only a paired phone can link computers.', 'Scan both computers with the same phone.');
    }
    return record;
  }

  private callerComputer(clientId: string): RemoteDaemonClientRecord & { computerId: string } {
    const record = this.caller(clientId);
    if (record.kind !== 'computer' || !record.computerId) {
      throw new PaneError('ERR_RELAY_COMPUTER_ONLY', 'Only a linked computer can ask for this.', 'Link the computers by scanning both with the same phone.');
    }
    return { ...record, computerId: record.computerId };
  }

  /** Linked computers this computer can call. */
  linked(): Array<RemotePaneConnectionProfile & { relay: NonNullable<RemotePaneConnectionProfile['relay']> }> {
    return this.remote().client.profiles.flatMap((profile) => (profile.relay ? [{ ...profile, relay: profile.relay }] : []));
  }

  /** A phone asks this computer for a token its peer computer will use to call this one. */
  async mintLink(peer: RelayComputer, callerClientId: string): Promise<{ token: string }> {
    const phone = this.callerPhone(callerClientId);
    if (peer.id === this.deps.self()?.id) throw new PaneError('ERR_RELAY_LINK_SELF', 'A computer cannot link with itself.', 'Scan another computer.');
    const { token, tokenHash } = newToken();
    const record: RemoteDaemonClientRecord = {
      id: randomUUID(),
      label: peer.name,
      createdAt: new Date().toISOString(),
      tokenHash,
      kind: 'computer',
      computerId: peer.id,
      linkedBy: phone.label,
      mintedBy: phone.id,
    };
    const replaced = this.remote().host.clients.filter((client) => client.kind === 'computer' && client.computerId === peer.id).map((client) => client.id);
    await this.update((remote) => ({
      ...remote,
      host: { ...remote.host, clients: [...remote.host.clients.filter((client) => !replaced.includes(client.id)), record] },
    }));
    if (replaced.length) this.deps.disconnect(replaced);
    return { token };
  }

  /** A phone hands this computer the token to call a peer it just linked. */
  async saveLink(peer: RelayComputer, token: string, callerClientId: string): Promise<void> {
    const phone = this.callerPhone(callerClientId);
    if (peer.id === this.deps.self()?.id) return;
    const profile: RemotePaneConnectionProfile = {
      id: profileId(peer.id),
      label: peer.name,
      baseUrl: peer.address,
      token,
      transport: 'http+sse',
      relay: { computerId: peer.id, fingerprint: peer.fingerprint, linkedBy: phone.label },
    };
    await this.update((remote) => ({
      ...remote,
      client: { ...remote.client, profiles: [...remote.client.profiles.filter((existing) => existing.id !== profile.id), profile] },
    }));
    this.deps.log?.(`[relay] linked with ${peer.name} (${peer.id}), linked by ${phone.label}`);
  }

  /** A linked computer hands out a token for a phone that just paired with it. */
  async grantPhone(phone: { label: string; phoneId?: string }, callerClientId: string): Promise<{ token: string }> {
    const granter = this.callerComputer(callerClientId);
    const { token, tokenHash } = newToken();
    const record: RemoteDaemonClientRecord = {
      id: randomUUID(),
      label: phone.label.slice(0, 60) || 'Phone',
      createdAt: new Date().toISOString(),
      tokenHash,
      linkedBy: granter.label,
      grantedBy: granter.computerId,
    };
    if (phone.phoneId) record.phoneId = phone.phoneId;
    const replaced = phone.phoneId
      ? this.remote().host.clients.filter((client) => client.kind === undefined && client.phoneId === phone.phoneId).map((client) => client.id)
      : [];
    await this.update((remote) => ({
      ...remote,
      host: { ...remote.host, clients: [...remote.host.clients.filter((client) => !replaced.includes(client.id)), record] },
    }));
    if (replaced.length) this.deps.disconnect(replaced);
    return { token };
  }

  /** Tokens on every linked computer for a phone that just paired here, skipping those it has. */
  async grantsFor(phone: { label: string; phoneId?: string }, known: readonly string[]): Promise<RelayComputerGrant[]> {
    const grants = await Promise.all(this.linked().filter((profile) => !known.includes(profile.relay.computerId)).map(async (profile) => {
      try {
        const [result, computer] = await Promise.all([
          this.deps.call(profile, RELAY_COMPUTER_COMMANDS.grantPhone, [phone]),
          this.deps.call(profile, 'relay:client:computer', []),
        ]);
        const token = decodeOptionalBoundary(result, grantedTokenSchema)?.token;
        const info = decodeOptionalBoundary(computer, relayComputerSchema);
        if (token === undefined || !info || info.id !== profile.relay.computerId) return null;
        return { computer: info, token };
      } catch (error) {
        this.deps.log?.(`[relay] ${profile.label} did not hand out a token: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }));
    return grants.filter((grant): grant is RelayComputerGrant => grant !== null);
  }

  /** A paired phone's "Your computers" refresh. */
  computersFor(callerClientId: string, known: readonly string[]): Promise<RelayComputerGrant[]> {
    const phone = this.caller(callerClientId);
    return this.grantsFor({ label: phone.label, phoneId: phone.phoneId }, known);
  }

  /** Revokes a phone here, by its install id. */
  async removePhone(phoneId: string, callerClientId: string): Promise<void> {
    this.callerComputer(callerClientId);
    await this.revokeLocally({ clients: (client) => client.kind === undefined && client.phoneId === phoneId });
  }

  /** Forgets a computer here: its link both ways, and phone tokens it handed out. */
  async forgetComputer(computerId: string, callerClientId: string): Promise<void> {
    this.callerComputer(callerClientId);
    await this.revokeLocally({ computers: [computerId] });
  }

  devices(): RelayDevice[] {
    const connected = this.deps.connectedClientIds();
    return this.remote().host.clients.filter((client) => client.kind !== 'glasses').map((client) => {
      const device: RelayDevice = {
        clientId: client.id,
        kind: client.kind === 'computer' ? 'computer' : 'phone',
        label: client.label,
        connected: connected.has(client.id),
        createdAt: client.createdAt,
      };
      if (client.linkedBy) device.linkedBy = client.linkedBy;
      if (client.computerId) device.computerId = client.computerId;
      return device;
    });
  }

  /** "Remove from all your computers" on a phone's row. */
  async removePhoneEverywhere(clientId: string): Promise<{ removed: string[]; notReached: string[] }> {
    const record = this.remote().host.clients.find((client) => client.id === clientId);
    if (!record) return { removed: [], notReached: [] };
    // Read first: revoking here forgets the computers this phone linked.
    const peers = this.linked();
    const { phoneId } = record;
    await this.revokeLocally({ clients: (client) => client.id === clientId || (phoneId !== undefined && client.kind === undefined && client.phoneId === phoneId) });
    const removed = [this.deps.self()?.name ?? 'This computer'];
    // Other computers know the phone only by its install id; without one, they still have it.
    if (phoneId === undefined) return { removed, notReached: peers.map((profile) => profile.label) };
    const notReached: string[] = [];
    await Promise.all(peers.map(async (profile) => {
      try {
        await this.deps.call(profile, RELAY_COMPUTER_COMMANDS.removePhone, [{ phoneId }]);
        removed.push(profile.label);
      } catch {
        notReached.push(profile.label);
      }
    }));
    return { removed, notReached };
  }

  /** "Unlink from all your computers" on a linked computer's row. */
  async unlinkComputerEverywhere(computerId: string): Promise<{ removed: string[]; notReached: string[] }> {
    const targets = this.linked();
    const removed: string[] = [];
    const notReached: string[] = [];
    await Promise.all(targets.map(async (profile) => {
      // The unlinked computer forgets this one and the rest; the others forget it.
      const forget = profile.relay.computerId === computerId
        ? targets.filter((other) => other.relay.computerId !== computerId).map((other) => other.relay.computerId).concat(this.deps.self()?.id ?? [])
        : [computerId];
      try {
        for (const id of forget) await this.deps.call(profile, RELAY_COMPUTER_COMMANDS.forgetComputer, [{ computerId: id }]);
        removed.push(profile.label);
      } catch {
        notReached.push(profile.label);
      }
    }));
    await this.revokeLocally({ computers: [computerId] });
    return { removed, notReached };
  }

  private async revokeLocally(seed: Parameters<typeof revokeClients>[1]): Promise<void> {
    let revoked: string[] = [];
    await this.update((remote) => {
      const result = revokeClients(remote, seed);
      revoked = result.revoked;
      return result.remote;
    });
    if (revoked.length) this.deps.disconnect(revoked);
  }
}

/**
 * `POST <address>/invoke` with a link token. The peer's certificate must carry the key its
 * fingerprint names, so a second certificate for the same name (D-16 trust model) is refused.
 */
export function createComputerCaller(options: { dial?: { host: string; port: number }; extraCa?: string } = {}): CallComputer {
  return (profile, channel, args) => new Promise((resolve, reject) => {
    const url = new URL('/invoke', profile.baseUrl);
    const fingerprint = profile.relay?.fingerprint;
    const request = https.request({
      host: options.dial?.host ?? url.hostname,
      port: options.dial?.port ?? (url.port || 443),
      servername: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profile.token}`, host: url.host },
      ca: options.extraCa ? [...tls.rootCertificates, options.extraCa] : undefined,
      checkServerIdentity: fingerprint ? pinnedServerIdentity(fingerprint, profile.label) : undefined,
      timeout: 15_000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => {
        try {
          const body = decodeBoundary(JSON.parse(text), invokeAnswerSchema);
          if (body.ok) resolve(body.result);
          else reject(new Error(decodeOptionalBoundary(body.error, invokeErrorSchema)?.message ?? `HTTP ${response.statusCode}`));
        } catch {
          reject(new Error(`${profile.label} answered HTTP ${response.statusCode}.`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`${profile.label} did not answer within 15 seconds.`)));
    request.on('error', reject);
    request.end(JSON.stringify({ channel, args }));
  });
}
