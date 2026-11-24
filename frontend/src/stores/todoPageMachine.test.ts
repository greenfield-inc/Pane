import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { TodoDetail, TodoListRow, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { useConfigStore } from './configStore';
import { useNavigationStore } from './navigationStore';
import { installTodosApi, resetTodos, switchTodosHost, useTodosStore, type TodosAnswer, type TodosApi } from './todosStore';
import { openTodoSession } from '../components/todos/page/todoNavigation';
import { useAllMachinesStore } from './allMachinesStore';

/**
 * T-51 PR 3 (W8, W10, review F-1, F-2, F-5): this computer and the saved machine "mini" each have a T-5, and they
 * are different to-dos. The open page, the list, the reads behind them and "Open its Session" belong to the
 * machine they were read from. Every read here waits until the test answers it, so each test drives the order.
 */

type Host = 'here' | 'mini';

function record(title: string, sessionId: string | null): TodoRecord {
  return {
    number: 5, ref: 'T-5', sessionId, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: 1, startedAt: null,
    updatedAt: 1, acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
}

/** Each host names itself by hostname, as main does. */
const HOSTNAME = { here: 'Tylers-MacBook-Pro', mini: 'Tylers-Mac-mini.local' } satisfies Record<Host, string>;
const INSTALL = { here: 'here-install', mini: 'mini-install' } satisfies Record<Host, string>;
const TITLE = { here: 'Invoice PDFs', mini: 'Receipts export' } satisfies Record<Host, string>;

function row(host: Host): TodoListRow {
  return { todo: record(TITLE[host], host === 'mini' ? 'mini-receipts' : 'here-session'), status: { status: 'working', reason: '' }, machine: HOSTNAME[host] };
}

function detail(host: Host): TodoDetail {
  return {
    ...row(host), subTodos: [], attachments: [], activity: [], approvalIds: [],
    chatTarget: { panelId: null, name: 'orchestrator', kind: 'orchestrator' }, load: { gate: 'normal', canPause: false }, keepMoving: '',
  };
}

function list(host: Host): TodosSnapshot {
  return { rows: [row(host)], gate: { state: 'normal', enabled: true, since: 0 }, machine: HOSTNAME[host], ownSessionIds: [], installId: INSTALL[host] };
}

/** The window shows `hostId` (null: this computer). */
function configure(hostId: string | null): void {
  const remoteDaemon: AppConfig['remoteDaemon'] = {
    ...createDefaultRemoteDaemonConfig(),
    client: {
      computers: [{ id: 'mini', label: 'tylers-mac-mini', routes: [{ id: 'public:https://mini.example', kind: 'public', source: 'manual', baseUrl: 'https://mini.example', token: 't' }] }],
      profiles: [], activeProfileId: hostId, mode: hostId ? 'remote' : 'local',
    },
  };
  // SAFETY: the to-do and navigation stores read only these two settings off the config.
  useConfigStore.setState({ config: { remoteDaemon, todosEnabled: true } as AppConfig });
}

interface Pending<Value> { host: Host; kind: string; answer: (value: Value) => void }

/**
 * The desktop's to-do API (`hostIsHere`, as the preload's is in remote mode too). A read goes to `route`, the host
 * main sends it to; just after a switch that can still be the computer the window left. Every read waits in `pending`.
 */
function installHosts() {
  let route: Host = 'here';
  const pending: Array<Pending<() => void>> = [];
  const detailRead = vi.fn((number: number) => {
    const from = route;
    return new Promise<TodosAnswer<TodoDetail>>((resolve) => {
      pending.push({ host: from, kind: 'detail', answer: () => resolve(number === 5 ? { success: true, data: detail(from) } : { success: false, error: 'none' }) });
    });
  });
  const snapshotRead = vi.fn(() => {
    const from = route;
    return new Promise<TodosAnswer<TodosSnapshot>>((resolve) => {
      pending.push({ host: from, kind: 'snapshot', answer: () => resolve({ success: true, data: list(from) }) });
    });
  });
  const api: TodosApi = {
    snapshot: snapshotRead,
    detail: detailRead,
    create: async () => ({ success: false, error: 'unused' }),
    act: async () => ({ success: false, error: 'unused' }),
    onChanged: () => () => undefined,
    readDoc: () => Promise.reject(new Error('unused')),
    openUrl: () => undefined,
    hostIsHere: true,
  };
  installTodosApi(api);
  /** Answers every read waiting on `host` (any host when absent), in the order they were made. */
  const answer = async (host?: Host, kind?: string) => {
    for (const read of pending.filter(candidate => (host === undefined || candidate.host === host) && (kind === undefined || candidate.kind === kind))) {
      pending.splice(pending.indexOf(read), 1);
      read.answer(() => undefined);
    }
    // Let the store's awaits after each answer run.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  };
  /**
   * Answers `host`'s reads until `work` settles (review F-5): a switch can make a further read after one is answered,
   * and each is answered here rather than left to time out, so the test then checks what the answers did.
   */
  const settle = async (work: Promise<void>, host?: Host) => {
    let done = false;
    void work.then(() => { done = true; }, () => { done = true; });
    for (let round = 0; round < 20 && !done; round += 1) await answer(host);
    await work;
  };
  return {
    detailRead,
    pending,
    answer,
    settle,
    /** Main now sends reads to `host`. */
    routeTo: (host: Host) => { route = host; },
    /** The window switches: its settings name `host`, then the to-do screens reread. Not awaited: the test answers the reads. */
    switchTo: (host: Host, routed = true): Promise<void> => {
      if (routed) route = host;
      configure(host === 'mini' ? 'mini' : null);
      return switchTodosHost();
    },
  };
}

const titles = () => [...useTodosStore.getState().details.values()].map(page => page.todo.title);
const listTitles = () => useTodosStore.getState().snapshot?.rows.map(entry => entry.todo.title) ?? [];

const MACHINES: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: INSTALL.here },
  { id: 'mini', label: 'tylers-mac-mini', kind: 'remote', status: 'online', offlineSince: null, installId: INSTALL.mini },
];

beforeEach(() => {
  resetTodos();
  configure(null);
  useTodosStore.setState({ machines: [], remote: {}, installIds: {} });
  useNavigationStore.setState({ activeView: 'sessions', todosReturn: null, selectedTodo: null });
});

afterEach(() => {
  installTodosApi(null);
  useAllMachinesStore.setState({ entries: [], switchMachine: null });
});

describe('a to-do page across a computer switch (T-51 test 7, W8)', () => {
  it('closes this computer\'s T-5 when the window switches to the mini, and never shows it as the mini\'s T-5', async () => {
    const hosts = installHosts();
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    expect(useNavigationStore.getState().selectedTodo).toEqual({ machineId: 'local', number: 5 });
    const stop = useTodosStore.getState().watch(5);
    await hosts.answer();
    expect(titles()).toEqual(['Invoice PDFs']);

    await hosts.settle(hosts.switchTo('mini'));
    // The page closed; nothing read the mini's T-5 for it.
    expect(useNavigationStore.getState().selectedTodo).toBeNull();
    expect(useNavigationStore.getState().activeView).toBe('todos');
    expect(hosts.detailRead).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual([]);
    stop();
  });

  // Review F-5: the old computer's answer is delivered after the switch, and the test checks what happened to it.
  it('drops a read of this computer\'s T-5 that answers after the switch to the mini', async () => {
    const hosts = installHosts();
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    const stop = useTodosStore.getState().watch(5);
    expect(hosts.pending.map(read => `${read.host}:${read.kind}`)).toEqual(['here:detail']);
    // The mini answers whatever the switch asks it; the still-open page's T-5 is this computer's.
    await hosts.settle(hosts.switchTo('mini'), 'mini');
    // Now this computer's T-5 answers, late.
    await hosts.answer('here');
    expect(hosts.pending).toEqual([]);
    expect(titles()).not.toContain('Invoice PDFs');
    expect(titles()).toEqual([]);
    stop();
  });

  it('back on this computer, its T-5 is its own again, whatever the mini answered meanwhile', async () => {
    const hosts = installHosts();
    await hosts.settle(hosts.switchTo('mini'));
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    const stop = useTodosStore.getState().watch(5);
    expect(hosts.pending.map(read => `${read.host}:${read.kind}`)).toEqual(['mini:detail']);
    await hosts.settle(hosts.switchTo('here'), 'here');
    expect(useNavigationStore.getState().selectedTodo).toBeNull();
    useTodosStore.getState().watch(5);
    await hosts.answer('here');
    // The mini's T-5 answers last.
    await hosts.answer('mini');
    expect(titles()).toEqual(['Invoice PDFs']);
    stop();
  });
});

describe('the list just after a switch (review F-1)', () => {
  it('a list that still comes from this computer is never taken as the mini\'s, and the mini\'s replaces it once it answers', async () => {
    const hosts = installHosts();
    useTodosStore.getState().setMachines(MACHINES);
    const home = useTodosStore.getState().refresh();
    await hosts.answer();
    await home;
    expect(listTitles()).toEqual(['Invoice PDFs']);

    // The window's settings name the mini, but main still sends this read to this computer.
    await hosts.settle(hosts.switchTo('mini', false), 'here');
    expect(listTitles()).toEqual([]);
    expect(useTodosStore.getState().snapshotMachine).toBeNull();

    // Main now reaches the mini; the list reads again on its own.
    hosts.routeTo('mini');
    await vi.waitFor(() => expect(hosts.pending.map(read => `${read.host}:${read.kind}`)).toContain('mini:snapshot'), { timeout: 3_000 });
    await hosts.answer('mini');
    expect(listTitles()).toEqual(['Receipts export']);
    expect(useTodosStore.getState().snapshotMachine).toBe('mini');
  });
});

describe('the mini\'s page, read while the window shows it (review F-2)', () => {
  it('names the mini by its saved name, never "This Mac"', async () => {
    const hosts = installHosts();
    await hosts.settle(hosts.switchTo('mini'));
    useTodosStore.getState().watch(5);
    await hosts.answer();
    const page = [...useTodosStore.getState().details.values()][0];
    expect(page?.todo.title).toBe('Receipts export');
    expect(page?.machine).toBe('tylers-mac-mini');
    expect(listTitles()).toEqual(['Receipts export']);
    expect(useTodosStore.getState().snapshot?.rows[0]?.machine).toBe('tylers-mac-mini');
  });

  it('this computer\'s page still reads "This Mac"', async () => {
    const hosts = installHosts();
    useTodosStore.getState().watch(5);
    await hosts.answer();
    expect([...useTodosStore.getState().details.values()][0]?.machine).toMatch(/^This (Mac|computer)$/);
  });
});

describe('"Open its Session" while the window shows the mini (T-51 W10)', () => {
  it('opens the mini\'s Session on the mini, never this computer with the mini\'s Session id', async () => {
    // The machine menu as the sidebar fills it: the window shows the mini.
    const switchMachine = vi.fn(async () => ({ ok: true as const }));
    useAllMachinesStore.setState({
      entries: [{ id: 'local', name: 'This Mac', os: null, slot: 0, letters: 'TM', active: false }, { id: 'mini', name: 'tylers-mac-mini', os: null, slot: 1, letters: 'TM', active: true }],
      switchMachine,
    });
    const hosts = installHosts();
    await hosts.settle(hosts.switchTo('mini'));
    useTodosStore.getState().watch(5);
    await hosts.answer();
    const page = [...useTodosStore.getState().details.values()][0];
    expect(page?.todo.title).toBe('Receipts export');
    if (!page) return;
    openTodoSession(page);
    // Opened here, on the mini: the window is not switched back to this computer.
    await vi.waitFor(() => expect(useNavigationStore.getState().activeView).toBe('pane-chat'));
    expect(switchMachine).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().todoSessionOrigin).toEqual({ machineId: 'mini', sessionId: 'mini-receipts', number: 5 });
  });
});
