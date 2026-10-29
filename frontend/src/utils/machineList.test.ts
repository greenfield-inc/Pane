import { describe, expect, it } from 'vitest';
import { buildMachineList, getHostingSummary, type MachineListInput } from './machineList';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';
import type { TailnetMachine } from '../../../shared/types/workspaceAccess';

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

const buildBox: RemotePaneConnectionProfile = {
  id: 'build-box-profile', label: 'build-box', baseUrl: 'https://build-box.tail1234.ts.net:8443', token: '',
  transport: 'http+sse', tailnetMachine: 'build-box', tailnetDomain: 'tail1234.ts.net',
};
const cloudVm: RemotePaneConnectionProfile = {
  id: 'cloud-vm-profile', label: 'cloud-vm', baseUrl: 'https://cloud-vm.example.com', token: 'synthetic', transport: 'http+sse',
};

const local = createDefaultRemotePaneConnectionState();
const onBuildBox = (status: RemotePaneConnectionState['status']): RemotePaneConnectionState => ({
  ...local, mode: 'remote', status, activeProfileId: buildBox.id, activeProfileLabel: 'build-box', activeBaseUrl: buildBox.baseUrl,
});

const input = (overrides: Partial<MachineListInput> = {}): MachineListInput => ({
  connectionState: local,
  profiles: [buildBox, cloudVm],
  tailnet: {
    ok: true,
    tailnet: 'demo.github',
    domain: 'tail1234.ts.net',
    machines: [
      tailnetMachine('build-box', 'Linux', 'available', { profileId: buildBox.id }),
      tailnetMachine('office-pc', 'Windows', 'available'),
      tailnetMachine('travel-laptop', 'macOS', 'offline'),
      tailnetMachine('alex-mini', 'macOS', 'refused', { mine: false, ownerLogin: 'alex@github' }),
    ],
  },
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
  it('lists this computer, then Tailscale machines, then code hosts', () => {
    expect(buildMachineList(input()).map((machine) => machine.name))
      .toEqual(['studio-mac', 'build-box', 'office-pc', 'travel-laptop', 'alex-mini', 'cloud-vm']);
  });

  it('describes each machine with its OS and state', () => {
    const list = buildMachineList(input());
    expect(list.map((machine) => machine.subtitle)).toEqual([
      'macOS · This computer',
      'Linux · Ready',
      'Windows · Ready · Never connected',
      'macOS · Offline · Never connected',
      'macOS · Owner only · Never connected · alex@github',
      'Added with a code',
    ]);
  });

  it('switches to saved machines, connects new ones, and cannot pick unreachable ones', () => {
    const list = buildMachineList(input());
    expect(list.map((machine) => [machine.name, machine.action, machine.presence])).toEqual([
      ['studio-mac', 'none', 'solid'],
      ['build-box', 'switch', 'solid'],
      ['office-pc', 'connect', 'solid'],
      ['travel-laptop', 'none', 'dimmed'],
      ['alex-mini', 'none', 'dimmed'],
      ['cloud-vm', 'switch', 'solid'],
    ]);
    expect(byName(list, 'office-pc').id).toBe('tailnet:office-pc.tail1234.ts.net');
  });

  it('asks for the password of a machine that wants one, saved or not', () => {
    const list = buildMachineList(input({
      tailnet: { ok: true, tailnet: 'demo.github', domain: 'tail1234.ts.net', machines: [
        tailnetMachine('build-box', 'Linux', 'password-required', { profileId: buildBox.id }),
        tailnetMachine('office-pc', 'Windows', 'password-required'),
      ] },
    }));
    expect(byName(list, 'build-box').action).toBe('password');
    expect(byName(list, 'office-pc').action).toBe('password');
  });

  it('marks the active remote machine, and pulses or dims it while it is not connected', () => {
    const connected = buildMachineList(input({ connectionState: onBuildBox('connected') }));
    expect(connected.filter((machine) => machine.active).map((machine) => machine.name)).toEqual(['build-box']);
    expect(byName(connected, 'build-box')).toMatchObject({ subtitle: 'Linux · Agents run here', action: 'none', presence: 'solid' });
    expect(byName(connected, 'studio-mac')).toMatchObject({ subtitle: 'macOS · This computer', action: 'switch' });

    expect(byName(buildMachineList(input({ connectionState: onBuildBox('reconnecting') })), 'build-box'))
      .toMatchObject({ subtitle: 'Linux · Reconnecting…', action: 'retry', presence: 'pulsing' });
    expect(byName(buildMachineList(input({ connectionState: onBuildBox('error') })), 'build-box'))
      .toMatchObject({ subtitle: 'Linux · Connection failed · Retry', action: 'retry', presence: 'dimmed' });
  });

  it('keeps saved Tailscale machines pickable before the listing answers', () => {
    const list = buildMachineList(input({ tailnet: null, localName: null }));
    expect(list.map((machine) => [machine.name, machine.subtitle, machine.action])).toEqual([
      ['This computer', 'macOS', 'none'],
      ['build-box', 'Saved', 'switch'],
      ['cloud-vm', 'Added with a code', 'switch'],
    ]);
  });

  it('gives this computer and its Tailscale machines different colours', () => {
    const list = buildMachineList(input());
    const mine = ['studio-mac', 'build-box', 'office-pc', 'travel-laptop'].map((name) => byName(list, name).slot);
    expect(new Set(mine).size).toBe(4);
  });
});

describe('getHostingSummary', () => {
  it('summarizes hosting when this machine also serves remote clients', () => {
    const idle = createDefaultRemoteDaemonHostRuntimeState();
    const client = { id: 'phone', clientId: null, label: null, deviceLabel: 'iPhone', remoteAddress: null, connectedAt: '', lastSeenAt: '' };
    expect(getHostingSummary({ ...idle, status: 'live', connectedClients: [client] })).toBe('Hosting · 1 client connected');
    expect(getHostingSummary({ ...idle, status: 'error' })).toBe('Hosting offline');
    expect(getHostingSummary(idle)).toBeNull();
  });
});
