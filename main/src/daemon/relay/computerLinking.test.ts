import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { RemoteRequestError } from '../../../../shared/remoteClient/remoteDaemonClient';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { ComputerRoutesReport, RemoteComputer } from '../../../../shared/types/remoteComputers';
import type { RelayComputer, RelayLinkLifetime, RelayPairedEvent } from '../../../../shared/types/relay';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../../types/config';
import { PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
import { isWatchedComputer } from '../../../../shared/types/remoteComputers';
import { exchangeRelayPairing, fetchNewRelayProfiles, relayProfile, withNewProfiles, type RelayCommandClient, type RelayConnectionProfile } from '../../../../shared/remoteClient/relay';
import { mayInvoke } from '../accessLevel';
import { authenticateRemoteDaemonBearerToken } from '../auth';
import type { PairingRoute } from '../httpApiServer';
import { ComputerLinking, createPairingRoute } from './computerLinking';
import { PairingExchange } from './pairingExchange';
import { registerRelayCommands } from './relayCommands';
import { RelayLinks, type CallComputer, type PostToComputer } from './relayLinks';
import { RelayPreviews } from './relayPreviews';

const DOMAIN = 'relay.test';
const nameSchema = boundary.object({ name: boundary.string });

interface Computer {
  name: string;
  info: RelayComputer;
  registry: PaneCommandRegistry;
  /** A Pane from before access levels. */
  older: boolean;
  asleep: boolean;
  links: RelayLinks;
  route: PairingRoute;
  paired: RelayPairedEvent[];
  config(): RemoteDaemonConfig;
  /** The names of the computers this one lists in `client.computers`. */
  listed(): string[];
  seed(computers: RemoteComputer[]): void;
  /** Client ids whose open connections were dropped. */
  disconnected: string[];
  link(lifetime?: RelayLinkLifetime, access?: 'read' | 'full'): Promise<string>;
  /** A phone redeems a code of this computer's, at its pairing route. */
  pairPhone(link: string, phoneId: string): ReturnType<PairingRoute['exchange']>;
  preview(link: string): Promise<PaneCommandValue>;
  redeem(link: string, access?: 'read' | 'full'): Promise<PaneCommandValue>;
}

/**
 * Computers on one relay domain, each with its real pairing exchange, links, commands and pairing
 * route. The network stands in for the relay and the pairing listener: `/pair/*` goes to the
 * route, `/invoke` checks the token against the callee's clients and runs the command as that
 * client, as the listener does.
 */
/** A computer key's fingerprint and the id it names: the first 80 bits of the key's SHA-256 in base32 (relay/PROTOCOL.md). */
function relayIdentity(seed: string): Pick<RelayComputer, 'id' | 'fingerprint'> {
  const digest = createHash('sha256').update(seed).digest();
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = '';
  for (const byte of digest.subarray(0, 10)) bits += byte.toString(2).padStart(8, '0');
  let id = '';
  for (let at = 0; at < 80; at += 5) id += alphabet[Number.parseInt(bits.slice(at, at + 5), 2)];
  return { id, fingerprint: digest.toString('base64url') };
}

function network() {
  let now = Date.parse('2026-11-15T09:00:00Z');
  const computers = new Map<string, Computer>();
  const at = (address: string) => {
    const computer = computers.get(new URL(address).hostname.split('.')[0]);
    if (!computer) throw new Error(`Nothing answers at ${address}`);
    return computer;
  };

  const post: PostToComputer = async (address, path, body) => {
    const { route } = at(address);
    // As the listener reads it: JSON off the wire.
    const request = decodeBoundary(JSON.parse(JSON.stringify(body)), boundary.jsonObject);
    const secret = String(request.secret);
    const result = path === '/pair/preview'
      ? await route.preview({ secret, source: '192.168.1.20' })
      : await route.exchange({ secret, label: String(request.label), known: decodeBoundary(request.known ?? [], boundary.array(boundary.string)), computer: request.computer, source: '192.168.1.20' });
    if (!result.ok) return { status: result.status, json: { ok: false, error: { code: result.code, message: result.message } } };
    if ('client' in result) {
      const { client, ...rest } = result;
      return { status: 200, json: { ...rest, clientId: client.id } };
    }
    return { status: 200, json: result };
  };

  const call: CallComputer = async (profile, channel, args) => {
    const callee = at(profile.baseUrl);
    if (callee.asleep) throw new Error(`${profile.label} did not answer within 15 seconds.`);
    if (profile.relay?.fingerprint !== callee.info.fingerprint) throw new Error(`${profile.label} showed a different key.`);
    const auth = authenticateRemoteDaemonBearerToken(`Bearer ${profile.token}`, callee.config().host.clients);
    if (!auth.ok) throw new RemoteRequestError('Unauthorized', 403, 'ERR_REMOTE_DAEMON_UNAUTHORIZED');
    const { client } = auth;
    if (!mayInvoke(client.access === 'read' ? 'read' : 'full', channel)) throw new RemoteRequestError('Read only', 409, 'ERR_READ_ONLY_ACCESS');
    if (callee.older && (channel === 'relay:client:grant-read' || channel.startsWith('relay:client:read-devices'))) throw new RemoteRequestError('Unknown command', 400, 'ERR_UNKNOWN_CHANNEL');
    try {
      // SAFETY: link commands take JSON arguments.
      const first = (args[0] ?? null) as PaneCommandValue;
      const forwarded: PaneCommandValue[] = channel.startsWith('relay:client:') ? [first, { clientId: client.id }] : [first];
      // SAFETY: command results are JSON.
      return await callee.registry.invokeRemote(channel, forwarded) as JsonObject;
    } catch (error) {
      throw new RemoteRequestError(error instanceof Error ? error.message : String(error), 400, error instanceof PaneError ? error.code : null);
    }
  };

  function add(name: string, seed: string, report: Omit<ComputerRoutesReport, 'name' | 'relay'> = { machineId: `${seed}-install` }, older = false): Computer {
    const { id, fingerprint } = relayIdentity(seed);
    const info: RelayComputer = { id, name, domain: DOMAIN, address: `https://${id}.${DOMAIN}`, local: [], fingerprint };
    let config = createDefaultRemoteDaemonConfig();
    const configManager = {
      getConfig: () => ({ remoteDaemon: config }),
      updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => {
        // SAFETY: the relay code reads and writes only remoteDaemon.
        const current = { remoteDaemon: config } as AppConfig;
        const patch = update(current);
        if (patch.remoteDaemon) config = patch.remoteDaemon;
        return { ...current, remoteDaemon: config };
      },
    };
    const routes: ComputerRoutesReport = { ...report, name, relay: { id, address: info.address, fingerprint: info.fingerprint, local: [] } };
    const disconnected: string[] = [];
    const links: RelayLinks = new RelayLinks({ config: configManager, self: () => info, call, disconnect: (ids) => disconnected.push(...ids), connectedClientIds: () => new Set() });
    const exchange = new PairingExchange({ now: () => now, addClient: (record) => links.addClient(record) });
    const linking = new ComputerLinking({ links, self: () => info, routesReport: () => routes, post, call });
    const paired: RelayPairedEvent[] = [];
    const route = createPairingRoute({
      host: {
        checkSecret: (secret, source) => exchange.check(secret, source),
        exchangeSecret: async (request) => {
          const result = await exchange.exchange(request);
          return result.ok ? { ...result, computer: info } : result;
        },
        computerInfo: () => info,
        forwardedClient: () => null,
      },
      links,
      routesReport: () => routes,
      onPaired: (event) => paired.push(event),
    });
    const registry = new PaneCommandRegistry();
    registerRelayCommands(registry, {
      getStatus: () => { throw new Error('not used'); },
      retryNow: () => {},
      computerInfo: () => info,
      // The URL the relay service builds: the maker's domain, the secret, its id and its name.
      createPairingCode: (lifetime, access) => {
        const { secret, expiresAt } = exchange.createSecret(lifetime, access);
        return { url: `https://${DOMAIN}/pair#${new URLSearchParams({ s: secret, c: id, n: name }).toString()}`, expiresAt };
      },
    }, new RelayPreviews({ id: () => null, domain: () => null, isForwardedPort: () => false, clientActive: () => false }), links, linking, configManager);
    const computer: Computer = {
      name,
      info,
      registry,
      older,
      asleep: false,
      links,
      disconnected,
      route,
      paired,
      config: () => config,
      listed: () => config.client.computers.map((saved) => saved.label).sort(),
      seed: (saved) => { config = { ...config, client: { ...config.client, computers: saved } }; },
      link: async (lifetime = '10m', access = 'full') => decodeBoundary(await registry.invoke('relay:pairing-code', [{ expiresIn: lifetime, access }]), boundary.object({ url: boundary.string })).url,
      pairPhone: (link, phoneId) => route.exchange({ secret: new URLSearchParams(new URL(link).hash.slice(1)).get('s') ?? '', label: 'Phone', phoneId, source: '192.168.1.30' }),
      preview: (link) => registry.invoke('relay:link-preview', [{ link }]),
      redeem: async (link, access) => registry.invoke('relay:redeem-link', [{ link, access: access ?? (decodeBoundary(await registry.invoke('relay:link-preview', [{ link }]), boundary.object({ access: boundary.optional(boundary.enumeration('read', 'full')) })).access ?? 'full') }]),
    };
    computers.set(id, computer);
    return computer;
  }

  /** Whether `from` reaches `to` with the token it saved for it. */
  async function reaches(from: Computer, to: Computer): Promise<boolean> {
    const saved = from.config().client.computers.find((computer) => computer.routes.some((route) => route.relay?.computerId === to.info.id && route.kind === 'relay'));
    const route = saved?.routes.find((candidate) => candidate.kind === 'relay');
    if (!saved || !route) return false;
    try {
      const answer = await call({ id: saved.id, label: saved.label, baseUrl: route.baseUrl, token: route.token, transport: 'http+sse', relay: route.relay }, 'relay:client:computer', []);
      return decodeBoundary(answer, nameSchema).name === to.name;
    } catch {
      return false;
    }
  }

  /** Calls `channel` on `to` as `from`, with the token `from` saved for it. */
  async function callAs(from: Computer, to: Computer, channel: string, request: JsonObject): Promise<PaneCommandValue> {
    const saved = from.config().client.computers.find((computer) => computer.routes.some((route) => route.relay?.computerId === to.info.id && route.kind === 'relay'));
    const route = saved?.routes.find((candidate) => candidate.kind === 'relay');
    if (!saved || !route) throw new Error(`${from.name} has no link to ${to.name}`);
    // SAFETY: link commands answer JSON.
    return await call({ id: saved.id, label: saved.label, baseUrl: route.baseUrl, token: route.token, transport: 'http+sse', relay: route.relay }, channel, [request]) as PaneCommandValue;
  }

  /** A paired phone: its requests carry its token, as its app's do. */
  function phone(): (profile: RelayConnectionProfile) => RelayCommandClient {
    return (profile) => ({
      // SAFETY: link commands answer JSON, which the caller decodes.
      invoke: async <T>(channel: string, args: unknown[] = []) => await call({ ...profile, relay: profile.relay }, channel, args) as T,
    });
  }

  return { add, reaches, callAs, phone, advance: (ms: number) => { now += ms; } };
}

describe('linking computers with a one-time link', () => {
  it('asks before linking a computer with nothing linked, then links both ways, with the maker naming it', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const link = await mac.link('1h');

    expect(await windows.preview(link)).toMatchObject({ maker: 'Mac', makerGroup: ['Mac'], here: [], needsConfirm: true });
    expect(await windows.redeem(link)).toEqual({ linked: ['Mac'] });

    expect(mac.listed()).toEqual(['Windows']);
    expect(windows.listed()).toEqual(['Mac']);
    expect(await net.reaches(windows, mac)).toBe(true);
    expect(await net.reaches(mac, windows)).toBe(true);
    const saved = mac.config().client.computers[0];
    expect(mac.paired).toEqual([{ kind: 'computer', label: 'Windows', computerId: saved.id }]);
    // The redeemer told the maker its install id.
    expect(saved.machineId).toBe('winwinwinwinwin0-install');
    expect(mac.config().host.clients).toEqual([expect.objectContaining({ kind: 'computer', computerId: windows.info.id, label: 'Windows' })]);
  });

  it('previews without spending the link, and a second use is refused', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const linux = net.add('Linux', 'linlinlinlinlin0');
    const link = await mac.link();

    await windows.preview(link);
    await windows.preview(link);
    await linux.redeem(link);

    await expect(windows.redeem(link)).rejects.toMatchObject({ code: 'ERR_PAIRING_CODE_USED', message: expect.stringContaining('This code was already used') });
    await expect(windows.preview(link)).rejects.toMatchObject({ code: 'ERR_PAIRING_CODE_USED' });
    expect(windows.listed()).toEqual([]);
  });

  it('refuses a link past its expiry', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const link = await mac.link('10m');
    net.advance(11 * 60_000);
    await expect(windows.redeem(link)).rejects.toMatchObject({ code: 'ERR_PAIRING_CODE_EXPIRED', message: expect.stringContaining('This code expired') });
  });

  it('joins two groups: each computer in one is linked with each in the other, after asking', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const linux = net.add('Linux', 'linlinlinlinlin0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const nas = net.add('NAS', 'nasnasnasnasnas0');
    await linux.redeem(await mac.link());
    await nas.redeem(await windows.link());

    const link = await mac.link('24h');
    expect(await windows.preview(link)).toMatchObject({ maker: 'Mac', makerGroup: ['Mac', 'Linux'], here: ['NAS'], needsConfirm: true });
    expect(await windows.redeem(link)).toEqual({ linked: ['Mac', 'Linux'] });

    const all = [mac, linux, windows, nas];
    for (const from of all) {
      expect(from.listed()).toEqual(all.filter((other) => other !== from).map((other) => other.name).sort());
      for (const to of all) if (to !== from) expect(await net.reaches(from, to), `${from.name} reaches ${to.name}`).toBe(true);
    }
    // NAS reaches Linux now, so another link from Linux asks nothing.
    expect(await nas.preview(await linux.link())).toMatchObject({ needsConfirm: false });
  });

  it('adds a link to a computer saved already instead of listing it twice', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0', { machineId: 'mac-install' });
    const windows = net.add('Windows', 'winwinwinwinwin0');
    windows.seed([{
      id: 'tailnet-mac',
      label: 'mac',
      machineId: 'mac-install',
      routes: [{ id: 'tailscale:https://mac.tail1234.ts.net:42137', kind: 'tailscale', source: 'found', baseUrl: 'https://mac.tail1234.ts.net:42137', token: '', tailnetMachine: 'mac', tailnetDomain: 'tail1234.ts.net' }],
    }]);

    await windows.redeem(await mac.link());
    await windows.redeem(await mac.link());

    expect(windows.config().client.computers).toEqual([expect.objectContaining({ id: 'tailnet-mac', label: 'Mac' })]);
    expect(windows.config().client.computers[0].routes.map((route) => route.kind)).toEqual(['tailscale', 'relay']);
    expect(await net.reaches(windows, mac)).toBe(true);
  });

  it('"Unlink from all your computers" removes the computer everywhere; one also on the tailnet stays as a Tailscale row', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const linux = net.add('Linux', 'linlinlinlinlin0');
    const windows = net.add('Windows', 'winwinwinwinwin0', { machineId: 'win-install', tailnet: { dnsName: 'windows.tail1234.ts.net', machine: 'windows', domain: 'tail1234.ts.net', port: 42137 } });
    await linux.redeem(await mac.link());
    await windows.redeem(await mac.link());
    const { computerId } = mac.paired[mac.paired.length - 1];

    const result = await mac.registry.invoke('relay:unlink-computer-everywhere', [{ computerId }]);

    expect(result).toEqual({ removed: expect.arrayContaining(['Mac', 'Linux']), notReached: [] });
    expect(await net.reaches(mac, windows)).toBe(false);
    expect(await net.reaches(linux, windows)).toBe(false);
    expect(await net.reaches(windows, mac)).toBe(false);
    expect(windows.listed()).toEqual([]);
    expect(linux.listed()).toEqual(['Mac']);
    expect(mac.config().client.computers.find((computer) => computer.label === 'Windows')?.routes).toEqual([
      expect.objectContaining({ kind: 'tailscale', token: '' }),
    ]);
  });

  it('"Unlink from all your computers" removes only that computer; the links it carried between the others stay', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const linux = net.add('Linux', 'linlinlinlinlin0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const nas = net.add('NAS', 'nasnasnasnasnas0');
    await linux.redeem(await mac.link());
    await nas.redeem(await windows.link());
    await windows.redeem(await mac.link());
    const macOnWindows = windows.config().client.computers.find((computer) => computer.label === 'Mac');

    await windows.registry.invoke('relay:unlink-computer-everywhere', [{ computerId: macOnWindows?.id ?? '' }]);

    const rest = [linux, windows, nas];
    for (const from of rest) {
      expect(from.listed(), `${from.name}'s list`).toEqual(rest.filter((other) => other !== from).map((other) => other.name).sort());
      expect(await net.reaches(from, mac), `${from.name} reaches Mac`).toBe(false);
      for (const to of rest) if (to !== from) expect(await net.reaches(from, to), `${from.name} reaches ${to.name}`).toBe(true);
    }
    expect(mac.listed()).toEqual([]);
  });

  it('"Not you? Unlink" after a group join leaves both groups as they were', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const linux = net.add('Linux', 'linlinlinlinlin0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    const nas = net.add('NAS', 'nasnasnasnasnas0');
    await linux.redeem(await mac.link());
    await nas.redeem(await windows.link());
    await windows.redeem(await mac.link());
    const { computerId } = mac.paired[mac.paired.length - 1];

    const result = await mac.registry.invoke('relay:undo-join', [{ computerId }]);

    expect(result).toEqual({ removed: expect.arrayContaining(['Windows', 'NAS']), notReached: [] });
    for (const group of [[mac, linux], [windows, nas]]) {
      const others = [mac, linux, windows, nas].filter((computer) => !group.includes(computer));
      for (const from of group) {
        expect(from.listed(), `${from.name}'s list`).toEqual(group.filter((other) => other !== from).map((other) => other.name));
        for (const to of group) if (to !== from) expect(await net.reaches(from, to), `${from.name} reaches ${to.name}`).toBe(true);
        for (const to of others) expect(await net.reaches(from, to), `${from.name} reaches ${to.name}`).toBe(false);
      }
    }
  });

  it('"Not you? Unlink" on a lone computer that a group joined leaves the group linked', async () => {
    const net = network();
    const [mac, linux, windows, nas] = [['Mac', 'macmacmacmacmac0'], ['Linux', 'linlinlinlinlin0'], ['Windows', 'winwinwinwinwin0'], ['NAS', 'nasnasnasnasnas0']]
      .map(([name, seed]) => net.add(name, seed));
    await linux.redeem(await mac.link());
    await windows.redeem(await mac.link());
    await nas.redeem(await mac.link());
    const lone = net.add('Studio', 'stustustustustu0');
    await linux.redeem(await lone.link());
    const { computerId } = lone.paired[lone.paired.length - 1];

    await lone.registry.invoke('relay:undo-join', [{ computerId }]);

    const group = [mac, linux, windows, nas];
    expect(lone.listed()).toEqual([]);
    for (const from of group) {
      expect(from.listed(), `${from.name}'s list`).toEqual(group.filter((other) => other !== from).map((other) => other.name).sort());
      expect(await net.reaches(from, lone), `${from.name} reaches Studio`).toBe(false);
      expect(await net.reaches(lone, from), `Studio reaches ${from.name}`).toBe(false);
      for (const to of group) if (to !== from) expect(await net.reaches(from, to), `${from.name} reaches ${to.name}`).toBe(true);
    }
  });

  it.each([
    ['"Not you? Unlink"', 'relay:undo-join'],
    ['"Unlink from all your computers"', 'relay:unlink-computer-everywhere'],
  ])('%s also removes the links a stranger\'s computer minted for computers outside the group', async (_name, channel) => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    await windows.redeem(await mac.link());
    const stranger = net.add('Stranger', 'strstrstrstrstr0');
    await stranger.redeem(await mac.link());
    const madeUp = net.add('Made up', 'fakfakfakfakfak0');
    await net.callAs(stranger, windows, 'relay:client:mint-link', { peer: { ...madeUp.info } });
    const madeUpOnWindows = () => windows.config().host.clients.filter((client) => client.computerId === madeUp.info.id);
    expect(madeUpOnWindows()).toHaveLength(1);
    const strangerOnMac = mac.config().client.computers.find((computer) => computer.label === 'Stranger');

    await mac.registry.invoke(channel, [{ computerId: strangerOnMac?.id ?? '' }]);

    expect(madeUpOnWindows()).toEqual([]);
    expect(await net.reaches(windows, mac)).toBe(true);
    expect(await net.reaches(mac, windows)).toBe(true);
  });

  it('refuses a link from a computer claiming a linked computer\'s id with another key, and leaves the link unused', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const windows = net.add('Windows', 'winwinwinwinwin0');
    await windows.redeem(await mac.link());
    const impostor = net.add('Windows', 'winwinwinwinwin0');
    impostor.info.fingerprint = 'another-key';
    const link = await mac.link();

    await expect(impostor.redeem(link)).rejects.toMatchObject({ code: 'ERR_RELAY_LINK_KEY_MISMATCH' });
    expect(await net.reaches(windows, mac)).toBe(true);
    const linux = net.add('Linux', 'linlinlinlinlin0');
    await expect(linux.redeem(link)).resolves.toMatchObject({ linked: expect.arrayContaining(['Mac']) });
  });

  it('tells the dialog when a phone used its code', async () => {
    const net = network();
    const mac = net.add('Mac', 'macmacmacmacmac0');
    const secret = new URLSearchParams(new URL(await mac.link()).hash.slice(1)).get('s') ?? '';
    await mac.route.exchange({ secret, label: 'Pixel 9', source: '192.168.1.30' });
    expect(mac.paired).toEqual([{ kind: 'phone', label: 'Pixel 9' }]);
  });
});

describe('a read-only link', () => {
  /** Tyler (with A2 and the older A3 linked) shares with Parsa (linked with B2). */
  async function shared() {
    const net = network();
    const tyler = net.add('Tyler', 'tylertylertyler0');
    const a2 = net.add('A2', 'a2a2a2a2a2a2a2a0');
    const a3 = net.add('A3', 'a3a3a3a3a3a3a3a0', undefined, true);
    const parsa = net.add('Parsa', 'parsaparsaparsa0');
    const b2 = net.add('B2', 'b2b2b2b2b2b2b2b0');
    await a2.redeem(await tyler.link());
    await a3.redeem(await tyler.link());
    await b2.redeem(await parsa.link());
    const before = { a2: a2.listed(), a3: a3.listed(), b2: b2.listed(), bClients: parsa.config().host.clients, b2Clients: b2.config().host.clients };
    return { net, tyler, a2, a3, parsa, b2, before };
  }

  it('reaches the sharer and its linked computers one way, and no groups join', async () => {
    const { net, tyler, a2, a3, parsa, b2, before } = await shared();
    const link = await tyler.link('24h', 'read');

    expect(await parsa.preview(link)).toMatchObject({ maker: 'Tyler', access: 'read', here: [], needsConfirm: true });
    expect(await parsa.redeem(link)).toEqual({ linked: ['Tyler', 'A2'], access: 'read' });

    expect(parsa.listed()).toEqual(['A2', 'B2', 'Tyler']);
    expect(await net.reaches(parsa, tyler)).toBe(true);
    expect(await net.reaches(parsa, a2)).toBe(true);
    expect(parsa.config().client.computers.filter(isWatchedComputer).map((computer) => computer.label).sort()).toEqual(['A2', 'Tyler']);

    // The sharer's side gained no route and no token to the reader's computers, and the older A3 handed out nothing.
    expect([tyler.listed(), a2.listed(), a3.listed(), b2.listed()]).toEqual([['A2', 'A3'], before.a2, before.a3, before.b2]);
    expect([parsa.config().host.clients, b2.config().host.clients]).toEqual([before.bClients, before.b2Clients]);
    expect(a3.config().host.clients.some((client) => client.label === 'Parsa')).toBe(false);
    for (const computer of [tyler, a2]) {
      expect(computer.config().host.clients.filter((client) => client.label === 'Parsa')).toEqual([expect.objectContaining({ kind: 'computer', access: 'read' })]);
    }
  });

  it('can mint, save or grant nothing on the computers it watches', async () => {
    const { net, tyler, parsa, b2 } = await shared();
    await parsa.redeem(await tyler.link('10m', 'read'));
    for (const channel of ['relay:client:mint-link', 'relay:client:save-link', 'relay:client:grant-phone', 'relay:client:grant-computer', 'relay:client:grant-read', 'relay:client:read-devices', 'relay:client:read-devices-changed', 'relay:client:forget-computer', 'relay:client:preview-address']) {
      await expect(net.callAs(parsa, tyler, channel, { peer: { ...b2.info }, token: 'x', label: 'Phone', computerId: b2.info.id }), channel).rejects.toMatchObject({ code: 'ERR_READ_ONLY_ACCESS' });
    }
    // A later full link with someone else doesn't bring the shared computer along.
    const other = net.add('Other', 'otherotherother0');
    expect(await other.preview(await parsa.link())).toMatchObject({ makerGroup: ['Parsa', 'B2'] });
    await other.redeem(await parsa.link());
    expect(other.listed()).toEqual(['B2', 'Parsa']);
  });

  it('loses every computer it watches when the owner removes it', async () => {
    const { net, tyler, a2, parsa } = await shared();
    await parsa.redeem(await tyler.link('10m', 'read'));
    const record = tyler.config().host.clients.find((client) => client.access === 'read');
    const onA2 = a2.config().host.clients.find((client) => client.access === 'read');

    const result = await tyler.registry.invoke('relay:remove-phone-everywhere', [{ clientId: record?.id }]);

    expect(result).toEqual({ removed: ['Tyler', 'A2'], notReached: [] });
    expect(await net.reaches(parsa, tyler)).toBe(false);
    expect(await net.reaches(parsa, a2)).toBe(false);
    expect([tyler.disconnected, a2.disconnected]).toEqual([[record?.id], [onA2?.id]]);

    // Shared again later, its saved computers work again, the linked one too.
    await parsa.redeem(await tyler.link('10m', 'read'));
    expect(await net.reaches(parsa, tyler)).toBe(true);
    expect(await net.reaches(parsa, a2)).toBe(true);
  });

  it('refuses a computer that already has full access, leaving the link for another', async () => {
    const { net, tyler, a2, b2 } = await shared();
    const link = await tyler.link('10m', 'read');
    await expect(a2.redeem(link)).rejects.toMatchObject({ code: 'ERR_LINK_ALREADY_FULL' });
    expect(await net.reaches(tyler, a2)).toBe(true);
    expect(await b2.redeem(link)).toMatchObject({ access: 'read' });
  });

  it('cannot remove a full-access device by claiming its id', async () => {
    const { net, tyler, a2 } = await shared();
    const own = await tyler.pairPhone(await tyler.link(), 'owner-phone');
    const claimed = await tyler.pairPhone(await tyler.link('10m', 'read'), 'owner-phone');
    expect([own, claimed]).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true, token: expect.stringMatching(/^pane_read_/u) })]);
    const phones = () => tyler.config().host.clients.filter((client) => client.phoneId === 'owner-phone').map((client) => client.access ?? 'full');
    expect(phones()).toEqual(['full', 'read']);

    const read = tyler.config().host.clients.find((client) => client.access === 'read');
    await tyler.registry.invoke('relay:remove-phone-everywhere', [{ clientId: read?.id }]);
    expect(phones()).toEqual(['full']);
    expect(a2.config().host.clients.filter((client) => client.phoneId === 'owner-phone').map((client) => client.access ?? 'full')).toEqual(['full']);
    expect(await net.reaches(tyler, a2)).toBe(true);
  });

  it('gives a read-only phone read-only tokens, also when it refreshes its computers', async () => {
    const { tyler, a2, a3 } = await shared();
    const paired = await tyler.pairPhone(await tyler.link('10m', 'read'), 'reader-phone');
    expect(paired).toMatchObject({ ok: true, token: expect.stringMatching(/^pane_read_/u) });
    const phones = (computer: Computer) => computer.config().host.clients.filter((client) => client.phoneId === 'reader-phone').map((client) => client.access);
    expect([phones(tyler), phones(a2), phones(a3)]).toEqual([['read'], ['read'], []]);

    const reader = tyler.config().host.clients.find((client) => client.phoneId === 'reader-phone');
    const refreshed = await tyler.registry.invokeRemote('relay:client:computers', [{ known: [] }, { clientId: reader?.id }]);
    expect(refreshed).toEqual([expect.objectContaining({ computer: expect.objectContaining({ name: 'A2' }) })]);
    expect([phones(a2), phones(a3)]).toEqual([['read'], []]);
  });

  it('takes nothing from an older computer that offers a token and its group', async () => {
    const { tyler, parsa } = await shared();
    const link = await tyler.link('10m', 'read');
    const result = await tyler.route.exchange({
      secret: new URLSearchParams(new URL(link).hash.slice(1)).get('s') ?? '',
      label: 'Parsa', source: '192.168.1.20', known: [],
      computer: { computer: { ...parsa.info }, token: 'a token for Tyler to call Parsa' },
    });
    expect(result).toMatchObject({ ok: true, token: expect.stringMatching(/^pane_read_/u) });
    expect(tyler.listed()).toEqual(['A2', 'A3']);
    expect(tyler.config().host.clients.filter((client) => client.label === 'Parsa')).toEqual([expect.objectContaining({ access: 'read' })]);
  });

  /** Parsa's phone, paired Read only with Tyler, holding what the app saves. */
  async function sharedPhone() {
    const net = await shared();
    const paired = await net.tyler.pairPhone(await net.tyler.link('10m', 'read'), 'reader-phone');
    if (!paired.ok) throw new Error(paired.message);
    const tyler = relayProfile({ computer: { ...net.tyler.info }, token: paired.token });
    const saved = [tyler, ...(paired.linked ?? []).map((grant) => relayProfile(grant, 'Tyler'))];
    const client = net.net.phone();
    const works = async (profile: RelayConnectionProfile) => client(profile).invoke('relay:client:computer').then(() => true, () => false);
    return { ...net, saved, client, works, onTyler: saved[0], onA2: saved[1] };
  }

  it('keeps every computer working when a phone opens any of them, in any order, and after one is renamed', async () => {
    const { saved, client, works, onTyler, onA2, tyler, a2 } = await sharedPhone();
    let profiles = saved;
    for (const opened of [onA2, onTyler, onA2, { ...onTyler, label: 'Tyler, renamed' }]) {
      profiles = withNewProfiles(profiles, await fetchNewRelayProfiles(client(opened), opened, profiles));
      for (const profile of profiles) expect(await works(profile), `${profile.label} after opening ${opened.label}`).toBe(true);
    }
    for (const computer of [tyler, a2]) expect(computer.config().host.clients.filter((record) => record.phoneId === 'reader-phone')).toHaveLength(1);
  });

  it('stays removed: a linked computer that slept through it drops the token when it wakes, and can win none back meanwhile', async () => {
    const { tyler, a2, client, works, onTyler, onA2 } = await sharedPhone();
    a2.asleep = true;
    const record = tyler.config().host.clients.find((saved) => saved.access === 'read');
    // However it is removed: the row's own Remove, or the plain one, which only drops the record here.
    expect(await tyler.registry.invoke('relay:remove-phone-everywhere', [{ clientId: record?.id }])).toEqual({ removed: ['Tyler'], notReached: ['A2'] });

    a2.asleep = false;
    expect(await fetchNewRelayProfiles(client(onA2), onA2, [])).toEqual([]);
    expect(await works(onTyler)).toBe(false);
    expect(tyler.config().host.clients.some((saved) => saved.access === 'read')).toBe(false);
    await a2.links.followReadDevices();
    expect(await works(onA2)).toBe(false);
  });

  it('drops a linked computer\'s tokens for a device however it was removed, and keeps those it shares itself', async () => {
    const { tyler, a2, works, onA2 } = await sharedPhone();
    const own = await a2.pairPhone(await a2.link('10m', 'read'), 'other-phone');
    await tyler.links.dropClient(tyler.config().host.clients.find((saved) => saved.access === 'read')?.id ?? '');
    await tyler.links.tellReadDevices();
    expect(await works(onA2)).toBe(false);
    expect(own.ok && a2.config().host.clients.some((saved) => saved.id === own.client.id)).toBe(true);
  });

  it('refuses a link whose computer changes its level after the person agreed, and gives nothing', async () => {
    const { tyler, parsa, before } = await shared();
    const link = await tyler.link('10m', 'full');
    const preview = tyler.route.preview;
    // A changed Pane: Read only on the screen, full when it counts.
    let asked = 0;
    tyler.route.preview = async (request) => {
      const answer = await preview(request);
      asked += 1;
      return answer.ok && asked === 1 ? { ...answer, access: 'read' } : answer;
    };
    expect(await parsa.preview(link)).toMatchObject({ access: 'read' });
    await expect(parsa.redeem(link, 'read')).rejects.toMatchObject({ code: 'ERR_LINK_LEVEL_CHANGED' });
    expect([parsa.listed(), parsa.config().host.clients]).toEqual([['B2'], before.bClients]);

    // Or Read only to every preview, and a full token at the end.
    tyler.route.preview = async (request) => {
      const answer = await preview(request);
      return answer.ok ? { ...answer, access: 'read' } : answer;
    };
    const exchange = tyler.route.exchange;
    tyler.route.exchange = async (request) => exchange({ ...request, computer: { computer: { ...parsa.info }, token: 'parsa-gives-none' } });
    await expect(parsa.redeem(link, 'read')).rejects.toMatchObject({ code: 'ERR_LINK_LEVEL_CHANGED' });
    expect([parsa.listed(), parsa.config().host.clients]).toEqual([['B2'], before.bClients]);
  });

  it('passes on no token of another level from a changed linked computer', async () => {
    const { tyler, a2 } = await shared();
    const grantRead = a2.links.grantRead.bind(a2.links);
    a2.links.grantRead = async (device, caller) => ({ token: (await grantRead(device, caller)).token.replace('pane_read_', '') });
    const paired = await tyler.pairPhone(await tyler.link('10m', 'read'), 'reader-phone');
    expect(paired).toMatchObject({ ok: true, linked: [] });
  });

  it('lets a phone and browser keep nothing from an exchange that is not the Read only they agreed to', async () => {
    const { tyler } = await shared();
    const answer = (token: string) => async () => new Response(JSON.stringify({ ok: true, token, clientId: 'c', computer: tyler.info, linked: [] }));
    const scanned = { computerId: tyler.info.id, domain: DOMAIN, name: 'Tyler' };
    const request = { secret: 's', label: 'Phone' };
    await expect(exchangeRelayPairing(answer('full-token'), scanned, request, { watching: true })).rejects.toMatchObject({ code: 'ERR_PAIRING_LEVEL_CHANGED' });
    expect(await exchangeRelayPairing(answer('pane_read_x'), scanned, request, { watching: true })).toEqual([expect.objectContaining({ token: 'pane_read_x' })]);
  });

  it('forgets a watched computer whole: its Tailscale route never stays as full access', async () => {
    const { parsa, tyler } = await shared();
    await parsa.redeem(await tyler.link('10m', 'read'));
    parsa.seed(parsa.config().client.computers.map((computer) => (computer.label !== 'Tyler' ? computer : {
      ...computer,
      routes: [...computer.routes, { id: 'tailscale:https://tyler.ts.net:8443', kind: 'tailscale', source: 'found', baseUrl: 'https://tyler.ts.net:8443', token: computer.routes[0].token, tailnetMachine: 'tyler', tailnetDomain: 'ts.net' }],
    })));
    await parsa.registry.invoke('relay:unlink-computer-everywhere', [{ computerId: tyler.info.id }]);
    expect(parsa.listed()).not.toContain('Tyler');
  });
});
