import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineViews, startAllMachinesFeed, useAllMachinesStore } from './allMachinesStore';
import type { MachineConnectionsEvent, MachineState } from '../../../shared/types/machineConnections';

const machines: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
  { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'devbox', label: 'parsa-devbox', kind: 'remote', status: 'online', offlineSince: null },
];

let emit: (event: MachineConnectionsEvent) => void;
const read = vi.fn((machineId: string, channel: string) => Promise.resolve({
  machineId,
  data: { success: true, data: channel === 'sessions:get-all-with-projects' ? [{ id: 1, name: `${machineId}-repo`, sessions: [] }] : [] },
}));
const readsOf = (machineId: string) => read.mock.calls.filter(([id]) => id === machineId).map(([, channel]) => channel);

let stop: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T09:20:00Z'));
  read.mockClear();
  vi.stubGlobal('window', { electronAPI: { machines: {
    list: () => Promise.resolve(machines),
    read,
    onEvent: (callback: typeof emit) => { emit = callback; return () => undefined; },
  } } });
  stop = startAllMachinesFeed();
  // The first read of every machine.
  await vi.runAllTimersAsync();
  read.mockClear();
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('All machines feed', () => {
  it('re-reads only the machine an event came from, once per burst', async () => {
    emit({ type: 'event', machineId: 'build', channel: 'session:updated', args: [] });
    emit({ type: 'event', machineId: 'build', channel: 'panel:agentStatus', args: [] });
    await vi.runAllTimersAsync();

    expect(readsOf('local')).toEqual([]);
    expect(readsOf('devbox')).toEqual([]);
    expect(readsOf('build').sort()).toEqual(['panels:agent-statuses', 'sessions:get-all-with-projects']);
  });

  it('re-reads every list of a machine that resyncs', async () => {
    emit({ type: 'resync', machineId: 'devbox' });
    await vi.runAllTimersAsync();

    expect(readsOf('build')).toEqual([]);
    expect(readsOf('devbox').sort()).toEqual([
      'notify:remote-snapshot',
      'orchestration-sessions:list',
      'panels:agent-statuses',
      'permission:getPending',
      'sessions:get-all-with-projects',
    ]);
  });

  it('keeps an offline machine\'s rows and dims them once its grace has passed', async () => {
    emit({ type: 'machines', machines: machines.map(machine => machine.id === 'build'
      ? { ...machine, status: 'offline', offlineSince: '2026-10-30T09:20:00Z' }
      : machine) });

    const build = () => machineViews(useAllMachinesStore.getState()).find(item => item.machine.id === 'build');
    expect(build()?.offline).toBe(false);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(build()?.offline).toBe(true);
    expect(build()?.snapshot?.projects.map(project => project.name)).toEqual(['build-repo']);
  });
});
