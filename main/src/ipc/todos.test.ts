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
    expect(shown).toMatchObject({ ok: true, attachments: [{ target: '/plans/plan.html', from: null, kind: 'doc' }], subTodos: [{ ref: 'T-2', parent: 'T-1' }] });
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
});
