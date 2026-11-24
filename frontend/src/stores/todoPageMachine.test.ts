import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { TodoDetail, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { todoKey } from '../../../shared/todoKey';
import { useConfigStore } from './configStore';
import { useNavigationStore } from './navigationStore';
import { installTodosApi, resetTodos, switchTodosHost, todoDetailNow, useTodosStore, type TodosAnswer, type TodosApi } from './todosStore';
import { openTodoSession } from '../components/todos/page/todoNavigation';
import { useAllMachinesStore } from './allMachinesStore';

/**
 * T-51 PR 3 (W8, W10): this computer and the saved machine "mini" each have a T-5, and they are different to-dos.
 * The open page, the reads behind it and "Open its Session" belong to the machine the page was read from.
 */

function detail(title: string, sessionId: string | null): TodoDetail {
  const todo: TodoRecord = {
    number: 5, ref: 'T-5', sessionId, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: 1, startedAt: null,
    updatedAt: 1, acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  return {
    todo, status: { status: 'working', reason: '' }, machine: 'host', subTodos: [], attachments: [], activity: [], approvalIds: [],
    chatTarget: { panelId: null, name: 'orchestrator', kind: 'orchestrator' }, load: { gate: 'normal', canPause: false }, keepMoving: '',
  };
}

const HERE_FIVE = detail('Invoice PDFs', 'here-session');
const MINI_FIVE = detail('Receipts export', 'mini-receipts');
const EMPTY: TodosSnapshot = { rows: [], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'host', ownSessionIds: [] };

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

/**
 * The to-do API the window reads through: it answers from whichever computer the window shows when the read
 * is made, as main does. A read waits until the test answers it, so a read can answer after a switch.
 */
function installHosts() {
  let host: 'here' | 'mini' = 'here';
  const pending: Array<{ host: 'here' | 'mini'; answer: () => void }> = [];
  const detailRead = vi.fn((number: number) => {
    const from = host;
    return new Promise<TodosAnswer<TodoDetail>>((resolve) => {
      pending.push({ host: from, answer: () => resolve(number === 5 ? { success: true, data: from === 'here' ? HERE_FIVE : MINI_FIVE } : { success: false, error: 'none' }) });
    });
  });
  const api: TodosApi = {
    snapshot: async () => ({ success: true, data: EMPTY }),
    detail: detailRead,
    create: async () => ({ success: false, error: 'unused' }),
    act: async () => ({ success: false, error: 'unused' }),
    onChanged: () => () => undefined,
    readDoc: () => Promise.reject(new Error('unused')),
    openUrl: () => undefined,
    hostIsHere: false,
  };
  installTodosApi(api);
  const answerAll = async () => {
    for (const read of pending.splice(0)) read.answer();
    await vi.waitFor(() => undefined);
    await Promise.resolve();
  };
  return {
    detailRead,
    pending,
    answerAll,
    switchTo: async (to: 'here' | 'mini') => {
      host = to;
      configure(to === 'mini' ? 'mini' : null);
      await switchTodosHost();
    },
  };
}

beforeEach(() => {
  resetTodos();
  configure(null);
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
    await hosts.answerAll();
    expect(todoDetailNow(5)?.todo.title).toBe('Invoice PDFs');

    await hosts.switchTo('mini');
    // The page closed; the mini's T-5 is another to-do, so nothing read it for that page.
    expect(useNavigationStore.getState().selectedTodo).toBeNull();
    expect(useNavigationStore.getState().activeView).toBe('todos');
    expect(hosts.pending).toHaveLength(0);
    expect(todoDetailNow(5)).toBeUndefined();
    stop();

    // Opened on the mini, T-5 is the mini's, stamped with its machine.
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    expect(useNavigationStore.getState().selectedTodo).toEqual({ machineId: 'mini', number: 5 });
    useTodosStore.getState().watch(5);
    await hosts.answerAll();
    expect(todoDetailNow(5)?.todo.title).toBe('Receipts export');
    expect(useTodosStore.getState().details.get(todoKey('mini', 5))?.machineId).toBe('mini');
    expect(useTodosStore.getState().details.has(todoKey('local', 5))).toBe(false);
  });

  it('drops a read of this computer\'s T-5 that answers after the switch to the mini', async () => {
    const hosts = installHosts();
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    const stop = useTodosStore.getState().watch(5);
    expect(hosts.pending.map(read => read.host)).toEqual(['here']);
    // The window switches while this computer's read is still out.
    const late = hosts.pending.splice(0);
    await hosts.switchTo('mini');
    for (const read of late) read.answer();
    await hosts.answerAll();
    expect(todoDetailNow(5)).toBeUndefined();
    expect([...useTodosStore.getState().details.values()].map(page => page.todo.title)).toEqual([]);
    stop();
  });

  it('back on this computer, its T-5 is its own again, whatever the mini answered meanwhile', async () => {
    const hosts = installHosts();
    await hosts.switchTo('mini');
    useNavigationStore.getState().navigateToTodos({ number: 5 });
    const stop = useTodosStore.getState().watch(5);
    const late = hosts.pending.splice(0);
    await hosts.switchTo('here');
    expect(useNavigationStore.getState().selectedTodo).toBeNull();
    useTodosStore.getState().watch(5);
    for (const read of late) read.answer();
    await hosts.answerAll();
    expect(todoDetailNow(5)?.todo.title).toBe('Invoice PDFs');
    stop();
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
    await hosts.switchTo('mini');
    useTodosStore.getState().watch(5);
    await hosts.answerAll();
    const page = todoDetailNow(5);
    expect(page?.todo.title).toBe('Receipts export');
    if (!page) return;
    openTodoSession(page);
    // Opened here, on the mini: the window is not switched back to this computer.
    await vi.waitFor(() => expect(useNavigationStore.getState().activeView).toBe('pane-chat'));
    expect(switchMachine).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().todoSessionOrigin).toEqual({ sessionId: 'mini-receipts', number: 5 });
  });
});
