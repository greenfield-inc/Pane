import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigManager } from './configManager';
import { applyRoutesReport, decodeComputers, isOwnComputer, routesReachableHere, upsertComputer, type RemoteComputer } from '../../../shared/types/remoteComputers';

// Saved by v2.4.225: the same Mac once through Tailscale and once through the relay, plus a code host.
const tailnetMac = {
  id: 'tailnet-tail1234.ts.net-studio-mac',
  label: 'studio-mac',
  baseUrl: 'https://studio-mac.tail1234.ts.net:8443',
  token: '',
  transport: 'http+sse',
  tailnetMachine: 'studio-mac',
  tailnetDomain: 'tail1234.ts.net',
};
const relayMac = {
  id: 'relay-k7xq2m4n8p3r5t6v',
  label: 'Studio-Mac',
  baseUrl: 'https://k7xq2m4n8p3r5t6v.runpane.net',
  token: 'link-token-mac',
  transport: 'http+sse',
  relay: { computerId: 'k7xq2m4n8p3r5t6v', fingerprint: 'fp-mac', linkedBy: 'iPhone' },
};
const codeHost = {
  id: 'remote-1',
  label: 'build-box',
  baseUrl: 'https://build.example.com',
  token: 'code-token',
  transport: 'http+sse',
  tunnel: { kind: 'manual', selected: true },
};

describe('computers (D-51)', () => {
  let paneDir: string;
  let configPath: string;

  beforeEach(async () => {
    paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-computers-'));
    vi.stubEnv('PANE_DIR', paneDir);
    configPath = path.join(paneDir, 'config.json');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(paneDir, { recursive: true, force: true });
  });

  it('converts a v2.4.225 config to one computer per machine and leaves the old entries for a downgrade', async () => {
    const saved = { machineId: 'this-mac', remoteDaemon: { client: { profiles: [tailnetMac, relayMac, codeHost], activeProfileId: tailnetMac.id, mode: 'remote' } } };
    await fs.writeFile(configPath, JSON.stringify(saved));

    const manager = new ConfigManager();
    await manager.initialize();

    const client = manager.getConfig().remoteDaemon!.client;
    expect(client.computers.map((computer) => ({ id: computer.id, label: computer.label, routes: computer.routes.map((route) => route.kind) }))).toEqual([
      { id: tailnetMac.id, label: 'Studio-Mac', routes: ['tailscale', 'relay'] },
      { id: 'remote-1', label: 'build-box', routes: ['public'] },
    ]);
    expect(client.computers[0].linkedBy).toBe('iPhone');
    expect(client).toMatchObject({ activeProfileId: tailnetMac.id, mode: 'remote' });

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(onDisk.remoteDaemon.client.profiles).toEqual([tailnetMac, relayMac, codeHost]);
    expect(onDisk.remoteDaemon.client.computers).toHaveLength(2);
  });

  it('keeps the relay entry\'s id when it was the active one', async () => {
    await fs.writeFile(configPath, JSON.stringify({ remoteDaemon: { client: { profiles: [tailnetMac, relayMac], activeProfileId: relayMac.id, mode: 'remote' } } }));
    const manager = new ConfigManager();
    await manager.initialize();
    const client = manager.getConfig().remoteDaemon!.client;
    expect(client.computers.map((computer) => computer.id)).toEqual([relayMac.id]);
    expect(client.activeProfileId).toBe(relayMac.id);
  });

  it('keeps two relay computers with the same name as two computers', async () => {
    const twin = { ...relayMac, id: 'relay-aaaabbbbccccdddd', baseUrl: 'https://aaaabbbbccccdddd.runpane.net', relay: { computerId: 'aaaabbbbccccdddd', fingerprint: 'fp-2' } };
    await fs.writeFile(configPath, JSON.stringify({ remoteDaemon: { client: { profiles: [relayMac, twin], activeProfileId: null, mode: 'local' } } }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().remoteDaemon!.client.computers).toHaveLength(2);
  });

  it('reads saved computers as they are, without converting again', async () => {
    const computers: RemoteComputer[] = [{ id: 'c1', label: 'devbox', machineId: 'm1', routes: [{ id: 'relay:https://x.runpane.net', kind: 'relay', source: 'link', baseUrl: 'https://x.runpane.net', token: 't', relay: { computerId: 'x', fingerprint: 'f' } }] }];
    await fs.writeFile(configPath, JSON.stringify({ remoteDaemon: { client: { computers, profiles: [tailnetMac], activeProfileId: 'c1', mode: 'remote' } } }));
    const manager = new ConfigManager();
    await manager.initialize();
    expect(manager.getConfig().remoteDaemon!.client.computers).toEqual(computers);
    expect(manager.getConfig().remoteDaemon!.client.activeProfileId).toBe('c1');
  });
});

describe('reading saved computers', () => {
  it('drops only a route or OS it can\'t read, keeps the computer and its link, and says what it dropped', () => {
    const link = { id: 'relay:https://x.runpane.net', kind: 'relay', source: 'link', baseUrl: 'https://x.runpane.net', token: 't', relay: { computerId: 'x', fingerprint: 'f' } };
    const lines: string[] = [];
    const computers = decodeComputers([
      { id: 'c1', label: 'devbox', os: 'Plan 9', routes: [{ id: 'mesh:a', kind: 'mesh', source: 'found', baseUrl: 'https://a', token: 't' }, link] },
      { id: 'c2', label: 'nas', routes: [{ id: 'mesh:b', kind: 'mesh', source: 'found', baseUrl: 'https://b', token: 't' }] },
    ], (line) => lines.push(line));
    expect(computers).toEqual([{ id: 'c1', label: 'devbox', routes: [link] }]);
    expect(lines).toEqual([
      expect.stringContaining('devbox: dropped a route'),
      expect.stringContaining('nas: dropped a route'),
      expect.stringContaining('dropped nas: none of its routes'),
    ]);
  });
});

describe('which saved computers are yours (D-500)', () => {
  const link = { id: 'relay:https://x.runpane.net', kind: 'relay', source: 'link', baseUrl: 'https://x.runpane.net', token: 't', relay: { computerId: 'x', fingerprint: 'f' } };

  it('keeps the Tailscale mark and the switch, and drops a value it can\'t read without dropping the computer', () => {
    expect(decodeComputers([
      { id: 'a', label: 'a', mine: 'tailscale', mineRelay: { computerId: 'x', fingerprint: 'f' }, mineOverride: false, routes: [link] },
      { id: 'b', label: 'b', mine: 'someday', mineRelay: { computerId: 'x', fingerprint: 'f' }, mineOverride: 'yes', routes: [link] },
      { id: 'c', label: 'c', mine: 'tailscale', mineRelay: 'x', routes: [link] },
    ], () => undefined)).toEqual([
      { id: 'a', label: 'a', mine: 'tailscale', mineRelay: { computerId: 'x', fingerprint: 'f' }, mineOverride: false, routes: [link] },
      { id: 'b', label: 'b', routes: [link] },
      { id: 'c', label: 'c', mine: 'tailscale', routes: [link] },
    ]);
  });

  it('is yours by the switch when set, else by the Tailscale mark, and never when only watched', () => {
    const routes = decodeComputers([{ id: 'a', label: 'a', routes: [link] }])[0].routes;
    expect(isOwnComputer({ routes, mine: 'tailscale' })).toBe(true);
    expect(isOwnComputer({ routes })).toBe(false);
    expect(isOwnComputer({ routes, mineOverride: true })).toBe(true);
    expect(isOwnComputer({ routes, mine: 'tailscale', mineOverride: false })).toBe(false);
    expect(isOwnComputer({ routes: [{ ...routes[0], token: 'pane_read_x' }], mine: 'tailscale', mineOverride: true })).toBe(false);
  });

  it('keeps the mark and the switch when a computer reports its routes', () => {
    const relayRoute = { id: 'relay:https://k.runpane.net', kind: 'relay' as const, source: 'link' as const, baseUrl: 'https://k.runpane.net', token: 'tok', relay: { computerId: 'k', fingerprint: 'fp' } };
    const saved: RemoteComputer = { id: 'k', label: 'k', machineId: 'k-install', mine: 'tailscale', mineOverride: true, routes: [relayRoute] };
    const { computers } = applyRoutesReport([saved], 'k', relayRoute, { machineId: 'k-install', name: 'k', relay: { id: 'k', address: 'https://k.runpane.net', fingerprint: 'fp', local: [] } });
    expect(computers[0]).toMatchObject({ mine: 'tailscale', mineOverride: true });
  });
});

describe('merging computers', () => {
  const relayRoute = { id: 'relay:https://k7xq2m4n8p3r5t6v.runpane.net', kind: 'relay' as const, source: 'link' as const, baseUrl: 'https://k7xq2m4n8p3r5t6v.runpane.net', token: 'tok', relay: { computerId: 'k7xq2m4n8p3r5t6v', fingerprint: 'fp' } };
  const devbox: RemoteComputer = { id: 'relay-k7xq2m4n8p3r5t6v', label: 'devbox', machineId: 'devbox-install', routes: [relayRoute] };

  it('never merges a Tailscale machine into a computer with a different install id, whatever its name', () => {
    const { computers } = upsertComputer([devbox], {
      machineId: 'other-install',
      tailnetName: 'devbox',
      label: 'devbox',
      routes: [{ id: 'tailscale:https://devbox.t.ts.net:8443', kind: 'tailscale', source: 'found', baseUrl: 'https://devbox.t.ts.net:8443', token: '' }],
    });
    expect(computers).toHaveLength(2);
  });

  it('puts a Tailscale machine with no known id on the computer of the same name, nearest route first', () => {
    const { computers, id } = upsertComputer([devbox], {
      tailnetName: 'Devbox',
      label: 'devbox',
      routes: [{ id: 'tailscale:https://devbox.t.ts.net:8443', kind: 'tailscale', source: 'found', baseUrl: 'https://devbox.t.ts.net:8443', token: '' }],
    });
    expect(id).toBe(devbox.id);
    expect(computers[0].routes.map((route) => route.kind)).toEqual(['tailscale', 'relay']);
  });

  it('saves the routes a computer reports, all with the credential it was reached with', () => {
    const { computers } = applyRoutesReport([devbox], devbox.id, relayRoute, {
      machineId: 'devbox-install',
      name: 'devbox',
      os: 'Windows',
      relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: ['https://l192-168-1-20.k7xq2m4n8p3r5t6v.runpane.net:42138'] },
      tailnet: { dnsName: 'devbox.tail1234.ts.net.', machine: 'devbox', domain: 'tail1234.ts.net', port: 8443 },
    });
    expect(computers[0].os).toBe('Windows');
    expect(computers[0].routes.map((route) => [route.kind, route.baseUrl, route.token, route.source])).toEqual([
      ['lan', 'https://l192-168-1-20.k7xq2m4n8p3r5t6v.runpane.net:42138', 'tok', 'found'],
      ['tailscale', 'https://devbox.tail1234.ts.net:8443', 'tok', 'found'],
      ['relay', 'https://k7xq2m4n8p3r5t6v.runpane.net', 'tok', 'link'],
    ]);
  });

  it('refuses a Tailscale route a computer reports under a name another saved computer already has (review MF-1)', () => {
    const studio: RemoteComputer = { id: 'studio', label: 'studio', routes: [{ id: 'tailscale:https://studio.tail1.ts.net:8443', kind: 'tailscale', source: 'found', baseUrl: 'https://studio.tail1.ts.net:8443', token: '', tailnetMachine: 'studio', tailnetDomain: 'tail1.ts.net' }] };
    const { computers } = applyRoutesReport([studio, devbox], devbox.id, relayRoute, {
      machineId: 'devbox-install',
      name: 'devbox',
      relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: [] },
      tailnet: { dnsName: 'Studio.tail1.ts.net.', machine: 'Studio', domain: 'tail1.ts.net', port: 8443 },
    });
    expect(computers.find((computer) => computer.id === devbox.id)?.routes.map((route) => route.kind)).toEqual(['relay']);
  });

  it('lets a computer proved yours take its Tailscale name back from a record that claimed it first, and nothing else does (review S-8)', () => {
    const claimedRoute = { id: 'tailscale:https://devbox.tail1.ts.net:8443', kind: 'tailscale' as const, source: 'found' as const, baseUrl: 'https://devbox.tail1.ts.net:8443', token: 'mallory-token', tailnetMachine: 'devbox', tailnetDomain: 'tail1.ts.net' };
    const mallory: RemoteComputer = { id: 'mallory', label: 'mallory', routes: [claimedRoute, { ...relayRoute, id: 'relay:https://m.runpane.net', baseUrl: 'https://m.runpane.net', relay: { computerId: 'm', fingerprint: 'fp-m' } }] };
    const report = {
      machineId: 'devbox-install',
      name: 'devbox',
      relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: [] },
      tailnet: { dnsName: 'devbox.tail1.ts.net.', machine: 'devbox', domain: 'tail1.ts.net', port: 8443 },
    };
    const kinds = (computers: RemoteComputer[], id: string) => computers.find((computer) => computer.id === id)?.routes.map((route) => route.kind);

    // Not proved yours: first come keeps it.
    const unproved = applyRoutesReport([mallory, devbox], devbox.id, relayRoute, report).computers;
    expect(kinds(unproved, 'mallory')).toEqual(['tailscale', 'relay']);
    expect(kinds(unproved, devbox.id)).toEqual(['relay']);

    // Proved yours for the key this report's route is pinned to: the name is yours, and the claim goes.
    const proved: RemoteComputer = { ...devbox, mine: 'tailscale', mineRelay: { computerId: 'k7xq2m4n8p3r5t6v', fingerprint: 'fp' } };
    const taken = applyRoutesReport([mallory, proved], devbox.id, relayRoute, report).computers;
    expect(kinds(taken, devbox.id)).toEqual(['tailscale', 'relay']);
    expect(kinds(taken, 'mallory')).toEqual(['relay']);

    // A mark proved for another key, or a report naming another key, takes nothing.
    const otherKey: RemoteComputer = { ...proved, mineRelay: { computerId: 'k7xq2m4n8p3r5t6v', fingerprint: 'other' } };
    expect(kinds(applyRoutesReport([mallory, otherKey], devbox.id, relayRoute, report).computers, 'mallory')).toEqual(['tailscale', 'relay']);
    const lying = { ...report, relay: { ...report.relay, fingerprint: 'other' } };
    expect(kinds(applyRoutesReport([mallory, proved], devbox.id, relayRoute, lying).computers, 'mallory')).toEqual(['tailscale', 'relay']);
  });

  it('saves only https addresses a computer reports, so its token never goes out in the clear', () => {
    const { computers } = applyRoutesReport([devbox], devbox.id, relayRoute, {
      machineId: 'devbox-install',
      name: 'devbox',
      relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: ['http://10.0.0.5', 'https://user:pw@10.0.0.6', 'not an address'] },
      publicUrl: 'http://pane.example.com',
    });
    expect(computers[0].routes.map((route) => route.baseUrl)).toEqual(['https://k7xq2m4n8p3r5t6v.runpane.net']);
  });

  it('moves a route that answers as a different computer onto that computer', () => {
    const tailnetRoute = { id: 'tailscale:https://devbox.t.ts.net:8443', kind: 'tailscale' as const, source: 'found' as const, baseUrl: 'https://devbox.t.ts.net:8443', token: '' };
    const both: RemoteComputer = { ...devbox, routes: [tailnetRoute, relayRoute] };
    const { computers, id } = applyRoutesReport([both], devbox.id, tailnetRoute, { machineId: 'a-second-devbox', name: 'devbox' });
    expect(computers.map((computer) => computer.routes.map((route) => route.kind))).toEqual([['relay'], ['tailscale']]);
    expect(id).not.toBe(devbox.id);
  });

  describe('a host that reports another saved computer\'s install id', () => {
    const teammateRoute = { id: 'tailscale:https://teammate.t.ts.net:8443', kind: 'tailscale' as const, source: 'manual' as const, baseUrl: 'https://teammate.t.ts.net:8443', token: '' };
    const studio: RemoteComputer = { ...devbox, label: 'Studio Mac', machineId: 'studio-install' };
    const claimsStudio = { machineId: 'studio-install', name: 'Studio Mac' };

    it('keeps its route on its own record and leaves that computer as it was', () => {
      const teammate: RemoteComputer = { id: 'tailnet-teammate', label: 'teammate', machineId: 'teammate-install', routes: [teammateRoute] };
      const { computers } = applyRoutesReport([studio, teammate], teammate.id, teammateRoute, claimsStudio);
      expect(computers.find((computer) => computer.id === studio.id)).toEqual(studio);
      expect(computers.find((computer) => computer.id === teammate.id)?.routes).toEqual([teammateRoute]);
    });

    it('never folds that computer into a record with no install id yet', () => {
      const teammate: RemoteComputer = { id: 'tailnet-teammate', label: 'teammate', routes: [teammateRoute] };
      const { computers } = applyRoutesReport([studio, teammate], teammate.id, teammateRoute, claimsStudio);
      expect(computers).toEqual([studio, teammate]);
    });

    it('ignores Studio Mac\'s relay id and key in a report over Tailscale, since anyone can repeat them', () => {
      const teammate: RemoteComputer = { id: 'tailnet-teammate', label: 'teammate', routes: [teammateRoute] };
      const { computers } = applyRoutesReport([studio, teammate], teammate.id, teammateRoute, {
        ...claimsStudio,
        relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: [] },
      });
      expect(computers).toEqual([studio, teammate]);
    });

    it('folds a leftover record into the computer when the report comes over a route that checked that computer\'s key', () => {
      const leftover: RemoteComputer = { id: 'relay-old', label: 'Studio Mac', machineId: 'studio-install', routes: [{ ...relayRoute, id: 'relay:old', token: 'old' }] };
      const fresh: RemoteComputer = { id: 'relay-k7xq2m4n8p3r5t6v', label: 'Studio Mac', routes: [relayRoute] };
      const { computers } = applyRoutesReport([leftover, fresh], fresh.id, relayRoute, {
        ...claimsStudio,
        relay: { id: 'k7xq2m4n8p3r5t6v', address: 'https://k7xq2m4n8p3r5t6v.runpane.net', fingerprint: 'fp', local: [] },
      });
      expect(computers.map((computer) => [computer.id, computer.machineId])).toEqual([['relay-k7xq2m4n8p3r5t6v', 'studio-install']]);
    });
  });
});

describe('routes worth trying from here', () => {
  const lan = (address: string) => ({ kind: 'lan' as const, baseUrl: `https://l${address.replace(/\./g, '-')}.k7xq2m4n8p3r5t6v.runpane.net:42138` });
  const relay = { kind: 'relay' as const, baseUrl: 'https://k7xq2m4n8p3r5t6v.runpane.net' };
  // A Mac on its home Wi-Fi, 192.168.1.0/24.
  const mac = [
    { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true },
    { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false },
  ];

  it('tries only Same network addresses on one of this computer\'s subnets', () => {
    // A Windows PC on another home network, with WSL and Docker adapters, and one on the Mac's own Wi-Fi.
    const routes = [lan('192.168.0.20'), lan('172.20.240.1'), lan('172.17.0.1'), lan('192.168.1.30'), relay];
    expect(routesReachableHere(routes, mac)).toEqual([lan('192.168.1.30'), relay]);
  });

  it('keeps every route when none is left to try', () => {
    expect(routesReachableHere([lan('10.0.0.4')], mac)).toEqual([lan('10.0.0.4')]);
  });
});
