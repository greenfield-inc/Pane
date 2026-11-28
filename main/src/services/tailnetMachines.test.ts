import { describe, expect, it } from 'vitest';
import { discoverTailnetMachines, resolveTailnetMachineUrl, savedSecretKey, tailnetLoginMatches, tailnetRelayKey, type WorkspaceCall, type WorkspaceProbe, type WorkspaceProbeResult } from './tailnetMachines';

const status = {
  BackendState: 'Running',
  MagicDNSSuffix: 'tail1.ts.net',
  CurrentTailnet: { Name: 'example.org' },
  Self: { DNSName: 'devbox.tail1.ts.net.', UserID: 1, OS: 'windows', Online: true, TailscaleIPs: ['100.64.0.1'] },
  Peer: {
    a: { DNSName: 'my-mac.tail1.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.2'] },
    b: { DNSName: 'my-old-mac.tail1.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.3'] },
    c: { DNSName: 'my-linux.tail1.ts.net.', UserID: 1, OS: 'linux', Online: false, TailscaleIPs: ['100.64.0.4'] },
    d: { DNSName: 'my-pc.tail1.ts.net.', UserID: 1, OS: 'windows', Online: true, TailscaleIPs: ['100.64.0.5'] },
    e: { DNSName: 'shared-box.tail1.ts.net.', UserID: 2, OS: 'linux', Online: true, TailscaleIPs: ['100.64.0.6'] },
    f: { DNSName: 'private-box.tail1.ts.net.', UserID: 2, OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.7'] },
    g: { DNSName: 'locked-box.tail1.ts.net.', UserID: 2, OS: 'windows', Online: true, TailscaleIPs: ['100.64.0.8'] },
    h: { DNSName: 'ci.tail1.ts.net.', UserID: 3, OS: 'linux', Online: true, Tags: ['tag:ci'], TailscaleIPs: ['100.64.0.9'] },
    i: { DNSName: 'phone.tail1.ts.net.', UserID: 1, OS: 'iOS', Online: true, TailscaleIPs: ['100.64.0.10'] },
    j: { DNSName: 'guest.other.ts.net.', UserID: 4, OS: 'linux', Online: true, ShareeNode: true, TailscaleIPs: ['100.64.0.11'] },
    k: { DNSName: 'old-shared-box.tail1.ts.net.', UserID: 2, OS: 'linux', Online: true, TailscaleIPs: ['100.64.0.12'] },
  },
  User: {
    1: { LoginName: 'me@example.org' },
    2: { LoginName: 'teammate@example.org' },
    3: { LoginName: 'ci@example.org' },
    4: { LoginName: 'guest@elsewhere.example' },
  },
};

const describedAs = (visibility: 'owner' | 'tailnet', passwordProtected = false): WorkspaceProbeResult => ({
  kind: 'described',
  description: { machineName: 'x', visibility, passwordProtected, paneVersion: '2.5.0' },
});

const answers = new Map<string, WorkspaceProbeResult>([
  ['my-mac', describedAs('owner')],
  ['my-old-mac', { kind: 'outdated' }],
  ['my-pc', { kind: 'unreachable' }],
  ['shared-box', describedAs('tailnet')],
  ['private-box', { kind: 'refused' }],
  ['locked-box', { kind: 'password-required' }],
  ['old-shared-box', { kind: 'outdated' }],
]);

function fakeProbe(seen: Array<{ name: string; ip: string; secret?: string }> = []): WorkspaceProbe {
  return async (machine, secret) => {
    seen.push({ name: machine.name, ip: machine.ip, secret });
    return answers.get(machine.name) ?? { kind: 'unreachable' };
  };
}

describe('discoverTailnetMachines', () => {
  it('lists my own machines with what each one can do, and other people\'s only when they let me in', async () => {
    const list = await discoverTailnetMachines({ readStatus: async () => JSON.stringify(status), probe: fakeProbe() });
    expect(list).toEqual({
      ok: true,
      tailnet: 'example.org',
      domain: 'tail1.ts.net',
      machines: [
        { name: 'my-mac', dnsName: 'my-mac.tail1.ts.net', url: 'https://my-mac.tail1.ts.net:8443', os: 'macOS', ownerLogin: 'me@example.org', mine: true, state: 'available', visibility: 'owner', paneVersion: '2.5.0' },
        { name: 'my-old-mac', dnsName: 'my-old-mac.tail1.ts.net', url: 'https://my-old-mac.tail1.ts.net:8443', os: 'macOS', ownerLogin: 'me@example.org', mine: true, state: 'outdated' },
        { name: 'my-pc', dnsName: 'my-pc.tail1.ts.net', url: 'https://my-pc.tail1.ts.net:8443', os: 'Windows', ownerLogin: 'me@example.org', mine: true, state: 'unreachable' },
        { name: 'my-linux', dnsName: 'my-linux.tail1.ts.net', url: 'https://my-linux.tail1.ts.net:8443', os: 'Linux', ownerLogin: 'me@example.org', mine: true, state: 'offline' },
        { name: 'shared-box', dnsName: 'shared-box.tail1.ts.net', url: 'https://shared-box.tail1.ts.net:8443', os: 'Linux', ownerLogin: 'teammate@example.org', mine: false, state: 'available', visibility: 'tailnet', paneVersion: '2.5.0' },
        { name: 'locked-box', dnsName: 'locked-box.tail1.ts.net', url: 'https://locked-box.tail1.ts.net:8443', os: 'Windows', ownerLogin: 'teammate@example.org', mine: false, state: 'password-required' },
      ],
    });
  });

  it('lists other people\'s machines that keep me out as refused when asked to, so the app can say why', async () => {
    const list = await discoverTailnetMachines({ readStatus: async () => JSON.stringify(status), probe: fakeProbe(), includeRefused: true });
    if (!list.ok) throw new Error('expected machines');
    expect(list.machines.filter(machine => !machine.mine).map(machine => [machine.name, machine.state])).toEqual([
      ['shared-box', 'available'],
      ['locked-box', 'password-required'],
      // An older Pane accepts only its owner's login.
      ['old-shared-box', 'refused'],
      ['private-box', 'refused'],
    ]);
  });

  it('lists the computer it runs on first when asked on behalf of a phone', async () => {
    const list = await discoverTailnetMachines({
      readStatus: async () => JSON.stringify(status),
      probe: fakeProbe(),
      self: { url: 'https://devbox.tail1.ts.net:8444', description: { machineName: 'devbox', visibility: 'owner', passwordProtected: false, paneVersion: '2.5.0' } },
    });
    expect(list.ok && list.machines[0]).toEqual({
      name: 'devbox', dnsName: 'devbox.tail1.ts.net', url: 'https://devbox.tail1.ts.net:8444', os: 'Windows', ownerLogin: 'me@example.org', mine: true, state: 'available', visibility: 'owner', paneVersion: '2.5.0',
    });
  });

  it('never probes tagged devices, phones, offline machines, or devices outside this tailnet', async () => {
    const seen: Array<{ name: string; ip: string }> = [];
    await discoverTailnetMachines({ readStatus: async () => JSON.stringify(status), probe: fakeProbe(seen) });
    expect(seen.map(probe => probe.name).sort()).toEqual(['locked-box', 'my-mac', 'my-old-mac', 'my-pc', 'old-shared-box', 'private-box', 'shared-box']);
    expect(seen.find(probe => probe.name === 'my-mac')?.ip).toBe('100.64.0.2');
  });

  it('sends the saved password for a machine when it has one', async () => {
    const seen: Array<{ name: string; ip: string; secret?: string }> = [];
    await discoverTailnetMachines({
      readStatus: async () => JSON.stringify(status),
      probe: fakeProbe(seen),
      savedSecrets: new Map([[savedSecretKey('tail1.ts.net', 'locked-box'), 'correct horse']]),
    });
    expect(seen.find(probe => probe.name === 'locked-box')?.secret).toBe('correct horse');
    expect(seen.find(probe => probe.name === 'my-mac')?.secret).toBeUndefined();
  });

  it('never sends a password saved on one tailnet to a machine with the same name on another', async () => {
    const seen: Array<{ name: string; ip: string; secret?: string }> = [];
    const otherTailnet = {
      ...status,
      MagicDNSSuffix: 'tail9.ts.net',
      Peer: { g: { ...status.Peer.g, DNSName: 'locked-box.tail9.ts.net.' } },
    };
    await discoverTailnetMachines({
      readStatus: async () => JSON.stringify(otherTailnet),
      probe: fakeProbe(seen),
      savedSecrets: new Map([[savedSecretKey('tail1.ts.net', 'locked-box'), 'correct horse']]),
    });
    expect(seen).toEqual([{ name: 'locked-box', ip: '100.64.0.8', secret: undefined }]);
  });

  it('follows the current tailnet, so machines from a previous one are gone', async () => {
    const switched = {
      ...status,
      MagicDNSSuffix: 'tail2.ts.net',
      CurrentTailnet: { Name: 'me.github' },
      Self: { ...status.Self, DNSName: 'devbox.tail2.ts.net.' },
      Peer: { a: { DNSName: 'my-mac.tail2.ts.net.', UserID: 1, OS: 'macOS', Online: true, TailscaleIPs: ['100.70.0.2'] } },
    };
    const list = await discoverTailnetMachines({ readStatus: async () => JSON.stringify(switched), probe: fakeProbe() });
    expect(list).toMatchObject({ ok: true, tailnet: 'me.github', machines: [{ name: 'my-mac', dnsName: 'my-mac.tail2.ts.net' }] });
  });

  it('says what to do when Tailscale is missing or signed out', async () => {
    await expect(discoverTailnetMachines({ readStatus: async () => null, probe: fakeProbe() }))
      .resolves.toMatchObject({ ok: false, reason: 'Tailscale is not installed', fix: expect.stringContaining('tailscale.com/download') });
    await expect(discoverTailnetMachines({ readStatus: async () => JSON.stringify({ BackendState: 'NeedsLogin' }), probe: fakeProbe() }))
      .resolves.toMatchObject({ ok: false, reason: 'Tailscale is signed out' });
  });
});

describe('resolveTailnetMachineUrl', () => {
  it('finds a saved machine on the tailnet it was saved on', async () => {
    await expect(resolveTailnetMachineUrl({ name: 'my-mac', domain: 'tail1.ts.net' }, async () => JSON.stringify(status)))
      .resolves.toBe('https://my-mac.tail1.ts.net:8443');
  });

  it('refuses to follow a name onto another tailnet, where it is a different machine', async () => {
    const switched = { ...status, MagicDNSSuffix: 'tail2.ts.net', CurrentTailnet: { Name: 'me.github' }, Peer: { a: { ...status.Peer.a, DNSName: 'my-mac.tail2.ts.net.' } } };
    await expect(resolveTailnetMachineUrl({ name: 'my-mac', domain: 'tail1.ts.net' }, async () => JSON.stringify(switched)))
      .rejects.toThrow('my-mac was saved on another tailnet (tail1.ts.net). This computer is now on me.github; connect again from Settings › Remote Access › Computers.');
  });

  it('says so when the machine is not on its tailnet any more', async () => {
    await expect(resolveTailnetMachineUrl({ name: 'gone', domain: 'tail1.ts.net' }, async () => JSON.stringify(status)))
      .rejects.toThrow('gone is not on your current tailnet (example.org).');
  });
});

describe('tailnetLoginMatches', () => {
  const read = (value: typeof status | null) => async () => (value === null ? null : JSON.stringify(value));

  it('is true for a machine whose Tailscale owner is this computer\'s login, including one offline now', async () => {
    expect(await tailnetLoginMatches({ name: 'my-mac', domain: 'tail1.ts.net' }, read(status))).toBe(true);
    expect(await tailnetLoginMatches({ name: 'MY-LINUX', domain: 'TAIL1.ts.net' }, read(status))).toBe(true);
  });

  it('is false for another login\'s machine, a tagged one, a missing one, or one saved on another tailnet', async () => {
    expect(await tailnetLoginMatches({ name: 'shared-box', domain: 'tail1.ts.net' }, read(status))).toBe(false);
    expect(await tailnetLoginMatches({ name: 'ci', domain: 'tail1.ts.net' }, read(status))).toBe(false);
    expect(await tailnetLoginMatches({ name: 'gone', domain: 'tail1.ts.net' }, read(status))).toBe(false);
    expect(await tailnetLoginMatches({ name: 'my-mac', domain: 'tail2.ts.net' }, read(status))).toBe(false);
  });

  it('cannot say when Tailscale is missing, signed out or unreadable', async () => {
    expect(await tailnetLoginMatches({ name: 'my-mac', domain: 'tail1.ts.net' }, read(null))).toBeUndefined();
    expect(await tailnetLoginMatches({ name: 'my-mac', domain: 'tail1.ts.net' }, read({ ...status, BackendState: 'NeedsLogin' }))).toBeUndefined();
    expect(await tailnetLoginMatches({ name: 'my-mac', domain: 'tail1.ts.net' }, async () => '{not json')).toBeUndefined();
  });
});

describe('tailnetRelayKey', () => {
  const read = async () => JSON.stringify(status);
  const report = { machineId: 'mac-install', name: 'my-mac', relay: { id: 'mac-relay', address: 'https://mac-relay.runpane.net', fingerprint: 'fp-mac', local: [] } };

  it('reads the relay key from the machine its Tailscale name reaches, sending the route\'s secret', async () => {
    const calls: Array<{ ip: string; channel: string; secret?: string }> = [];
    const call: WorkspaceCall = async (machine, channel, _args, secret) => { calls.push({ ip: machine.ip, channel, secret }); return { kind: 'answered', statusCode: 200, ok: true, result: report }; };
    expect(await tailnetRelayKey({ name: 'my-mac', domain: 'tail1.ts.net' }, 'token-mac', read, call)).toEqual({ computerId: 'mac-relay', fingerprint: 'fp-mac' });
    expect(calls).toEqual([{ ip: '100.64.0.2', channel: 'computers:routes-report', secret: 'token-mac' }]);
  });

  it('is null for a machine with no relay key, and undefined when it can\'t be reached or is on another tailnet', async () => {
    const { relay: _relay, ...withoutRelay } = report;
    const noRelay: WorkspaceCall = async () => ({ kind: 'answered', statusCode: 200, ok: true, result: withoutRelay });
    expect(await tailnetRelayKey({ name: 'my-mac', domain: 'tail1.ts.net' }, '', read, noRelay)).toBeNull();
    expect(await tailnetRelayKey({ name: 'my-mac', domain: 'tail1.ts.net' }, '', read, async () => ({ kind: 'unreachable', detail: 'timeout' }))).toBeUndefined();
    expect(await tailnetRelayKey({ name: 'my-mac', domain: 'tail1.ts.net' }, '', read, async () => ({ kind: 'answered', statusCode: 200, ok: true, result: 'garbage' }))).toBeUndefined();
    expect(await tailnetRelayKey({ name: 'my-mac', domain: 'tail2.ts.net' }, '', read, noRelay)).toBeUndefined();
    expect(await tailnetRelayKey({ name: 'gone', domain: 'tail1.ts.net' }, '', read, noRelay)).toBeUndefined();
  });
});
