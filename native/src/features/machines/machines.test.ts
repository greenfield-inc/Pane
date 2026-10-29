import { describe, expect, it } from 'vitest';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine, TailnetMachineList } from '@shared/types/workspaceAccess';

import { listMachines } from './machines';

const DOMAIN = 'tail1234.ts.net';

function saved(name: string, extra: Partial<RemotePaneConnectionProfile> = {}): RemotePaneConnectionProfile {
  return {
    id: `tailnet-${DOMAIN}-${name}`,
    label: name,
    baseUrl: `https://${name}.${DOMAIN}:8443`,
    token: '',
    transport: 'http+sse',
    tailnetMachine: name,
    tailnetDomain: DOMAIN,
    ...extra,
  };
}

function tailnet(name: string, os: TailnetMachine['os'], state: TailnetMachine['state'], extra: Partial<TailnetMachine> = {}): TailnetMachine {
  return { name, os, state, dnsName: `${name}.${DOMAIN}.`, url: `https://${name}.${DOMAIN}:8443`, ownerLogin: 'me@example.com', mine: true, ...extra };
}

const list = (machines: TailnetMachine[]): TailnetMachineList => ({ ok: true, tailnet: 'me@example.com', domain: DOMAIN, machines });

describe('listMachines', () => {
  const studio = saved('studio-mac');
  const devbox = saved('parsa-devbox');

  it('lists saved machines, then your own Tailscale machines that are Ready or need a password', () => {
    const machines = listMachines({
      profiles: [studio, devbox],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([
        tailnet('studio-mac', 'macOS', 'available'),
        tailnet('build-box', 'Linux', 'available'),
        tailnet('parsa-devbox', 'Windows', 'available'),
        tailnet('locked-mac', 'macOS', 'password-required'),
        tailnet('travel-laptop', 'macOS', 'offline'),
        tailnet('old-box', 'Linux', 'outdated'),
        tailnet('friends-pc', 'Windows', 'available', { mine: false }),
      ]),
    });
    expect(machines.map(machine => [machine.name, machine.os, machine.status, machine.state, machine.current, machine.profile ? 'saved' : 'new'])).toEqual([
      ['studio-mac', 'macOS', 'Connected', 'solid', true, 'saved'],
      ['parsa-devbox', 'Windows', 'Ready', 'solid', false, 'saved'],
      ['build-box', 'Linux', 'Ready', 'solid', false, 'new'],
      ['locked-mac', 'macOS', 'Needs password', 'solid', false, 'new'],
    ]);
  });

  it('pulses the current machine through the grace window and dims it after, as the shared presence rule says', () => {
    const states = ([
      ['connecting', 'reconnecting'],
      ['reconnecting', 'reconnecting'],
      ['restoring', 'restoring'],
      ['reconnecting', 'unreachable'],
      ['error', 'unreachable'],
      ['local', 'unreachable'],
    ] as const).map(([connection, presence]) => {
      const [current] = listMachines({ profiles: [studio], current: studio, connection, presence, tailnet: undefined });
      return [current.status, current.state];
    });
    expect(states).toEqual([
      ['Connecting…', 'pulsing'],
      ['Reconnecting…', 'pulsing'],
      ['Restoring…', 'pulsing'],
      ['Can’t reach', 'dimmed'],
      ['Offline', 'dimmed'],
      ['Not connected', 'dimmed'],
    ]);
  });

  it('dims a saved machine that Tailscale reports offline, and does not let it be picked', () => {
    const machines = listMachines({
      profiles: [studio, devbox],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([tailnet('parsa-devbox', 'Windows', 'offline')]),
    });
    expect(machines[1]).toMatchObject({ name: 'parsa-devbox', status: 'Offline', state: 'dimmed', selectable: false });
  });

  it('shows a machine paired with a code as a plain computer until Tailscale names it', () => {
    const coded = saved('office', { id: 'code-1', baseUrl: 'https://192.168.1.20:7777', tailnetMachine: undefined, tailnetDomain: undefined });
    const [, other] = listMachines({ profiles: [studio, coded], current: studio, connection: 'connected',
      presence: 'connected', tailnet: list([]) });
    expect(other).toMatchObject({ name: 'office', os: null, state: 'solid', selectable: true });
  });

  it('matches a machine paired with a code to its Tailscale entry by address, so it is listed once', () => {
    const coded = saved('build-box', { id: 'code-2', label: 'Build box', tailnetMachine: undefined, tailnetDomain: undefined });
    const machines = listMachines({
      profiles: [studio, coded],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([tailnet('build-box', 'Linux', 'available')]),
    });
    expect(machines.map(machine => [machine.name, machine.os])).toEqual([['studio-mac', null], ['Build box', 'Linux']]);
  });

  it('keeps a machine paired with a code selectable when Tailscale cannot reach its Workspaces listener', () => {
    // The code pairing answers on its own port; the list probes another one.
    const coded = saved('build-box', { id: 'code-3', label: 'Build box', baseUrl: `https://build-box.${DOMAIN}:42157`, tailnetMachine: undefined, tailnetDomain: undefined });
    const [, other] = listMachines({
      profiles: [studio, coded],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([tailnet('build-box', 'Linux', 'unreachable')]),
    });
    expect(other).toMatchObject({ name: 'Build box', os: 'Linux', status: 'Saved', state: 'solid', selectable: true });
  });

  it('includes the current machine when it is not saved, as in the demo', () => {
    const machines = listMachines({ profiles: [], current: studio, connection: 'connected',
      presence: 'connected', tailnet: undefined });
    expect(machines.map(machine => machine.name)).toEqual(['studio-mac']);
  });

  it('colours from every machine the listing names, as desktop does, so a hidden offline machine still settles a clash', () => {
    // build-box and studio-mac both hash to slot 3; build-box sorts first, so it keeps it.
    const [current] = listMachines({
      profiles: [studio],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([tailnet('studio-mac', 'macOS', 'available'), tailnet('build-box', 'Linux', 'offline')]),
    });
    expect(current).toMatchObject({ name: 'studio-mac', slot: 4 });
  });

  it('gives each machine its color slot from the names on the list', () => {
    const machines = listMachines({
      profiles: [studio],
      current: studio,
      connection: 'connected',
      presence: 'connected',
      tailnet: list([tailnet('build-box', 'Linux', 'available')]),
    });
    expect(machines.map(machine => [machine.name, machine.slot])).toEqual([['studio-mac', 4], ['build-box', 3]]);
  });
});
