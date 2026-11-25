import { afterEach, describe, expect, it } from 'vitest';
import type { TodoDetail, TodoRecord } from '../../../shared/types/todos';
import { installTodosApi, useTodosStore, type TodosApi, type TodosAnswer } from './todosStore';
import { todoKey } from '../../../shared/todoKey';

/** A detail answer the test settles by hand, so two reads can finish out of order. */
function deferred() {
  let settle: (value: TodosAnswer<TodoDetail>) => void = () => undefined;
  const promise = new Promise<TodosAnswer<TodoDetail>>((resolve) => { settle = resolve; });
  return { promise, settle };
}

function detail(title: string): TodoDetail {
  const todo: TodoRecord = {
    number: 12, ref: 'T-12', sessionId: null, parentNumber: null, title, summary: '', doneWhen: [], state: 'todo',
    requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: 1, startedAt: null,
    updatedAt: 1, acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  return {
    todo, status: { status: 'idle', reason: '' }, machine: 'devbox', subTodos: [], attachments: [], activity: [], approvalIds: [],
    chatTarget: { panelId: null, name: 'orchestrator', kind: 'orchestrator' }, load: { gate: 'normal', canPause: false }, keepMoving: '',
  };
}

afterEach(() => installTodosApi(null));

describe('loadDetail', () => {
  it('keeps the newest read of a to-do when an older one answers last', async () => {
    const reads = [deferred(), deferred()];
    let call = 0;
    const api: TodosApi = {
      snapshot: () => Promise.resolve({ success: false, error: 'unused' }),
      detail: () => reads[call++].promise,
      create: () => Promise.resolve({ success: false, error: 'unused' }),
      act: () => Promise.resolve({ success: false, error: 'unused' }),
      onChanged: () => () => undefined,
      readDoc: () => Promise.reject(new Error('unused')),
      openUrl: () => undefined,
      hostIsHere: false,
    };
    installTodosApi(api);
    const older = useTodosStore.getState().loadDetail(12);
    const newer = useTodosStore.getState().loadDetail(12);
    reads[1].settle({ success: true, data: detail('with the dropped file') });
    await newer;
    reads[0].settle({ success: true, data: detail('before the drop') });
    await older;
    expect(useTodosStore.getState().details.get(todoKey('local', 12))?.todo.title).toBe('with the dropped file');
  });
});
