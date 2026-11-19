import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneCommandRegistry, type IpcMainHandleLike } from '../daemon/commandRegistry';
import { TodoService } from '../services/todos/todoService';
import { TodoStore } from '../services/todos/todoStore';
import { FakeHost } from '../services/todos/todoTestHost';
import { RUNPANE_TODO_VERBS } from '../../../shared/types/todos';
import { TODO_APP_CHANNELS, registerTodoHandlers, type TodoHandlerServices } from './todos';

interface IpcStub extends IpcMainHandleLike {
  bound: string[];
}

function ipcMainStub(): IpcStub {
  const bound: string[] = [];
  return { bound, handle: (channel: string) => { bound.push(channel); } };
}

describe('to-do channels', () => {
  let db: Database.Database;
  let host: FakeHost;
  let registry: PaneCommandRegistry;
  let ipcMain: IpcStub;
  let service: TodoService;

  beforeEach(() => {
    db = new Database(':memory:');
    host = new FakeHost();
    const todoService = new TodoService(new TodoStore(db), host, () => 1_000);
    service = todoService;
    registry = new PaneCommandRegistry();
    ipcMain = ipcMainStub();
    // SAFETY: projectIdOf reads only a project's id and name.
    const projects = [{ id: 4, name: 'Pane' }] as ReturnType<TodoHandlerServices['databaseService']['getAllProjects']>;
    registerTodoHandlers(ipcMain, { todoService, databaseService: { getAllProjects: () => projects } }, registry);
  });
  afterEach(() => db.close());

  it('binds the app channels and a runpane channel for every todos verb', () => {
    expect(ipcMain.bound.sort()).toEqual([...TODO_APP_CHANNELS].sort());
    for (const verb of RUNPANE_TODO_VERBS) expect(registry.listChannels()).toContain(`runpane:todos:${verb}`);
  });

  it('creates a to-do for an agent, with its repo, a sub-to-do, attachments listed first in show', async () => {
    host.addRequester();
    const created = await registry.invoke('runpane:todos:create', [{ title: 'Invoices', project: 'Pane', doneWhen: ['PDF renders'], attach: ['/plans/plan.html'], callerPanelId: 'tA' }]);
    expect(created).toMatchObject({ ok: true, todo: { ref: 'T-1', state: 'in_progress', requester: 'Billing rewrite orchestrator', attachmentCount: 1 } });
    await registry.invoke('runpane:todos:create', [{ title: 'Sub', parent: 'T-1', callerPanelId: 's1-orch' }]);
    const shown = await registry.invoke('runpane:todos:show', [{ todo: 'T-1' }]);
    expect(shown).toMatchObject({ ok: true, attachments: [{ target: '/plans/plan.html', from: null, kind: 'plan' }], subTodos: [{ ref: 'T-2', parent: 'T-1' }] });
  });

  it('refuses an agent marking an unaccepted to-do done, with what, why and next', async () => {
    await registry.invoke('runpane:todos:create', [{ title: 'Ship', callerPanelId: 'x' }]);
    await expect(registry.invoke('runpane:todos:done', [{ todo: 'T-1', callerPanelId: 's1-orch' }])).rejects.toMatchObject({ code: 'ERR_TODO_DONE_NEEDS_REVIEW' });
    await expect(registry.invoke('runpane:todos:show', [{ todo: 'T-9' }])).rejects.toMatchObject({ code: 'ERR_TODO_NOT_FOUND' });
    await expect(registry.invoke('runpane:todos:create', [{ title: 'X', project: 'Nope' }])).rejects.toMatchObject({ code: 'ERR_TODO_REPO' });
  });

  it('lets the person mark done from the app, and answers the snapshot', async () => {
    const created = await registry.invoke('todos:create', [{ title: 'Mine', startNow: false }]);
    expect(created).toMatchObject({ success: true, data: { ref: 'T-1', state: 'todo' } });
    expect(await registry.invoke('todos:act', [{ kind: 'done', number: 1 }])).toMatchObject({ success: true, data: { todo: { state: 'done' } } });
    expect(await registry.invoke('todos:snapshot', [])).toMatchObject({ success: true, data: { rows: [{ todo: { ref: 'T-1' }, status: { status: 'done' } }] } });
    expect(await registry.invoke('todos:act', [{ kind: 'bogus', number: 1 }])).toMatchObject({ success: false });
  });

  it('takes a reply from the app and refuses one aimed at another to-do’s row (R18)', async () => {
    await registry.invoke('todos:create', [{ title: 'One' }]);
    await registry.invoke('todos:create', [{ title: 'Two' }]);
    await registry.invoke('runpane:todos:comment', [{ todo: 'T-2', body: 'from two', callerPanelId: 's2-orch' }]);
    expect(await registry.invoke('todos:act', [{ kind: 'comment', number: 1, body: 'first' }])).toMatchObject({ success: true });
    const activity = (todo: number) => service.detail(todo).activity;
    const mine = activity(1).find(row => row.body === 'first')!;
    expect(await registry.invoke('todos:act', [{ kind: 'comment', number: 1, body: 'a reply', replyTo: mine.id }])).toMatchObject({ success: true });
    expect(activity(1).find(row => row.body === 'a reply')).toMatchObject({ replyTo: mine.id });
    const theirs = activity(2).find(row => row.body === 'from two')!;
    expect(await registry.invoke('todos:act', [{ kind: 'comment', number: 1, body: 'x', replyTo: theirs.id }])).toMatchObject({ success: false, error: expect.stringContaining('isn’t on T-1') });
  });

  describe('snoozing (round 9)', () => {
    // The service's clock reads 1 s past the epoch.
    const until = 1_000 + 3_600_000;

    it('snoozes and wakes from the app, and Remind me… creates a to-do snoozed, not started', async () => {
      await registry.invoke('todos:create', [{ title: 'Mine' }]);
      expect(await registry.invoke('todos:act', [{ kind: 'snooze', number: 1, until, zone: 'Europe/London', note: 'check', action: 'agents' }]))
        .toMatchObject({ success: true, data: { todo: { state: 'stopped', snooze: { until, zone: 'Europe/London', note: 'check', action: 'agents', by: 'you' } } } });
      expect(await registry.invoke('todos:act', [{ kind: 'wake', number: 1 }])).toMatchObject({ success: true, data: { todo: { state: 'in_progress' } } });
      expect(await registry.invoke('todos:create', [{ title: 'Call Northwind', snooze: { until, zone: 'Europe/London', note: 'did they reply?' } }]))
        .toMatchObject({ success: true, data: { state: 'stopped', sessionId: null, snooze: { action: 'remind', from: 'todo', note: 'did they reply?' } } });
      expect(await registry.invoke('todos:act', [{ kind: 'snooze', number: 1, until: 1, zone: 'UTC' }])).toMatchObject({ success: false, error: expect.stringContaining('already passed') });
    });

    it('runpane todos snooze, list --status snoozed and wake, with the calling tab as the snoozer', async () => {
      await registry.invoke('runpane:todos:create', [{ title: 'Ship', callerPanelId: 'x' }]);
      await registry.invoke('runpane:todos:create', [{ title: 'Other', callerPanelId: 'x' }]);
      expect(await registry.invoke('runpane:todos:snooze', [{ todo: 'T-1', until, zone: 'UTC', note: 'check Sentry', callerPanelId: 's1-orch' }])).toMatchObject({
        ok: true, todo: { ref: 'T-1', state: 'stopped', status: 'snoozed', snooze: { until: '1970-01-01T01:00:01+00:00', zone: 'UTC', note: 'check Sentry', action: 'agents', by: 'orchestrator' } },
      });
      expect(await registry.invoke('runpane:todos:snooze', [{ todo: 'T-2', until: until + 60_000, zone: 'UTC', remindMe: true, callerPanelId: 's2-orch' }]))
        .toMatchObject({ ok: true, todo: { snooze: { action: 'remind', note: '' } } });
      const listed = await registry.invoke('runpane:todos:list', [{ status: 'snoozed' }]);
      expect(listed).toMatchObject({ ok: true, todos: [{ ref: 'T-1' }, { ref: 'T-2' }] });
      expect(await registry.invoke('runpane:todos:list', [{ status: 'working' }])).toEqual({ ok: true, todos: [] });
      const woken = await registry.invoke('runpane:todos:wake', [{ todo: 'T-1', callerPanelId: 's1-orch' }]);
      expect(woken).toMatchObject({ ok: true, todo: { ref: 'T-1', state: 'in_progress' } });
      expect(woken).not.toHaveProperty('todo.snooze');
      await expect(registry.invoke('runpane:todos:snooze', [{ todo: 'T-1', until: 1, zone: 'UTC' }])).rejects.toMatchObject({ code: 'todo_snooze_past', next: expect.any(String) });
    });
  });
});

