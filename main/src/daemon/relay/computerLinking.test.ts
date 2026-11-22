import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { linkWithSavedRelayComputers, relayProfile, type RelayConnectionProfile } from '../../../../shared/remoteClient/relay';
import { RemoteRequestError } from '../../../../shared/remoteClient/remoteDaemonClient';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { ComputerRoutesReport, RemoteComputer } from '../../../../shared/types/remoteComputers';
import type { RelayComputer, RelayLinkLifetime, RelayPairedEvent, VouchedPairing } from '../../../../shared/types/relay';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import type { AppConfig } from '../../types/config';
import { PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
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
  route: PairingRoute;
  paired: RelayPairedEvent[];
  config(): RemoteDaemonConfig;
  /** The names of the computers this one lists in `client.computers`. */
  listed(): string[];
  seed(computers: RemoteComputer[]): void;
  link(lifetime?: RelayLinkLifetime): Promise<string>;
  preview(link: string): Promise<PaneCommandValue>;
  redeem(link: string): Promise<PaneCommandValue>;
  redeemVouched(pairing: VouchedPairing): Promise<PaneCommandValue>;
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
  /** Every command a computer received from another device, with its arguments. */
  const received: Array<{ to: string; channel: string; args: unknown[] }> = [];
  const at = (address: string) => {
    const computer = computers.get(new URL(address).hostname.split('.')[0]);
    if (!computer) throw new Error(`Nothing answers at ${address}`);
    return computer;
  };

  const post: PostToComputer = async (address, path, body, label, fingerprint) => {
    const { route, info } = at(address);
    // As the pinned TLS check does: a computer with another key never sees the request.
    if (fingerprint && fingerprint !== info.fingerprint) throw new Error(`${label} presented a key it did not pair with, so Pane did not connect.`);
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
    if (profile.relay?.fingerprint !== callee.info.fingerprint) throw new Error(`${profile.label} showed a different key.`);
    received.push({ to: callee.name, channel, args });
    const tokenHash = createHash('sha256').update(profile.token).digest('hex');
    const client = callee.config().host.clients.find((candidate) => candidate.tokenHash === tokenHash);
    if (!client) throw new RemoteRequestError('Unauthorized', 403, 'ERR_REMOTE_DAEMON_UNAUTHORIZED');
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

  function add(name: string, seed: string, report: Omit<ComputerRoutesReport, 'name' | 'relay'> = { machineId: `${seed}-install` }, options: { receiveOnly?: boolean } = {}): Computer {
    const { id, fingerprint } = relayIdentity(seed);
    const info: RelayComputer = { id, name, domain: DOMAIN, address: `https://${id}.${DOMAIN}`, local: [], fingerprint };
    let config = createDefaultRemoteDaemonConfig();
    // As a Pane Cloud VM's guest image sets it, and as RelayService then reports it.
    if (options.receiveOnly) {
      config.relay = { enabled: true, receiveOnly: true };
      info.receiveOnly = true;
    }
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
    const links: RelayLinks = new RelayLinks({ config: configManager, self: () => info, call, disconnect: () => undefined, connectedClientIds: () => new Set() });
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
        clientAddress: () => null,
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
      createPairingCode: (lifetime) => {
        const { secret, expiresAt } = exchange.createSecret(lifetime);
        return { url: `https://${DOMAIN}/pair#${new URLSearchParams({ s: secret, c: id, n: name }).toString()}`, expiresAt };
      },
    }, new RelayPreviews({ id: () => null, domain: () => null, isForwardedPort: () => false, clientActive: () => false }), links, linking, configManager);
    const computer: Computer = {
      name,
      info,
      registry,
      route,
      paired,
      config: () => config,
      listed: () => config.client.computers.map((saved) => saved.label).sort(),
      seed: (saved) => { config = { ...config, client: { ...config.client, computers: saved } }; },
      link: async (lifetime) => decodeBoundary(await registry.invoke('relay:pairing-code', lifetime ? [{ expiresIn: lifetime }] : []), boundary.object({ url: boundary.string })).url,
      preview: (link) => registry.invoke('relay:link-preview', [{ link }]),
      redeem: (link) => registry.invoke('relay:redeem-link', [{ link }]),
      redeemVouched: (pairing) => registry.invoke('relay:redeem-vouched', [{ ...pairing, relay: { ...pairing.relay } }]),
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

  /** A phone's client for one of its saved computers, through the same network. */
  const phoneClient = (profile: RelayConnectionProfile) => ({
    // SAFETY: the network answers JSON, which is what the phone's link code decodes.
    invoke: async <T,>(channel: string, args: unknown[] = []) => await call(profile, channel, args) as T,
  });

  return { add, reaches, callAs, phoneClient, received, advance: (ms: number) => { now += ms; } };
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

describe('pairing with a cloud VM from the identity Pane Cloud vouches for', () => {
  /** What the service answers for a VM: a one-time link and the identity the VM reported when first paired. */
  async function vouched(vm: Computer, identity: Pick<RelayComputer, 'id' | 'fingerprint'> = vm.info): Promise<VouchedPairing> {
    return { link: await vm.link(), relay: { computerId: identity.id, fingerprint: identity.fingerprint, domain: DOMAIN } };
  }

  it('pairs one way: the desktop reaches the VM, and the VM holds no token for the desktop', async () => {
    const net = network();
    const laptop = net.add('Laptop', 'laplaplaplaplap0');
    const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });

    const result = await laptop.redeemVouched(await vouched(vm));

    expect(result).toEqual({ computerId: laptop.config().client.computers[0].id, name: 'Cloud Session' });
    expect(await net.reaches(laptop, vm)).toBe(true);
    expect(await net.reaches(vm, laptop)).toBe(false);
    expect(vm.listed()).toEqual([]);
    expect(vm.config().host.clients).toEqual([expect.objectContaining({ kind: 'computer', computerId: laptop.info.id, label: 'Laptop' })]);
    expect(laptop.config().host.clients).toEqual([]);
  });

  it('refuses a VM that presents a key other than the vouched one, and the link stays unused', async () => {
    const net = network();
    const laptop = net.add('Laptop', 'laplaplaplaplap0');
    const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
    const pairing = await vouched(vm);
    const vouchedKey = vm.info.fingerprint;
    vm.info.fingerprint = relayIdentity('another key').fingerprint;

    await expect(laptop.redeemVouched(pairing)).rejects.toMatchObject({ message: expect.stringContaining('presented a key it did not pair with') });
    expect(laptop.listed()).toEqual([]);
    expect(vm.config().host.clients).toEqual([]);

    vm.info.fingerprint = vouchedKey;
    await expect(laptop.redeemVouched(pairing)).resolves.toMatchObject({ name: 'Cloud Session' });
  });

  it('refuses a pairing whose link names another computer than the vouched identity, without contacting either', async () => {
    const net = network();
    const laptop = net.add('Laptop', 'laplaplaplaplap0');
    const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
    const other = net.add('Other', 'othothothothoth0');

    await expect(laptop.redeemVouched(await vouched(vm, other.info))).rejects.toMatchObject({ code: 'ERR_PAIRING_KEY_MISMATCH' });
    await expect(laptop.redeemVouched(await vouched(vm, { id: vm.info.id, fingerprint: other.info.fingerprint }))).rejects.toMatchObject({ code: 'ERR_PAIRING_KEY_MISMATCH' });
    expect(laptop.listed()).toEqual([]);
    expect(vm.config().host.clients).toEqual([]);
    expect(other.config().host.clients).toEqual([]);
  });

  it('gives a phone paired by QR from the desktop a token for the VM', async () => {
    const net = network();
    const laptop = net.add('Laptop', 'laplaplaplaplap0');
    const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
    await laptop.redeemVouched(await vouched(vm));

    const secret = new URLSearchParams(new URL(await laptop.link()).hash.slice(1)).get('s') ?? '';
    const result = await laptop.route.exchange({ secret, label: 'Pixel 9', phoneId: 'phone-1', source: '192.168.1.30' });

    expect(result).toMatchObject({ ok: true, linked: [{ computer: expect.objectContaining({ id: vm.info.id }), token: expect.any(String) }] });
    expect(vm.config().host.clients).toContainEqual(expect.objectContaining({ phoneId: 'phone-1', label: 'Pixel 9', grantedBy: laptop.info.id }));
  });

  describe('a cloud VM is receive-only', () => {
    /** A phone pairs with `computer` by QR: its profile, plus a profile for each computer linked with it. */
    async function phonePairs(net: ReturnType<typeof network>, computer: Computer): Promise<RelayConnectionProfile[]> {
      const secret = new URLSearchParams(new URL(await computer.link()).hash.slice(1)).get('s') ?? '';
      const result = await computer.route.exchange({ secret, label: 'Pixel 9', phoneId: 'phone-1', source: '192.168.1.30' });
      if (!result.ok || !('linked' in result)) throw new Error('the phone did not pair');
      return [relayProfile({ computer: computer.info, token: result.token }), ...result.linked.map((grant) => relayProfile(grant, computer.name))];
    }

    it('a phone linking a new computer gives the new computer a token for the VM and never sends the VM one', async () => {
      const net = network();
      const laptop = net.add('Laptop', 'laplaplaplaplap0');
      const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
      await laptop.redeemVouched(await vouched(vm));
      const saved = await phonePairs(net, laptop);
      expect(saved.map((profile) => profile.label)).toEqual(['Laptop', 'Cloud Session']);

      const studio = net.add('Studio', 'stustustustustu0');
      const [studioProfile] = await phonePairs(net, studio);
      const before = net.received.length;
      const failed = await linkWithSavedRelayComputers(studioProfile, [], saved, net.phoneClient);

      expect(failed).toEqual([]);
      expect(await net.reaches(studio, vm)).toBe(true);
      expect(await net.reaches(studio, laptop)).toBe(true);
      expect(await net.reaches(laptop, studio)).toBe(true);
      expect(vm.config().client.computers).toEqual([]);
      const toVm = net.received.slice(before).filter((call) => call.to === 'Cloud Session');
      expect(toVm.map((call) => call.channel)).not.toContain('relay:client:save-link');
    });

    it('refuses a token a phone from before this release still sends, and saves nothing', async () => {
      const net = network();
      const laptop = net.add('Laptop', 'laplaplaplaplap0');
      const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
      await laptop.redeemVouched(await vouched(vm));
      // An older phone sends the VM a token the laptop minted for it; the VM refuses to keep it.
      await expect(net.callAs(laptop, vm, 'relay:client:save-link', { peer: { ...laptop.info }, token: 'minted-on-the-laptop' })).rejects.toMatchObject({ code: 'ERR_RELAY_RECEIVE_ONLY' });
      expect(vm.config().client.computers).toEqual([]);
    });

    it.each([
      ['another group redeems the desktop\'s link', 'theirs'],
      ['the desktop redeems another group\'s link', 'ours'],
    ])('when %s, the other group gets the VM and the VM gets nothing', async (_name, side) => {
      const net = network();
      const laptop = net.add('Laptop', 'laplaplaplaplap0');
      const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
      const windows = net.add('Windows', 'winwinwinwinwin0');
      const nas = net.add('NAS', 'nasnasnasnasnas0');
      await laptop.redeemVouched(await vouched(vm));
      await nas.redeem(await windows.link());

      if (side === 'theirs') await windows.redeem(await laptop.link());
      else await laptop.redeem(await windows.link());

      for (const from of [laptop, windows, nas]) expect(await net.reaches(from, vm), `${from.name} reaches the VM`).toBe(true);
      expect(vm.config().client.computers).toEqual([]);
      expect(net.received.filter((call) => call.to === 'Cloud Session').map((call) => call.channel)).not.toContain('relay:client:save-link');
    });

    it('refuses a link redeemed with a token offer before spending it', async () => {
      const net = network();
      const vm = net.add('Cloud Session', 'vmvmvmvmvmvmvmv0', undefined, { receiveOnly: true });
      const laptop = net.add('Laptop', 'laplaplaplaplap0');
      const link = await vm.link();

      await expect(laptop.redeem(link)).rejects.toMatchObject({ code: 'ERR_RELAY_RECEIVE_ONLY' });
      expect(vm.config().host.clients).toEqual([]);
      expect(laptop.config().host.clients).toEqual([]);
      await expect(laptop.redeemVouched({ link, relay: { computerId: vm.info.id, fingerprint: vm.info.fingerprint, domain: DOMAIN } })).resolves.toMatchObject({ name: 'Cloud Session' });
    });
  });
});
