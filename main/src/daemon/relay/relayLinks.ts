import { createHash, randomBytes, randomUUID } from 'crypto';
import { pinnedServerIdentity } from './keyPinning';
import https from 'https';
import type { OutgoingHttpHeaders } from 'http';
import tls from 'tls';
import { PaneError } from '../../../../shared/paneError';
import {
  normalizeRemoteDaemonConfig,
  type RemoteDaemonClientRecord,
  type RemoteDaemonConfig,
  type RemotePaneConnectionProfile,
} from '../../../../shared/types/remoteDaemon';
import {
  computerRelayId,
  foundRoutes,
  routeProfile,
  upsertComputer,
  type ComputerRoute,
  type ComputerRoutesReport,
  type RemoteComputer,
} from '../../../../shared/types/remoteComputers';
import type { RelayComputer, RelayComputerGrant, RelayDevice, RelayExchangeRequest } from '../../../../shared/types/relay';
import { boundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../../types/config';
import { isRelayComputerUnder, relayKeyMatchesId } from '../../../../shared/remoteClient/relay';
import { RemoteRequestError } from '../../../../shared/remoteClient/remoteDaemonClient';

/** Commands only a linked computer may call, with its link token. */
export const RELAY_COMPUTER_COMMANDS = {
  /** `{label, phoneId}` → `{token}`: a token for a phone that paired with the caller. */
  grantPhone: 'relay:client:grant-phone',
  /** `{peer: RelayComputer}` → `{token}`: a token for a computer that redeemed the caller's link. */
  grantComputer: 'relay:client:grant-computer',
  /** `{phoneId}`: revoke that phone here ("Remove from all your computers"). */
  removePhone: 'relay:client:remove-phone',
  /** `{computerId}`: forget that computer ("Unlink from all your computers"). */
  forgetComputer: 'relay:client:forget-computer',
} as const;

interface RelayLinksConfig {
  getConfig(): Pick<AppConfig, 'remoteDaemon'>;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<object>;
}

/** A linked computer as the link calls take it: its relay route, with the profile id of its computer. */
export type LinkedComputer = RemotePaneConnectionProfile & { relay: NonNullable<RemotePaneConnectionProfile['relay']> };

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
const invokeErrorSchema = boundary.object({ message: boundary.string, code: boundary.optional(boundary.string) });
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

/** The longest a call to a linked computer may take, start to finish. */
const CALL_DEADLINE_MS = 30_000;

function newToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: createHash('sha256').update(token).digest('hex') };
}

/**
 * A computer without its links to the given relay ids: the routes that carry the revoked link
 * token go. A Tailscale route stays, reached by Tailscale identity alone, so a computer also on the
 * tailnet stays as a Tailscale-only row; a computer left with no route goes.
 */
function withoutLinks(computer: RemoteComputer, relayIds: ReadonlySet<string>): RemoteComputer | null {
  const relayId = computerRelayId(computer);
  if (relayId === undefined || !relayIds.has(relayId)) return computer;
  const linkTokens = new Set(computer.routes.filter((route) => route.relay?.computerId === relayId).map((route) => route.token));
  const routes = computer.routes.flatMap((route): ComputerRoute[] => {
    if (route.relay?.computerId === relayId) return [];
    if (!linkTokens.has(route.token)) return [route];
    return route.kind === 'tailscale' ? [{ ...route, token: '' }] : [];
  });
  return routes.length ? { ...computer, routes } : null;
}

/**
 * Removes clients here with everything they vouched for: links a removed phone minted, and for each
 * computer whose link goes, the phone tokens it handed out and the routes that call it. With `keep`,
 * the links a removed computer minted go too, except links for the computers `keep` names: the
 * group as the computer asking sees it, so a stranger's made-up peers go and the group stays linked.
 */
export function revokeClients(
  remote: RemoteDaemonConfig,
  seed: { clients?: (client: RemoteDaemonClientRecord) => boolean; computers?: readonly string[]; keep?: readonly string[] },
) {
  const clients = new Set(remote.host.clients.filter((client) => seed.clients?.(client) === true).map((client) => client.id));
  const computers = new Set(seed.computers);
  const keep = seed.keep && new Set(seed.keep);
  const byId = new Map(remote.host.clients.map((client) => [client.id, client]));
  const cascades = (client: RemoteDaemonClientRecord) => {
    const minter = client.mintedBy === undefined ? undefined : byId.get(client.mintedBy);
    if (!minter || !clients.has(minter.id)) return false;
    if (minter.kind === undefined) return true;
    return minter.kind === 'computer' && keep !== undefined && !keep.has(client.computerId ?? '');
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const client of remote.host.clients) {
      const linkedComputer = client.kind === 'computer' ? client.computerId : undefined;
      if (!clients.has(client.id)) {
        const vouched = cascades(client)
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
  const kept = remote.client.computers.flatMap((computer) => {
    const next = withoutLinks(computer, computers);
    return next ? [next] : [];
  });
  const active = remote.client.activeProfileId;
  const forgetsActive = active !== null && remote.client.computers.some((computer) => computer.id === active) && !kept.some((computer) => computer.id === active);
  return {
    revoked: [...clients],
    remote: {
      ...remote,
      host: { ...remote.host, clients: remote.host.clients.filter((client) => !clients.has(client.id)) },
      client: {
        ...remote.client,
        computers: kept,
        activeProfileId: forgetsActive ? null : active,
        mode: forgetsActive ? 'local' : remote.client.mode,
      },
    },
  };
}

/**
 * "Your computers": linked computers can call each other. A link is a client record of kind
 * "computer" here (the token the peer uses to call this computer) and a relay route on the peer's
 * record in `client.computers` (the token this computer uses to call it), so "Switch to", ports and
 * runpane workspace reach linked computers through today's client code. A paired phone or a linked
 * computer links computers: a phone after it pairs with one (D-16), a computer after it redeems
 * another's one-time link.
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

  /** A paired phone or a linked computer: the devices that link computers. */
  private callerLinker(clientId: string): RemoteDaemonClientRecord {
    const record = this.caller(clientId);
    if (record.kind === 'glasses') {
      throw new PaneError('ERR_RELAY_PHONE_ONLY', 'Only a paired phone or a linked computer can link computers, so nothing was linked.', 'Link computers from the Pane app on your phone or from Pane on a computer.');
    }
    return record;
  }

  private callerPhone(clientId: string): RemoteDaemonClientRecord {
    const record = this.caller(clientId);
    if (record.kind !== undefined) {
      throw new PaneError('ERR_RELAY_PHONE_ONLY', 'Only a paired phone can ask for this.', 'Open Pane on your phone and refresh its computers there.');
    }
    return record;
  }

  private callerComputer(clientId: string): RemoteDaemonClientRecord & { computerId: string } {
    const record = this.caller(clientId);
    if (record.kind !== 'computer' || !record.computerId) {
      throw new PaneError('ERR_RELAY_COMPUTER_ONLY', 'Only a linked computer can ask for this.', 'Link the computers with a one-time link from Add a device › Computer.');
    }
    return { ...record, computerId: record.computerId };
  }

  /** Linked computers this computer can call, each on its relay route. */
  linked(): LinkedComputer[] {
    return this.remote().client.computers.flatMap((computer) => {
      const route = computer.routes.find((candidate) => candidate.kind === 'relay' && candidate.relay);
      if (!route) return [];
      const profile = routeProfile(computer, route);
      return profile.relay ? [{ ...profile, relay: profile.relay }] : [];
    });
  }

  /** The relay id a saved computer's id or a relay id names. */
  private relayIdOf(id: string): string {
    const computer = this.remote().client.computers.find((candidate) => candidate.id === id);
    return (computer && computerRelayId(computer)) ?? id;
  }

  /** A peer this computer may link with: one at `https://<id>.<domain>` under this computer's own relay domain, and not itself. */
  checkPeer(peer: RelayComputer): void {
    const self = this.deps.self();
    if (!self) {
      throw new PaneError('ERR_RELAY_OFF', 'Phone access is off on this computer, so it was not linked.', 'Open Settings › Remote Access › Add a device on this computer, which turns phone access on, then try the link again.');
    }
    if (!relayKeyMatchesId(peer)) {
      throw new PaneError(
        'ERR_RELAY_LINK_KEY_MISMATCH',
        `${peer.name}'s key fingerprint is not the one its id ${peer.id} names, so it was not linked.`,
        'Copy a new link on that computer and open it again.',
      );
    }
    if (!isRelayComputerUnder(peer, self.domain)) {
      throw new PaneError(
        'ERR_RELAY_LINK_OUTSIDE_DOMAIN',
        `${peer.name} is at ${peer.address}, outside this computer's relay domain ${self.domain}, so it was not linked.`,
        `Link only computers that use the same relay: set the same Relay address in Settings › Remote Access › Phones and glasses on both, then link them again.`,
      );
    }
    if (peer.id === self.id) throw new PaneError('ERR_RELAY_LINK_SELF', 'A computer cannot link with itself.', 'Open the link on another computer.');
  }

  /** A client record for a peer computer, replacing any earlier one for it; the new token is returned once. */
  private async addComputerClient(peer: Pick<RelayComputer, 'id' | 'name'>, vouch: { linkedBy?: string; mintedBy?: string } = {}): Promise<{ token: string; clientId: string }> {
    const { token, tokenHash } = newToken();
    const record: RemoteDaemonClientRecord = {
      id: randomUUID(),
      label: peer.name.slice(0, 60) || 'Computer',
      createdAt: new Date().toISOString(),
      tokenHash,
      kind: 'computer',
      computerId: peer.id,
    };
    if (vouch.linkedBy) record.linkedBy = vouch.linkedBy;
    if (vouch.mintedBy) record.mintedBy = vouch.mintedBy;
    await this.addClient(record);
    return { token, clientId: record.id };
  }

  /**
   * Saves a new client record. A phone paired again, or a computer linked again, replaces its
   * earlier record here, and that record's open connections close.
   */
  async addClient(record: RemoteDaemonClientRecord): Promise<void> {
    const replaces = (client: RemoteDaemonClientRecord) => (record.kind === 'computer'
      ? client.kind === 'computer' && client.computerId === record.computerId
      : client.kind === undefined && record.kind === undefined && record.phoneId !== undefined && client.phoneId === record.phoneId);
    const replaced = this.remote().host.clients.filter(replaces).map((client) => client.id);
    await this.update((remote) => ({
      ...remote,
      host: { ...remote.host, clients: [...remote.host.clients.filter((client) => !replaced.includes(client.id)), record] },
    }));
    if (replaced.length) this.deps.disconnect(replaced);
  }

  /** A token for a computer redeeming a link this computer opened; the caller is this computer itself. */
  mintFor(peer: Pick<RelayComputer, 'id' | 'name'>): Promise<{ token: string; clientId: string }> {
    return this.addComputerClient(peer);
  }

  /** Removes a client record this computer minted for a link that did not go through. */
  async dropClient(clientId: string): Promise<void> {
    await this.revokeLocally({ clients: (client) => client.id === clientId });
  }

  /** A phone or linked computer asks this computer for a token its peer computer will use to call this one. */
  async mintLink(peer: RelayComputer, callerClientId: string): Promise<{ token: string }> {
    const linker = this.callerLinker(callerClientId);
    this.checkPeer(peer);
    // A phone that scans a computer again offers its links again. Replacing a working link would cut off the peer's open connection.
    if (this.linked().some((profile) => profile.relay.computerId === peer.id) && this.remote().host.clients.some((client) => client.kind === 'computer' && client.computerId === peer.id)) {
      throw new PaneError('ERR_RELAY_ALREADY_LINKED', `${peer.name} is already linked with this computer, so nothing changed.`, 'Nothing to do; to link it again, unlink it first.');
    }
    const { token } = await this.addComputerClient(peer, { linkedBy: linker.label, mintedBy: linker.id });
    return { token };
  }

  /**
   * Saves a computer this one can now call: its relay route with the token, plus the routes it
   * reported, on its record in `client.computers` (a computer saved already gains the routes).
   * Returns the record's id.
   */
  async saveComputer(peer: { computer: RelayComputer; token: string; routes?: ComputerRoutesReport; linkedBy?: string }): Promise<string> {
    const { computer, token, linkedBy } = peer;
    // A report about another relay id is not this computer's.
    const report = peer.routes && (!peer.routes.relay || peer.routes.relay.id === computer.id) ? peer.routes : undefined;
    const linkRoute: ComputerRoute = {
      id: `relay:${computer.address.replace(/\/+$/u, '')}`,
      kind: 'relay',
      source: 'link',
      baseUrl: computer.address.replace(/\/+$/u, ''),
      token,
      relay: { computerId: computer.id, fingerprint: computer.fingerprint },
    };
    let id = '';
    await this.update((remote) => {
      // An install id another saved computer holds under a different relay id is not trusted to merge.
      const holder = report ? remote.client.computers.find((candidate) => candidate.machineId === report.machineId) : undefined;
      const holderRelay = holder && computerRelayId(holder);
      const machineId = holderRelay && holderRelay !== computer.id ? undefined : report?.machineId;
      const saved = upsertComputer(remote.client.computers, {
        machineId,
        relayId: computer.id,
        label: computer.name,
        os: report?.os,
        linkedBy,
        routes: [...(report ? foundRoutes(report, token) : []), linkRoute],
      });
      id = saved.id;
      return { ...remote, client: { ...remote.client, computers: saved.computers } };
    });
    this.deps.log?.(`[relay] linked with ${computer.name} (${computer.id})${linkedBy ? `, linked by ${linkedBy}` : ''}`);
    return id;
  }

  /** A phone or linked computer hands this computer the token to call a peer it just linked. */
  async saveLink(peer: RelayComputer, token: string, callerClientId: string): Promise<void> {
    const linker = this.callerLinker(callerClientId);
    this.checkPeer(peer);
    await this.saveComputer({ computer: peer, token, linkedBy: linker.label });
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
    await this.addClient(record);
    return { token };
  }

  /** A linked computer hands out a token for a computer that just redeemed its link; unlinking the granter revokes it. */
  async grantComputer(peer: RelayComputer, callerClientId: string): Promise<{ token: string }> {
    const granter = this.callerComputer(callerClientId);
    this.checkPeer(peer);
    const { token } = await this.addComputerClient(peer, { linkedBy: granter.label, mintedBy: granter.id });
    return { token };
  }

  /** Tokens on every linked computer for a phone that just paired here, skipping those it has. */
  grantsFor(phone: { label: string; phoneId?: string }, known: readonly string[]): Promise<RelayComputerGrant[]> {
    return this.grants(RELAY_COMPUTER_COMMANDS.grantPhone, phone, known);
  }

  /** Tokens on every linked computer for a computer that just redeemed this computer's link, skipping those it has. */
  computerGrantsFor(peer: RelayComputer, known: readonly string[]): Promise<RelayComputerGrant[]> {
    return this.grants(RELAY_COMPUTER_COMMANDS.grantComputer, { peer }, [...known, peer.id]);
  }

  private async grants(channel: string, request: { label: string; phoneId?: string } | { peer: RelayComputer }, known: readonly string[]): Promise<RelayComputerGrant[]> {
    const grants = await Promise.all(this.linked().filter((profile) => !known.includes(profile.relay.computerId)).map(async (profile) => {
      try {
        const [result, computer] = await Promise.all([
          this.deps.call(profile, channel, [request]),
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
    // A phone only: a token handed to a linked computer would outlive that computer's removal.
    const phone = this.callerPhone(callerClientId);
    return this.grantsFor({ label: phone.label, phoneId: phone.phoneId }, known);
  }

  /** Revokes a phone here, by its install id. */
  async removePhone(phoneId: string, callerClientId: string): Promise<void> {
    this.callerComputer(callerClientId);
    await this.revokeLocally({ clients: (client) => client.kind === undefined && client.phoneId === phoneId });
  }

  /**
   * Forgets a computer here: its link both ways and the phone tokens it handed out. With `keep`, the
   * links it minted go too, except those for the computers `keep` names.
   */
  async forgetComputer(computerId: string, callerClientId: string, keep?: readonly string[]): Promise<void> {
    this.callerComputer(callerClientId);
    await this.revokeLocally({ computers: [computerId], keep });
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

  /**
   * "Unlink from all your computers" on a linked computer's row: that computer forgets every linked
   * computer and each forgets it. The links it carried between the others stay.
   * `id` is its relay id or its id in `client.computers`.
   */
  async unlinkComputerEverywhere(id: string): Promise<{ removed: string[]; notReached: string[] }> {
    const computerId = this.relayIdOf(id);
    const targets = this.linked();
    const self = this.deps.self()?.id;
    // The group without it: links it minted for these stay, and links it minted for anything else go.
    const group = targets.map((profile) => profile.relay.computerId).filter((other) => other !== computerId).concat(self ?? []);
    // The computers it is removed from: this one, and each other linked computer that answers.
    const removed = [this.deps.self()?.name ?? 'This computer'];
    const notReached: string[] = [];
    await Promise.all(targets.map(async (profile) => {
      const unlinked = profile.relay.computerId === computerId;
      // The unlinked computer forgets this one and the rest; the others forget it.
      const told = unlinked ? await this.tell(profile, group, []) : await this.tell(profile, [computerId], group);
      if (!told) notReached.push(profile.label);
      else if (!unlinked) removed.push(profile.label);
    }));
    await this.revokeLocally({ computers: [computerId], keep: group });
    return { removed, notReached };
  }

  /**
   * "Not you? Unlink" on the computer that made the link: undoes the join `id` made. This computer
   * and the computers it was linked with before forget every computer the join brought, and those
   * forget them. Both groups stay as they were before. Returns the names of the computers unlinked.
   */
  async undoJoin(id: string): Promise<{ removed: string[]; notReached: string[] }> {
    const remote = this.remote();
    const before = this.linked();
    // The join's links here are the joining computer's and every link it minted, so they are what goes with it.
    const after = new Set(revokeClients(remote, { computers: [this.relayIdOf(id)], keep: [] }).remote.client.computers
      .flatMap((computer) => computerRelayId(computer) ?? []));
    const brought = before.filter((profile) => !after.has(profile.relay.computerId));
    const stay = before.filter((profile) => after.has(profile.relay.computerId));
    const ours = stay.map((profile) => profile.relay.computerId).concat(this.deps.self()?.id ?? []);
    const theirs = brought.map((profile) => profile.relay.computerId);
    const notReached: string[] = [];
    await Promise.all([
      ...brought.map(async (profile) => { if (!await this.tell(profile, ours, theirs)) notReached.push(profile.label); }),
      ...stay.map(async (profile) => { if (!await this.tell(profile, theirs, ours)) notReached.push(profile.label); }),
    ]);
    await this.revokeLocally({ computers: theirs, keep: ours });
    return { removed: brought.map((profile) => profile.label), notReached };
  }

  /**
   * Asks a linked computer to forget each of `computerIds` and the links they minted there, except
   * links for the computers `keep` names; false when it does not answer.
   */
  private async tell(profile: LinkedComputer, computerIds: readonly string[], keep: readonly string[]): Promise<boolean> {
    try {
      for (const computerId of computerIds) await this.deps.call(profile, RELAY_COMPUTER_COMMANDS.forgetComputer, [{ computerId, keep: [...keep] }]);
      return true;
    } catch {
      return false;
    }
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

/** How main reaches a computer's address: Pane's relay by name, or a development relay and CA. */
interface ComputerDialOptions {
  dial?: { host: string; port: number };
  extraCa?: string;
}

/** `POST <url>` with a JSON body; resolves with the status and parsed JSON. With a fingerprint, any other key is refused. */
function postJson(
  options: ComputerDialOptions,
  target: { url: string; label: string; body: unknown; token?: string; fingerprint?: string },
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target.url);
    const headers: OutgoingHttpHeaders = { 'content-type': 'application/json', host: url.host };
    if (target.token) headers.authorization = `Bearer ${target.token}`;
    const request = https.request({
      host: options.dial?.host ?? url.hostname,
      port: options.dial?.port ?? (url.port || 443),
      servername: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers,
      ca: options.extraCa ? [...tls.rootCertificates, options.extraCa] : undefined,
      checkServerIdentity: target.fingerprint ? pinnedServerIdentity(target.fingerprint, target.label) : tls.checkServerIdentity,
      timeout: 15_000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, json: JSON.parse(text) });
        } catch {
          reject(new Error(`${target.label} answered HTTP ${response.statusCode}.`));
        }
      });
      // A computer that sleeps or drops off mid-reply ends the response with no 'end' or 'error'.
      response.on('close', () => {
        if (!response.complete) reject(new Error(`${target.label} stopped answering partway through its reply.`));
      });
    });
    // The socket timeout restarts with every byte; this bounds the whole call.
    const deadline = setTimeout(() => request.destroy(new Error(`${target.label} did not finish answering within ${CALL_DEADLINE_MS / 1000} seconds.`)), CALL_DEADLINE_MS);
    request.on('close', () => clearTimeout(deadline));
    request.on('timeout', () => request.destroy(new Error(`${target.label} did not answer within 15 seconds.`)));
    request.on('error', reject);
    request.end(JSON.stringify(target.body));
  });
}

/**
 * `POST <address>/invoke` with a link token. The peer's certificate must carry the key its
 * fingerprint names, so a second certificate for the same name (D-16 trust model) is refused.
 */
export function createComputerCaller(options: ComputerDialOptions = {}): CallComputer {
  return async (profile, channel, args) => {
    const { status, json } = await postJson(options, {
      url: new URL('/invoke', profile.baseUrl).toString(),
      label: profile.label,
      body: { channel, args },
      token: profile.token,
      fingerprint: profile.relay?.fingerprint,
    });
    const body = decodeOptionalBoundary(json, invokeAnswerSchema);
    if (!body) throw new Error(`${profile.label} answered HTTP ${status}.`);
    if (body.ok) return body.result;
    const error = decodeOptionalBoundary(body.error, invokeErrorSchema);
    throw new RemoteRequestError(error?.message ?? `HTTP ${status}`, status, error?.code ?? null);
  };
}

/** A body for a computer's unauthenticated pairing routes: `/pair/preview` takes the secret, `/pair/exchange` the whole request. */
type PairingPostBody = { secret: string } | RelayExchangeRequest;

/** Posts to a computer's pairing routes (`/pair/preview`, `/pair/exchange`) before its key is known; the public certificate is checked. */
export type PostToComputer = (address: string, path: '/pair/preview' | '/pair/exchange', body: PairingPostBody, label: string) => Promise<{ status: number; json: unknown }>;

export function createComputerPoster(options: ComputerDialOptions = {}): PostToComputer {
  return (address, path, body, label) => postJson(options, { url: new URL(path, address).toString(), label, body });
}
