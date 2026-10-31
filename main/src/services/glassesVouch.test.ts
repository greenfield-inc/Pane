import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../types/config';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PaneWorkspaceHostController } from '../daemon/workspaceHost';
import { registerWorkspaceCommands } from '../ipc/workspace';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { decodeGlassesPairingCode, GLASSES_COMMANDS, type GlassesVouchResult } from '../../../shared/types/glasses';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { WorkspaceCall, WorkspaceProbe, WorkspaceProbeResult } from './tailnetMachines';
import { revokeGlassesEverywhere } from './glassesVouch';

const PHONE = 'pane-native-phone-a';
const GLASSES = 'Even G2 · Parsa\'s iPhone';
const hosts: PaneWorkspaceHostController[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});

/** One computer running this Pane, with Tailscale absent so the host touches nothing on this machine. */
function computer(name: string, config: Partial<AppConfig> = {}) {
  let current: Partial<AppConfig> = { remoteDaemon: createDefaultRemoteDaemonConfig(), workspaces: {}, ...config };
  const configManager = {
    getConfig: () => current,
    on: () => ({}),
    off: () => ({}),
    updateConfigWith: async (update: (value: AppConfig) => Partial<AppConfig>) => {
      // SAFETY: these commands read and write only remoteDaemon and workspaces.
      current = { ...current, ...update(current as AppConfig) };
      return current;
    },
  };
  const host = new PaneWorkspaceHostController(new PaneCommandRegistry(), configManager, true, async () => ({ ok: false, stdout: '', stderr: '' }));
  hosts.push(host);
  return { name, host, registry: new PaneCommandRegistry(), configManager };
}

type Computer = ReturnType<typeof computer>;

/** `tailscale status --json` for "studio-mac": its own peers and someone else's computer. */
function tailscaleStatus(peers: { name: string; userId?: number; online?: boolean }[]): string {
  return JSON.stringify({
    BackendState: 'Running',
    MagicDNSSuffix: 'tail1.ts.net',
    Self: { DNSName: 'studio-mac.tail1.ts.net.', UserID: 1, OS: 'macOS' },
    Peer: Object.fromEntries(peers.map((peer, index) => [`p${index}`, {
      DNSName: `${peer.name}.tail1.ts.net.`, UserID: peer.userId ?? 1, OS: 'linux', Online: peer.online ?? true, TailscaleIPs: [`100.64.0.${index + 2}`],
    }])),
    User: { 1: { LoginName: 'me@example.com' }, 2: { LoginName: 'teammate@example.com' } },
  });
}

/**
 * The vouching computer "studio-mac" with the glasses paired from the phone, and its siblings
 * behind the HTTP seam: each sibling is a real Pane's commands, reached as the owner.
 */
async function setup(options: {
  siblings: Computer[];
  peers?: { name: string; userId?: number; online?: boolean }[];
  probe?: Record<string, WorkspaceProbeResult>;
  answer?: Record<string, WorkspaceCall>;
  config?: Partial<AppConfig>;
}) {
  const asked: { machine: string; channel: string; args: JsonValue[]; secret?: string }[] = [];
  const probed: { machine: string; secret?: string }[] = [];
  const siblings = new Map(options.siblings.map((sibling) => {
    registerWorkspaceCommands(sibling.registry, sibling.host, sibling.configManager, '2.4.211');
    return [`${sibling.name}.tail1.ts.net`, sibling];
  }));
  const probe: WorkspaceProbe = async (machine, secret) => {
    probed.push({ machine: machine.name, secret });
    return options.probe?.[machine.name]
      ?? (siblings.has(machine.dnsName) ? { kind: 'described', description: { machineName: machine.name, visibility: 'owner', passwordProtected: false, paneVersion: '2.4.211' } } : { kind: 'unreachable' });
  };
  const call: WorkspaceCall = async (machine, channel, args, secret) => {
    asked.push({ machine: machine.name, channel, args, secret });
    const override = options.answer?.[machine.name];
    if (override) return override(machine, channel, args, secret);
    const sibling = siblings.get(machine.dnsName);
    if (!sibling) return { kind: 'unreachable', detail: 'no Pane' };
    try {
      const result = decodeBoundary(JSON.parse(JSON.stringify(await sibling.registry.invokeRemote(channel, args) ?? null)), boundary.json);
      return { kind: 'answered', statusCode: 200, ok: true, result };
    } catch (error) {
      const code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
      return { kind: 'answered', statusCode: 500, ok: false, code };
    }
  };

  const vouching = computer('studio-mac', options.config);
  const peers = options.peers ?? options.siblings.map((sibling) => ({ name: sibling.name }));
  const discovery = { readStatus: async () => tailscaleStatus(peers), probe, call };
  registerWorkspaceCommands(vouching.registry, vouching.host, vouching.configManager, '2.4.211', discovery);
  const paired = await pairFromPhone(vouching);
  const vouch = async (request: PaneCommandValue = { deviceId: paired.device.id }): Promise<GlassesVouchResult> => {
    // SAFETY: the vouch command answers a GlassesVouchResult.
    return await vouching.registry.invokeRemote(GLASSES_COMMANDS.vouch, [request]) as GlassesVouchResult;
  };
  return { vouching, paired, vouch, asked, probed, discovery };
}

/** What the phone does: mint a secret on the computer as the owner, then the glasses trade it. */
async function pairFromPhone(target: Computer, phoneId = PHONE) {
  const { secret } = target.host.glasses.createPairingSecret(GLASSES, phoneId);
  const paired = await target.host.glasses.pair(secret);
  if (!paired) throw new Error('pairing failed');
  return paired;
}

async function tradeEach(result: GlassesVouchResult, computers: Computer[]) {
  if (!result.code) return [];
  const code = decodeGlassesPairingCode(result.code);
  return Promise.all(code.computers.map(async (entry) => {
    const target = computers.find((candidate) => candidate.name === entry.name);
    return { name: entry.name, url: entry.url, device: (await target?.host.glasses.pair(entry.secret))?.device };
  }));
}

describe('a paired computer vouching for its siblings', () => {
  it('adds the same glasses, under the name and phone id the phone gave them, to each of your computers that lacks them', async () => {
    const devbox = computer('devbox');
    const laptop = computer('laptop');
    const { vouch } = await setup({ siblings: [devbox, laptop] });

    const result = await vouch();
    expect(result.skipped).toEqual([]);
    const traded = await tradeEach(result, [devbox, laptop]);
    expect(traded).toEqual([
      { name: 'devbox', url: 'https://devbox.tail1.ts.net:8443', device: expect.objectContaining({ label: GLASSES, phoneId: PHONE }) },
      { name: 'laptop', url: 'https://laptop.tail1.ts.net:8443', device: expect.objectContaining({ label: GLASSES, phoneId: PHONE }) },
    ]);
  });

  it('takes the glasses only from the token\'s own record and the computers only from discovery', async () => {
    const devbox = computer('devbox');
    const { vouching, paired, vouch, asked } = await setup({
      siblings: [devbox],
      peers: [{ name: 'devbox' }, { name: 'teammate-box', userId: 2 }],
    });
    await pairFromPhone(vouching, 'pane-native-phone-b');

    // The transport sends only the device id; a body carrying more changes nothing.
    const result = await vouch({ deviceId: paired.device.id, deviceName: 'Evil', phoneId: 'pane-native-phone-b', computers: ['https://attacker.tail1.ts.net:8443'] });
    expect((await tradeEach(result, [devbox]))[0].device).toMatchObject({ label: GLASSES, phoneId: PHONE });
    // Someone else's computer on the tailnet is never asked.
    expect(new Set(asked.map((call) => call.machine))).toEqual(new Set(['devbox']));
    await expect(vouch({ deviceId: 'glasses-unknown' })).rejects.toMatchObject({ code: 'ERR_GLASSES_VOUCH_NOT_PAIRED' });
  });

  it('leaves out a computer that already holds the glasses, without asking it for a secret', async () => {
    const devbox = computer('devbox');
    await pairFromPhone(devbox);
    const { vouch, asked } = await setup({ siblings: [devbox] });

    expect(await vouch()).toEqual({ code: null, expiresAt: null, skipped: [] });
    expect(asked.map((call) => call.channel)).toEqual([GLASSES_COMMANDS.list]);
  });

  it('keeps a revoke: a computer that revoked the glasses is never asked for a secret until the phone pairs them there again', async () => {
    const devbox = computer('devbox');
    const first = await pairFromPhone(devbox);
    await devbox.host.glasses.revoke(first.device.id);
    const { vouch, asked } = await setup({ siblings: [devbox] });

    expect(await vouch()).toEqual({ code: null, expiresAt: null, skipped: [{ name: 'devbox', reason: 'revoked here · pair from phone' }] });
    expect(asked.map((call) => call.channel)).toEqual([GLASSES_COMMANDS.list]);
    expect(devbox.host.glasses.list()).toEqual([]);

    // Pairing from the phone lifts the revoke.
    await pairFromPhone(devbox);
    expect(devbox.host.glasses.revokedPhoneIds()).toEqual([]);
  });

  it('refuses a vouched mint for glasses revoked between the list and the mint', async () => {
    const devbox = computer('devbox');
    const { vouch } = await setup({
      siblings: [devbox],
      answer: {
        devbox: async (_machine, channel, args) => {
          if (channel === GLASSES_COMMANDS.list) return { kind: 'answered', statusCode: 200, ok: true, result: { devices: [], revokedPhoneIds: [] } };
          const old = await pairFromPhone(devbox);
          await devbox.host.glasses.revoke(old.device.id);
          try {
            await devbox.registry.invokeRemote(channel, args);
            return { kind: 'answered', statusCode: 200, ok: true, result: null };
          } catch (error) {
            return { kind: 'answered', statusCode: 500, ok: false, code: decodeBoundary(error, boundary.object({ code: boundary.string })).code };
          }
        },
      },
    });
    expect((await vouch()).skipped).toEqual([{ name: 'devbox', reason: 'revoked here · pair from phone' }]);
  });

  it('says why each computer it could not add was left out', async () => {
    const funnel = computer('funnel-box');
    funnel.host.glasses.setFunnelOn(true);
    const { vouch, asked } = await setup({
      siblings: [funnel],
      peers: [{ name: 'funnel-box' }, { name: 'old-pane' }, { name: 'old-marker' }, { name: 'locked' }, { name: 'quiet' }, { name: 'asleep', online: false }],
      probe: { 'old-pane': { kind: 'outdated' }, locked: { kind: 'password-required' }, quiet: { kind: 'unreachable' }, 'old-marker': { kind: 'described', description: { machineName: 'old-marker', visibility: 'owner', passwordProtected: false, paneVersion: '2.4.210' } } },
      // 2.4.210 lists glasses without revoke markers.
      answer: { 'old-marker': async () => ({ kind: 'answered', statusCode: 200, ok: true, result: { devices: [] } }) },
    });

    expect(await vouch()).toEqual({
      code: null,
      expiresAt: null,
      skipped: [
        { name: 'asleep', reason: 'not answering' },
        { name: 'funnel-box', reason: 'Funnel is on' },
        { name: 'locked', reason: 'needs its password' },
        { name: 'old-marker', reason: 'update Pane there' },
        { name: 'old-pane', reason: 'update Pane there' },
        { name: 'quiet', reason: 'not answering' },
      ],
    });
    expect(asked.filter((call) => call.channel === GLASSES_COMMANDS.createPairingSecret)).toEqual([]);
  });

  it('reaches a password-protected computer with the password saved on this one, and only on its own tailnet', async () => {
    const devbox = computer('devbox');
    const profile = (domain: string, token: string) => ({
      id: `tailnet-${domain}-devbox`, label: 'devbox', baseUrl: 'https://devbox.tail1.ts.net:8443', token, transport: 'http+sse' as const, tailnetMachine: 'devbox', tailnetDomain: domain,
    });
    const remoteDaemon = createDefaultRemoteDaemonConfig();
    remoteDaemon.client.profiles = [profile('other.ts.net', 'wrong-tailnet'), profile('tail1.ts.net', 'saved password')];
    const { vouch, asked, probed } = await setup({ siblings: [devbox], config: { remoteDaemon } });

    expect((await vouch()).code).not.toBeNull();
    expect(probed).toEqual([{ machine: 'devbox', secret: 'saved password' }]);
    expect(asked.map((call) => call.secret)).toEqual(['saved password', 'saved password']);
  });
});

describe('revoking on all my computers from the desktop', () => {
  async function revokeEverywhere(context: Awaited<ReturnType<typeof setup>>) {
    return revokeGlassesEverywhere(PHONE, {
      name: 'studio-mac',
      invoke: (channel, args) => context.vouching.registry.invoke(channel, args),
    }, { ...context.discovery, savedSecrets: new Map() });
  }

  it('revokes these glasses here and on each computer that answers, keeps them off there, and names the ones it did not reach', async () => {
    const devbox = computer('devbox');
    await pairFromPhone(devbox);
    const otherPhone = await pairFromPhone(devbox, 'pane-native-phone-b');
    const context = await setup({ siblings: [devbox], peers: [{ name: 'devbox' }, { name: 'laptop', online: false }] });

    expect(await revokeEverywhere(context)).toEqual({ revoked: ['studio-mac', 'devbox'], notReached: [{ name: 'laptop', reason: 'offline' }] });
    expect(context.vouching.host.glasses.list()).toEqual([]);
    expect(context.vouching.host.glasses.revokedPhoneIds()).toEqual([PHONE]);
    // Only these glasses: another phone's stay paired.
    expect(devbox.host.glasses.list()).toEqual([otherPhone.device]);
    expect(devbox.host.glasses.revokedPhoneIds()).toEqual([PHONE]);
    // The marker keeps them off: a later vouch from any computer skips devbox.
    expect(() => devbox.host.glasses.createPairingSecret(GLASSES, PHONE, { unlessRevoked: true })).toThrow(expect.objectContaining({ code: 'ERR_GLASSES_REVOKED_HERE' }));
  });

  it('asks only your own computers from discovery, and counts one as revoked only when it held these glasses', async () => {
    const devbox = computer('devbox');
    const teammate = computer('teammate-box');
    await pairFromPhone(teammate);
    const context = await setup({ siblings: [devbox, teammate], peers: [{ name: 'devbox' }, { name: 'teammate-box', userId: 2 }] });

    // devbox answers but never held these glasses, so it gets no revoke marker and is not named.
    expect(await revokeEverywhere(context)).toEqual({ revoked: ['studio-mac'], notReached: [] });
    expect(devbox.host.glasses.revokedPhoneIds()).toEqual([]);
    expect(new Set(context.asked.map((call) => call.machine))).toEqual(new Set(['devbox']));
    expect(teammate.host.glasses.list()).toHaveLength(1);
  });

  it('says why each computer was not reached, and leaves out one whose Pane predates glasses', async () => {
    const context = await setup({
      siblings: [],
      peers: [{ name: 'locked' }, { name: 'old-pane' }, { name: 'quiet' }, { name: 'stalls' }],
      probe: {
        locked: { kind: 'password-required' },
        'old-pane': { kind: 'outdated' },
        quiet: { kind: 'unreachable' },
        stalls: { kind: 'described', description: { machineName: 'stalls', visibility: 'owner', passwordProtected: false, paneVersion: '2.4.211' } },
      },
      answer: { stalls: async () => ({ kind: 'unreachable', detail: 'timed out' }) },
    });

    expect(await revokeEverywhere(context)).toEqual({
      revoked: ['studio-mac'],
      notReached: [
        { name: 'locked', reason: 'needs its password' },
        { name: 'quiet', reason: 'not answering' },
        { name: 'stalls', reason: 'not answering' },
      ],
    });
  });
});
