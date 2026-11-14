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

export interface RelayLinksConfig {
  getConfig(): Pick<AppConfig, 'remoteDaemon'>;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<object>;
}

/** Calls a linked computer's `/invoke` with its link token; the key fingerprint is checked. */
export type CallComputer = (profile: RemotePaneConnectionProfile, channel: string, args: unknown[]) => Promise<unknown>;

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

function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

function profileId(computerId: string): string {
  return `relay-${computerId}`;
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
    const phone = this.caller(callerClientId);
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
    const phone = this.caller(callerClientId);
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
      ...(phone.phoneId ? { phoneId: phone.phoneId } : {}),
      linkedBy: granter.label,
      grantedBy: granter.computerId,
    };
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
        const token = (result as { token?: unknown } | null)?.token;
        const info = computer as RelayComputer | null;
        if (typeof token !== 'string' || !info || info.id !== profile.relay.computerId) return null;
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
    await this.revokeLocally((client) => client.kind === undefined && client.phoneId === phoneId);
  }

  /** Forgets a computer here: its link both ways, and phone tokens it handed out. */
  async forgetComputer(computerId: string, callerClientId: string): Promise<void> {
    this.callerComputer(callerClientId);
    await this.forgetLocally(computerId);
  }

  devices(): RelayDevice[] {
    const connected = this.deps.connectedClientIds();
    return this.remote().host.clients.filter((client) => client.kind !== 'glasses').map((client) => ({
      clientId: client.id,
      kind: client.kind === 'computer' ? 'computer' : 'phone',
      label: client.label,
      ...(client.linkedBy ? { linkedBy: client.linkedBy } : {}),
      ...(client.computerId ? { computerId: client.computerId } : {}),
      connected: connected.has(client.id),
      createdAt: client.createdAt,
    }));
  }

  /** "Remove from all your computers" on a phone's row. */
  async removePhoneEverywhere(clientId: string): Promise<{ removed: string[]; notReached: string[] }> {
    const record = this.remote().host.clients.find((client) => client.id === clientId);
    if (!record) return { removed: [], notReached: [] };
    await this.revokeLocally((client) => client.id === clientId || (record.phoneId !== undefined && client.kind === undefined && client.phoneId === record.phoneId));
    const removed = [this.deps.self()?.name ?? 'This computer'];
    const notReached: string[] = [];
    if (record.phoneId) {
      await Promise.all(this.linked().map(async (profile) => {
        try {
          await this.deps.call(profile, RELAY_COMPUTER_COMMANDS.removePhone, [{ phoneId: record.phoneId }]);
          removed.push(profile.label);
        } catch {
          notReached.push(profile.label);
        }
      }));
    }
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
    await this.forgetLocally(computerId);
    return { removed, notReached };
  }

  private async forgetLocally(computerId: string): Promise<void> {
    await this.revokeLocally((client) => (client.kind === 'computer' && client.computerId === computerId) || client.grantedBy === computerId);
    await this.update((remote) => ({
      ...remote,
      client: {
        ...remote.client,
        profiles: remote.client.profiles.filter((profile) => profile.relay?.computerId !== computerId),
        activeProfileId: remote.client.activeProfileId === profileId(computerId) ? null : remote.client.activeProfileId,
        mode: remote.client.activeProfileId === profileId(computerId) ? 'local' : remote.client.mode,
      },
    }));
  }

  private async revokeLocally(match: (client: RemoteDaemonClientRecord) => boolean): Promise<void> {
    const ids = this.remote().host.clients.filter(match).map((client) => client.id);
    if (!ids.length) return;
    await this.update((remote) => ({ ...remote, host: { ...remote.host, clients: remote.host.clients.filter((client) => !ids.includes(client.id)) } }));
    this.deps.disconnect(ids);
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
          const body = JSON.parse(text) as { ok?: boolean; result?: unknown; error?: { message?: string } };
          if (body.ok) resolve(body.result);
          else reject(new Error(body.error?.message ?? `HTTP ${response.statusCode}`));
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
