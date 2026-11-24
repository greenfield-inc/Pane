import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import type { MachineState } from '../../../shared/types/machineConnections';
import type { NotifyItem } from '../../../shared/types/notify';
import type { TodoListRow, TodoRecord, TodosSnapshot } from '../../../shared/types/todos';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { todoKey } from '../../../shared/todoKey';
import { useConfigStore } from './configStore';
import { forgetTodos, resetTodos, sessionTodoEntriesNow, sessionTodoScope, useTodosStore } from './todosStore';
import { sessionApprovals } from '../components/approvals/approvalCard';

/** T-51: a Session's approval scope reads the rows of the machine its Session is on, and none once To-dos is off. */

function record(number: number, opts: { sessionId?: string; requestedBy?: string; parent?: number }): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: opts.sessionId ?? null, parentNumber: opts.parent ?? null, title: `To-do ${number}`, summary: '', doneWhen: [],
    state: 'in_progress', requester: opts.requestedBy ? { kind: 'orchestrator', name: 'o', sessionId: opts.requestedBy, panelId: 'p' } : { kind: 'person', name: 'you' },
    projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: 0, startedAt: null, updatedAt: 0, acceptedAt: null, closedAt: null, lastProgressAt: null,
    stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null,
    loadOverride: null, stuckCardId: null,
  };
}
const row = (todo: TodoRecord): TodoListRow => ({ todo, status: { status: 'working', reason: '' }, machine: 'm' });
const snapshotOf = (machine: string, rows: TodoListRow[]): TodosSnapshot => ({ rows, gate: { state: 'normal', enabled: true, since: 0 }, machine, ownSessionIds: [] });

/** The desktop's Firecracker Grain owns T-27 (hidden Session) → T-28; the MacBook's Workspaces owns its own T-28. */
const desktopTodos = snapshotOf('tylers-mac-mini', [row(record(27, { sessionId: 'hidden-27', requestedBy: 'firecracker' })), row(record(28, { parent: 27, requestedBy: 'firecracker' }))]);
const macbookTodos = snapshotOf('Tylers-MacBook-Pro', [row(record(28, { sessionId: 'hidden-28', requestedBy: 'workspaces' }))]);
const macbook: MachineState = { id: 'macbook', label: 'tylers-macbook-pro', kind: 'remote', status: 'online', offlineSince: null, installId: 'mbp' };
const local: MachineState = { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: 'mini' };

/** The window shows `hostId` (null: this computer), with To-dos on or off. */
function configure(hostId: string | null, todosEnabled = true): void {
  const remoteDaemon: AppConfig['remoteDaemon'] = {
    ...createDefaultRemoteDaemonConfig(),
    client: {
      computers: [{ id: 'macbook', label: 'tylers-macbook-pro', routes: [{ id: 'public:https://mbp.example', kind: 'public', source: 'manual', baseUrl: 'https://mbp.example', token: 't' }] }],
      profiles: [], activeProfileId: hostId, mode: hostId ? 'remote' : 'local',
    },
  };
  // SAFETY: the to-do store reads only these two settings off the config.
  useConfigStore.setState({ config: { remoteDaemon, todosEnabled } as AppConfig });
}

/** `machines.read` stand-in: each read waits until the test answers it. */
function stubReads() {
  type Answer = { success: boolean; data?: TodosSnapshot };
  const pending: Array<{ machineId: string; answer: (data: Answer) => void }> = [];
  const read = vi.fn((machineId: string) => new Promise<{ machineId: string; data: Answer }>((resolve) => {
    pending.push({ machineId, answer: (data) => resolve({ machineId, data }) });
  }));
  vi.stubGlobal('window', { electronAPI: { machines: { read } } });
  return { pending, read };
}

const card = (id: string, extra: Partial<NotifyItem>): NotifyItem => ({ id, ui: 'options', title: id, state: 'waiting', createdAt: 1, source: { name: 'agent', agent: 'Claude' }, ...extra });

beforeEach(() => {
  resetTodos();
  useTodosStore.setState({ desktop: null, remote: {}, machines: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useConfigStore.setState({ config: null });
});

describe('All machines while the window shows the MacBook (review F-1)', () => {
  it('a desktop Session\'s scope reads the desktop\'s own to-dos, and the MacBook\'s reads the MacBook\'s', async () => {
    const { pending } = stubReads();
    configure('macbook');
    useTodosStore.setState({ snapshot: macbookTodos });
    useTodosStore.getState().setMachines([local, macbook]);
    const reading = useTodosStore.getState().refreshRemote();
    for (const read of pending) read.answer({ success: true, data: read.machineId === 'local' ? desktopTodos : macbookTodos });
    await reading;
    await vi.waitFor(() => expect(useTodosStore.getState().desktop).not.toBeNull());

    const desktop = sessionTodoScope('firecracker', 'local');
    expect(desktop.machineId).toBe('local');
    expect([...desktop.todoKeys]).toEqual([todoKey('local', 27), todoKey('local', 28)]);
    // A permission prompt from T-27's hidden Session counts on Firecracker Grain's row.
    expect(sessionApprovals([card('perm', { machineId: 'local', source: { name: 'T-27', agent: 'Claude', session: { id: 'hidden-27', name: 'T-27', paneId: 'h' } } })], 'firecracker', desktop).map(item => item.id)).toEqual(['perm']);

    const shown = sessionTodoScope('workspaces');
    expect(shown.machineId).toBe('macbook');
    expect([...shown.todoKeys]).toEqual([todoKey('macbook', 28)]);
  });
});

describe('To-dos turned off while a saved machine\'s read is in flight (review F-4)', () => {
  it('the late read lands nowhere, and no to-do brings the MacBook\'s hidden-Session card into its Session', async () => {
    const { pending } = stubReads();
    configure(null);
    useTodosStore.getState().setMachines([local, macbook]);
    const reading = useTodosStore.getState().refreshRemote();

    configure(null, false);
    forgetTodos();
    for (const read of pending) read.answer({ success: true, data: macbookTodos });
    await reading;

    expect(useTodosStore.getState().remote.macbook?.snapshot).toBeNull();
    const scope = sessionTodoScope('workspaces', 'macbook');
    expect(scope).toMatchObject({ machineId: 'macbook' });
    expect(scope.todoKeys.size + scope.sessionIds.size).toBe(0);
    const permission = card('perm', { machineId: 'macbook', source: { name: 'T-28', agent: 'Claude', session: { id: 'hidden-28', name: 'T-28', paneId: 'h' } } });
    expect(sessionApprovals([permission], 'workspaces', scope)).toEqual([]);
  });

  it('with the store still holding a machine\'s rows, the scope is empty while To-dos is off', () => {
    configure(null, false);
    useTodosStore.setState({ remote: { macbook: { machineId: 'macbook', label: 'tylers-macbook-pro', snapshot: macbookTodos, offline: false } } });
    expect(sessionTodoScope('workspaces', 'macbook').sessionIds.size).toBe(0);
  });
});

describe('a Session\'s rows and its approvals name the same machine (review F-6)', () => {
  it('with the window on the MacBook, its Session\'s rows key as the MacBook\'s, as its scope does', () => {
    configure('macbook');
    useTodosStore.setState({ snapshot: macbookTodos });
    const keys = (sessionTodoEntriesNow('workspaces') ?? []).map(entry => entry.key);
    expect(keys).toEqual([todoKey('macbook', 28)]);
    expect(new Set(keys)).toEqual(sessionTodoScope('workspaces').todoKeys);
  });
});
