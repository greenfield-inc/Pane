import { describe, expect, it } from 'vitest';
import type { ConnectionPresence } from '../../../shared/remoteClient/connectionPresence';
import { buildMachineList, getHostingSummary, type MachineListInput } from './machineList';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';
import type { ComputerRoute, RemoteComputer } from '../../../shared/types/remoteComputers';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';

const tailnetMachine = (name: string, os: TailnetMachine['os'], state: TailnetMachine['state'], extra: Partial<TailnetMachine> = {}): TailnetMachine => ({
  name,
  dnsName: `${name}.tail1234.ts.net`,
  url: `https://${name}.tail1234.ts.net:8443`,
  os,
  ownerLogin: 'demo@github',
  mine: true,
  state,
  ...extra,
});

const tailscale = (name: string): ComputerRoute => ({
  id: `tailscale:https://${name}.tail1234.ts.net:8443`, kind: 'tailscale', source: 'found',
  baseUrl: `https://${name}.tail1234.ts.net:8443`, token: '', tailnetMachine: name, tailnetDomain: 'tail1234.ts.net',
});
const relay = (id: string): ComputerRoute => ({
  id: `relay:https://${id}.runpane.net`, kind: 'relay', source: 'link', baseUrl: `https://${id}.runpane.net`, token: 'synthetic',
  relay: { computerId: id, fingerprint: 'f' },
});
const lan = (address: string, id: string): ComputerRoute => ({
  id: `lan:${address}`, kind: 'lan', source: 'found', baseUrl: address, token: 'synthetic', relay: { computerId: id, fingerprint: 'f' },
});

const buildBox: RemoteComputer = { id: 'build-box', label: 'build-box', routes: [tailscale('build-box')] };
const cloudVm: RemoteComputer = {
  id: 'cloud-vm', label: 'cloud-vm',
  routes: [{ id: 'public:https://cloud-vm.example.com', kind: 'public', source: 'manual', baseUrl: 'https://cloud-vm.example.com', token: 'synthetic' }],
};

const local = createDefaultRemotePaneConnectionState();
const on = (computerId: string, status: RemotePaneConnectionState['status'], activeRouteId?: string): RemotePaneConnectionState => {
  const state: RemotePaneConnectionState = { ...local, mode: 'remote', status, activeProfileId: computerId, activeProfileLabel: computerId, activeBaseUrl: null };
  if (activeRouteId) state.activeRouteId = activeRouteId;
  return state;
};

const listing = (machines: TailnetMachine[]): TailnetMachineList => ({ ok: true, tailnet: 'demo.github', domain: 'tail1234.ts.net', machines });
const signedOut: TailnetMachineList = { ok: false, reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' };

const input = (overrides: Partial<MachineListInput> = {}): MachineListInput => ({
  connectionState: local,
  computers: [buildBox, cloudVm],
  tailnet: listing([
    tailnetMachine('build-box', 'Linux', 'available'),
    tailnetMachine('office-pc', 'Windows', 'available'),
    tailnetMachine('travel-laptop', 'macOS', 'offline'),
    tailnetMachine('alex-mini', 'macOS', 'refused', { mine: false, ownerLogin: 'alex@github' }),
  ]),
  localName: 'studio-mac',
  localOs: 'macOS',
  ...overrides,
});

const byName = (list: ReturnType<typeof buildMachineList>, name: string) => {
  const entry = list.find((machine) => machine.name === name);
  if (!entry) throw new Error(`${name} missing`);
  return entry;
};

describe('buildMachineList', () => {
  it('lists this computer, then saved computers, then Tailscale machines not saved yet', () => {
    expect(buildMachineList(input()).map((machine) => [machine.name, machine.kind])).toEqual([
      ['studio-mac', 'local'],
      ['build-box', 'computer'],
      ['cloud-vm', 'computer'],
      ['office-pc', 'tailnet'],
      ['travel-laptop', 'tailnet'],
      ['alex-mini', 'tailnet'],
    ]);
  });

  it('describes each machine with its OS and state', () => {
    expect(buildMachineList(input()).map((machine) => machine.subtitle)).toEqual([
      'macOS · This computer',
      'Linux · Online',
      'Saved',
      'Windows · Online · Not linked',
      'macOS · Offline · Not linked',
      'macOS · Owner only · Not linked · alex@github',
    ]);
  });

  it('switches to saved computers, connects new ones, and cannot pick unreachable ones', () => {
    const list = buildMachineList(input());
    expect(list.map((machine) => [machine.name, machine.action, machine.presence])).toEqual([
      ['studio-mac', 'none', 'solid'],
      ['build-box', 'switch', 'solid'],
      ['cloud-vm', 'switch', 'solid'],
      ['office-pc', 'connect', 'solid'],
      ['travel-laptop', 'none', 'dimmed'],
      ['alex-mini', 'none', 'dimmed'],
    ]);
    expect(byName(list, 'office-pc').id).toBe('tailnet:office-pc.tail1234.ts.net');
  });

  // Journey 1: the Mac linked by the relay and on the tailnet is one row.
  it('joins a Tailscale machine to the saved computer with its install id, under the name the computer has', () => {
    const mac: RemoteComputer = { id: 'relay-mac', label: 'Parsas-MacBook-Pro', machineId: 'install-mac', os: 'macOS', routes: [relay('macrelay')] };
    const list = buildMachineList(input({
      computers: [mac],
      tailnet: listing([tailnetMachine('parsas-macbook-pro', 'macOS', 'available', { machineId: 'install-mac' })]),
    }));
    expect(list.map((machine) => machine.name)).toEqual(['studio-mac', 'Parsas-MacBook-Pro']);
    expect(byName(list, 'Parsas-MacBook-Pro').tailnet?.name).toBe('parsas-macbook-pro');
  });

  it('joins a Tailscale machine whose install id is not known yet by its name', () => {
    const mac: RemoteComputer = { id: 'relay-mac', label: 'Parsas-MacBook-Pro', routes: [relay('macrelay')] };
    const list = buildMachineList(input({ computers: [mac], tailnet: listing([tailnetMachine('parsas-macbook-pro', 'macOS', 'available')]) }));
    expect(list.map((machine) => machine.name)).toEqual(['studio-mac', 'Parsas-MacBook-Pro']);
  });

  // Journey 16: same name, different install ids, two rows.
  it('keeps two computers with the same name and different install ids as two rows', () => {
    const first: RemoteComputer = { id: 'mini-a', label: 'mac-mini', machineId: 'install-a', routes: [relay('minia')] };
    const second: RemoteComputer = { id: 'mini-b', label: 'mac-mini', machineId: 'install-b', routes: [relay('minib')] };
    const list = buildMachineList(input({
      computers: [first, second],
      tailnet: listing([tailnetMachine('mac-mini', 'macOS', 'available', { machineId: 'install-c' })]),
    }));
    expect(list.map((machine) => [machine.id, machine.kind])).toEqual([
      ['local', 'local'],
      ['mini-a', 'computer'],
      ['mini-b', 'computer'],
      ['tailnet:mac-mini.tail1234.ts.net', 'tailnet'],
    ]);
  });

  it('shows every route as a pill in order, with the dot on the active computer\'s route in use', () => {
    const buildBoxAll: RemoteComputer = { id: 'build-box', label: 'Build Box', routes: [lan('https://192.168.1.20:8443', 'bb'), tailscale('build-box'), relay('bb')] };
    const list = buildMachineList(input({ computers: [buildBoxAll], connectionState: on('build-box', 'connected', 'lan:https://192.168.1.20:8443') }));
    expect(byName(list, 'Build Box').routes).toEqual([
      { id: 'lan:https://192.168.1.20:8443', kind: 'lan', label: 'Same network', inUse: true, down: false },
      { id: 'tailscale:https://build-box.tail1234.ts.net:8443', kind: 'tailscale', label: 'Tailscale', inUse: false, down: false },
      { id: 'relay:https://bb.runpane.net', kind: 'relay', label: 'Pane relay', inUse: false, down: false },
    ]);
    expect(byName(list, 'Build Box').profile?.baseUrl).toBe('https://192.168.1.20:8443');
  });

  it('puts the dot on the route All machines reports for a computer agents do not run on', () => {
    const gpu: RemoteComputer = { id: 'gpu-vm', label: 'GPU VM', routes: [tailscale('gpu-vm'), relay('gpu')] };
    const state: MachineState = { id: 'gpu-vm', label: 'GPU VM', kind: 'remote', status: 'online', offlineSince: null, routeId: 'relay:https://gpu.runpane.net' };
    const entry = byName(buildMachineList(input({ computers: [gpu], machineStates: [state] })), 'GPU VM');
    expect(entry.routes?.map((route) => [route.label, route.inUse])).toEqual([['Tailscale', false], ['Pane relay', true]]);
    expect(entry.subtitle).toBe('Online');
  });

  it('strikes Tailscale routes while Tailscale is signed out here, and asks for a link when nothing else reaches the computer', () => {
    const both: RemoteComputer = { id: 'build-box', label: 'Build Box', routes: [tailscale('build-box'), relay('bb')] };
    const travel: RemoteComputer = { id: 'travel', label: 'Travel Laptop', os: 'Linux', routes: [tailscale('travel-laptop')] };
    const list = buildMachineList(input({ computers: [both, travel], tailnet: signedOut }));
    expect(byName(list, 'Build Box').routes?.map((route) => [route.label, route.down])).toEqual([['Tailscale', true], ['Pane relay', false]]);
    expect(byName(list, 'Build Box')).toMatchObject({ needsLink: false, action: 'switch' });
    expect(byName(list, 'Travel Laptop')).toMatchObject({
      needsLink: true, action: 'none', presence: 'dimmed', subtitle: 'Linux · Only on Tailscale, which is signed out here',
    });
  });

  it('asks for the password of a machine that wants one, saved or not', () => {
    const list = buildMachineList(input({
      tailnet: listing([
        tailnetMachine('build-box', 'Linux', 'password-required'),
        tailnetMachine('office-pc', 'Windows', 'password-required'),
      ]),
    }));
    expect(byName(list, 'build-box').action).toBe('password');
    expect(byName(list, 'office-pc').action).toBe('password');
  });

  it('marks the active computer, and pulses or dims it while it is not connected', () => {
    const connected = buildMachineList(input({ connectionState: on('build-box', 'connected') }));
    expect(connected.filter((machine) => machine.active).map((machine) => machine.name)).toEqual(['build-box']);
    expect(byName(connected, 'build-box')).toMatchObject({ subtitle: 'Linux · Agents run here', action: 'none', presence: 'solid' });
    expect(byName(connected, 'studio-mac')).toMatchObject({ subtitle: 'macOS · This computer', action: 'switch' });

    expect(byName(buildMachineList(input({ connectionState: on('build-box', 'reconnecting') })), 'build-box'))
      .toMatchObject({ subtitle: 'Linux · Reconnecting…', action: 'retry', presence: 'pulsing' });
    expect(byName(buildMachineList(input({ connectionState: on('build-box', 'error') })), 'build-box'))
      .toMatchObject({ subtitle: 'Linux · Connection failed · Retry', action: 'retry', presence: 'dimmed' });
  });

  it('dims the active computer once the grace window passes, not only when the client gives up', () => {
    const presence = (connection: ConnectionPresence) =>
      byName(buildMachineList(input({ connectionState: on('build-box', 'reconnecting'), connectionPresence: connection })), 'build-box').presence;
    expect(presence('reconnecting')).toBe('pulsing');
    expect(presence('restoring')).toBe('pulsing');
    expect(presence('unreachable')).toBe('dimmed');
  });

  it('asks the active computer for its password again when it wants a new one', () => {
    const list = buildMachineList(input({
      connectionState: on('build-box', 'error'),
      tailnet: listing([tailnetMachine('build-box', 'Linux', 'password-required')]),
    }));
    expect(byName(list, 'build-box')).toMatchObject({ active: true, action: 'password', subtitle: 'Linux · Needs password' });
  });

  it('keeps saved computers pickable before the Tailscale listing answers', () => {
    const list = buildMachineList(input({ tailnet: null, localName: null }));
    expect(list.map((machine) => [machine.name, machine.subtitle, machine.action])).toEqual([
      ['This computer', 'macOS', 'none'],
      ['build-box', 'Saved', 'switch'],
      ['cloud-vm', 'Saved', 'switch'],
    ]);
  });

  it('gives this computer and its Tailscale machines different colours', () => {
    const list = buildMachineList(input());
    const mine = ['studio-mac', 'build-box', 'office-pc', 'travel-laptop'].map((name) => byName(list, name).slot);
    expect(new Set(mine).size).toBe(4);
  });

  it('marks each machine with its letters, two each where first letters are shared', () => {
    const list = buildMachineList(input());
    expect(list.map((machine) => [machine.name, machine.letters])).toEqual([
      ['studio-mac', 'S'],
      ['build-box', 'B'],
      ['cloud-vm', 'C'],
      ['office-pc', 'O'],
      ['travel-laptop', 'T'],
      ['alex-mini', 'A'],
    ]);
    const crowded = buildMachineList(input({ localName: 'olive-mac' }));
    expect(byName(crowded, 'olive-mac').letters).toBe('OM');
    expect(byName(crowded, 'office-pc').letters).toBe('OP');
  });

  it('applies marks saved on this computer: this computer by `local`, others by name', () => {
    const plain = buildMachineList(input());
    const list = buildMachineList(input({
      marks: { local: { letters: 'me', color: 'Lime' }, 'travel-laptop': { color: 'Violet' } },
    }));
    expect(byName(list, 'studio-mac')).toMatchObject({ letters: 'ME', slot: 3, customMark: true, markKey: 'local' });
    expect(byName(list, 'travel-laptop')).toMatchObject({ letters: 'T', slot: 0, customMark: true, markKey: 'travel-laptop' });
    expect(byName(list, 'build-box')).toMatchObject({ letters: 'B', slot: byName(plain, 'build-box').slot, customMark: false });
  });
});

describe('getHostingSummary', () => {
  it('summarizes hosting when this machine also serves remote clients', () => {
    const idle = createDefaultRemoteDaemonHostRuntimeState();
    const client = { id: 'phone', clientId: null, label: null, deviceLabel: 'iPhone', remoteAddress: null, connectedAt: '' };
    expect(getHostingSummary({ ...idle, status: 'live', connectedClients: [client] })).toBe('Hosting · 1 client connected');
    expect(getHostingSummary({ ...idle, status: 'error' })).toBe('Hosting offline');
    expect(getHostingSummary(idle)).toBeNull();
  });
});
