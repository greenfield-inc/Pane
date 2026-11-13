import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineViews, startAllMachinesFeed, useAllMachinesStore } from './allMachinesStore';
import { useErrorStore } from './errorStore';
import type { MachineConnectionsEvent, MachineResult, MachineState } from '../../../shared/types/machineConnections';

const machines: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
  { id: 'build', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'devbox', label: 'parsa-devbox', kind: 'remote', status: 'online', offlineSince: null },
];

let emit: (event: MachineConnectionsEvent) => void;
const read = vi.fn((machineId: string, channel: string): Promise<MachineResult> => Promise.resolve({
  machineId,
  data: { success: true, data: channel === 'sessions:get-all-with-projects' ? [{ id: 1, name: `${machineId}-repo`, sessions: [] }] : [] },
}));
const readsOf = (machineId: string) => read.mock.calls.filter(([id]) => id === machineId).map(([, channel]) => channel);

let stop: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T09:20:00Z'));
  read.mockReset();
  vi.stubGlobal('window', { electronAPI: { preferences: { get: async () => null, set: async () => undefined }, machines: {
    list: () => Promise.resolve(machines),
    read,
    onEvent: (callback: typeof emit) => { emit = callback; return () => undefined; },
  } } });
  useAllMachinesStore.setState({ layout: { sessions: null, panes: {}, open: [], seeded: [] } });
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

  it('takes each machine\'s first answer as its first look, so later rows count as arrivals', () => {
    expect(useAllMachinesStore.getState().layout.seeded.sort()).toEqual([
      'projects:build', 'projects:devbox', 'projects:local', 'sessions:build', 'sessions:devbox', 'sessions:local',
    ]);
    expect(useAllMachinesStore.getState().layout.sessions).toEqual([]);
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

  it('keeps the newer list when an older read of it lands later', async () => {
    let status = 'working';
    let answerNotify: () => void = () => undefined;
    read.mockImplementation((machineId: string, channel: string) => {
      if (channel === 'notify:remote-snapshot') return new Promise(resolve => { answerNotify = () => resolve({ machineId, data: { success: true, data: [] } }); });
      return Promise.resolve({ machineId, data: { success: true, data: channel === 'panels:agent-statuses' ? [{ panelId: 'panel-1', status }] : [] } });
    });

    // A resync reads every list and waits on Notify; a status event reads statuses again meanwhile.
    emit({ type: 'resync', machineId: 'build' });
    await vi.advanceTimersByTimeAsync(300);
    status = 'blocked';
    emit({ type: 'event', machineId: 'build', channel: 'panel:agentStatus', args: [] });
    await vi.advanceTimersByTimeAsync(300);
    answerNotify();
    await vi.advanceTimersByTimeAsync(0);

    expect(useAllMachinesStore.getState().snapshots.build?.statuses).toEqual([{ panelId: 'panel-1', status: 'blocked' }]);
  });

  it('keeps one read of a list in flight on a slow machine, and reads it once more after events arrived meanwhile', async () => {
    const answers: Array<() => void> = [];
    read.mockImplementation((machineId: string) => new Promise(resolve => {
      answers.push(() => resolve({ machineId, data: { success: true, data: [] } }));
    }));

    // Status events every 250 ms for 2 s while build-box takes longer than that to answer.
    for (let tick = 0; tick < 8; tick += 1) {
      emit({ type: 'event', machineId: 'build', channel: 'panel:agentStatus', args: [] });
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(readsOf('build')).toEqual(['panels:agent-statuses']);

    answers[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOf('build')).toEqual(['panels:agent-statuses', 'panels:agent-statuses']);
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

describe('first looks in machine-menu order', () => {
  it('lists the first machine in the menu first even when it answers last', async () => {
    vi.useFakeTimers();
    let answerLocal: () => void = () => undefined;
    const localAnswered = new Promise<void>(resolve => { answerLocal = resolve; });
    const sessionsOf = (machineId: string) => [{ id: `${machineId}-s`, name: machineId, archived: false, associations: [], createdAt: '2026-10-30T09:00:00Z' }];
    const slowRead = vi.fn(async (machineId: string, channel: string): Promise<MachineResult> => {
      if (machineId === 'local') await localAnswered;
      if (channel === 'orchestration-sessions:list') return { machineId, data: { success: true, data: { sessions: sessionsOf(machineId) } } };
      return { machineId, data: { success: true, data: [] } };
    });
    vi.stubGlobal('window', { electronAPI: { preferences: { get: async () => null, set: async () => undefined }, machines: {
      list: () => Promise.resolve(machines.slice(0, 2)), read: slowRead, onEvent: () => () => undefined,
    } } });
    useAllMachinesStore.setState({
      layout: { sessions: null, panes: {}, open: [], seeded: [] },
      entries: [{ id: 'local', name: 'studio-mac', os: 'macOS', slot: 0, letters: 'S', active: true }, { id: 'build', name: 'build-box', os: 'Linux', slot: 1, letters: 'B', active: false }],
    });
    const stopFeed = startAllMachinesFeed();
    await vi.advanceTimersByTimeAsync(50);
    expect(useAllMachinesStore.getState().layout.sessions).toEqual(['build:build-s']);

    answerLocal();
    await vi.advanceTimersByTimeAsync(50);
    expect(useAllMachinesStore.getState().layout.sessions).toEqual(['local:local-s', 'build:build-s']);
    stopFeed();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe('All machines layout, saved on this computer', () => {
  const saved = new Map<string, string>();
  const preferences = {
    get: vi.fn((key: string) => Promise.resolve(saved.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => { saved.set(key, value); return Promise.resolve({ success: true }); }),
  };

  beforeEach(() => {
    saved.clear();
    vi.stubGlobal('window', { electronAPI: { preferences, machines: { list: () => Promise.resolve([]), read, onEvent: () => () => undefined } } });
  });

  it('starts with both sections open and every project and Session closed', async () => {
    await useAllMachinesStore.getState().hydrate();

    const { layout } = useAllMachinesStore.getState();
    expect(layout.sessions).toBeNull();
    expect(layout.open).toEqual(['section:sessions', 'section:projects']);
  });

  it('remembers moves and what is open across a relaunch', async () => {
    await useAllMachinesStore.getState().hydrate();
    const store = useAllMachinesStore.getState();
    store.arrangeSessions(['build:s3', 'local:s1']);
    store.arrangePanes('acme-web', ['build:b', 'local:a']);
    store.toggleOpen('project:acme-web');
    store.toggleOpen('section:sessions');

    useAllMachinesStore.setState({ layout: { sessions: null, panes: {}, open: [], seeded: [] } });
    await useAllMachinesStore.getState().hydrate();

    expect(useAllMachinesStore.getState().layout).toEqual({
      sessions: ['build:s3', 'local:s1'],
      panes: { 'acme-web': ['build:b', 'local:a'] },
      open: ['section:projects', 'project:acme-web'],
      seeded: [],
    });
  });

  it('says when a move was not remembered, and keeps showing it until a relaunch', async () => {
    await useAllMachinesStore.getState().hydrate();
    preferences.set.mockRejectedValueOnce(new Error('database is locked'));

    useAllMachinesStore.getState().arrangeSessions(['build:s3', 'local:s1']);
    await vi.waitFor(() => expect(useErrorStore.getState().currentError).not.toBeNull());

    expect(useErrorStore.getState().currentError).toMatchObject({
      title: 'Your All machines arrangement was not saved',
      error: expect.stringMatching(/database is locked.*until Pane restarts/s),
    });
    expect(useAllMachinesStore.getState().layout.sessions).toEqual(['build:s3', 'local:s1']);
  });

  it('starts fresh from a saved layout it cannot read', async () => {
    saved.set('sidebar_all_machines_layout', '{"sessions": 5');
    await useAllMachinesStore.getState().hydrate();

    expect(useAllMachinesStore.getState().layout).toEqual({ sessions: null, panes: {}, open: ['section:sessions', 'section:projects'], seeded: [] });
  });
});

describe('machineViews', () => {
  it('lists machines in the machine menu\'s order', () => {
    const views = machineViews({
      machines,
      snapshots: {},
      entries: [
        { id: 'devbox', name: 'parsa-devbox', os: 'Linux', slot: 2, letters: 'P', active: false },
        { id: 'local', name: 'studio-mac', os: 'macOS', slot: 0, letters: 'S', active: true },
      ],
    });

    expect(views.map(view => view.machine.id)).toEqual(['devbox', 'local', 'build']);
  });
});
