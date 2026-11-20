import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import type { TodosSnapshot } from '../../../shared/types/todos';
import { notifyFixture } from '../../../tests/fixtures/notifySnapshot';
import { SETTINGS_CATEGORIES, matchSettingsCategories } from '../components/settings/catalog';
import { isTodosEnabled, useConfigStore } from './configStore';
import { useNavigationStore } from './navigationStore';
import { subscribeNotify, useNotifyStore } from './notifyStore';
import { installTodosApi, resetTodos, todosEnabledNow, useTodosStore, type TodosAnswer, type TodosApi } from './todosStore';

/** To-dos behind one switch, off by default (T-39). */

const SNAPSHOT: TodosSnapshot = { rows: [], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: ['session-t12'] };

const linked: NotifyItem = {
  id: 'review-12', ui: 'approve', title: 'Review T-12', state: 'waiting', createdAt: 1,
  source: { name: 'orchestrator', agent: 'Claude' }, todo: { number: 12, title: 'Invoice PDFs', kind: 'review' },
};

function turnTodos(on: boolean | undefined): void {
  useConfigStore.setState({ config: on === undefined ? {} : { todosEnabled: on } });
}

function stubDesktop(snapshot: () => Promise<TodosAnswer<TodosSnapshot>>) {
  const notifySnapshot: NotifySnapshot = { ...notifyFixture(), items: [linked] };
  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    electronAPI: {
      todos: { snapshot, detail: vi.fn(), create: vi.fn(), act: vi.fn() },
      events: { onTodosChanged: () => () => undefined },
      notify: { run: vi.fn(), onSnapshot: () => () => undefined, getSnapshot: async () => notifySnapshot },
    },
  });
}

beforeEach(() => {
  resetTodos();
  useConfigStore.setState({ config: null });
  useNavigationStore.setState({ activeView: 'sessions', todosReturn: null, selectedTodoNumber: null });
});

afterEach(() => {
  installTodosApi(null);
  vi.unstubAllGlobals();
});

describe('the To-dos switch', () => {
  it('is off unless the settings turn it on', () => {
    expect(isTodosEnabled(null)).toBe(false);
    expect(isTodosEnabled({})).toBe(false);
    expect(isTodosEnabled({ todosEnabled: false })).toBe(false);
    expect(isTodosEnabled({ todosEnabled: true })).toBe(true);
  });

  it('lives under Settings › Advanced, found by its name', () => {
    expect(SETTINGS_CATEGORIES.find(category => category.id === 'advanced')?.settingIds).toContain('todos');
    expect(matchSettingsCategories(SETTINGS_CATEGORIES, 'to-dos').map(category => category.id)).toContain('advanced');
  });
});

describe('the desktop with To-dos off', () => {
  it('reads no to-dos, and reads them once it is turned on', async () => {
    const snapshot = vi.fn(async () => ({ success: true, data: SNAPSHOT }));
    stubDesktop(snapshot);
    turnTodos(false);
    await useTodosStore.getState().refresh();
    expect(snapshot).not.toHaveBeenCalled();
    expect(useTodosStore.getState().snapshot).toBeNull();
    expect(todosEnabledNow()).toBe(false);

    turnTodos(true);
    await useTodosStore.getState().refresh();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(useTodosStore.getState().snapshot?.ownSessionIds).toEqual(['session-t12']);
    expect(todosEnabledNow()).toBe(true);
  });

  it('opens no To-dos view, and opens it once it is turned on', () => {
    turnTodos(false);
    useNavigationStore.getState().navigateToTodos({ number: 12 });
    expect(useNavigationStore.getState().activeView).toBe('sessions');

    turnTodos(true);
    useNavigationStore.getState().navigateToTodos({ number: 12 });
    expect(useNavigationStore.getState().activeView).toBe('todos');
    expect(useNavigationStore.getState().selectedTodoNumber).toBe(12);
  });

  it('shows approvals without their to-do, and puts it back when turned on', async () => {
    stubDesktop(async () => ({ success: true, data: SNAPSHOT }));
    turnTodos(false);
    subscribeNotify();
    await vi.waitFor(() => expect(useNotifyStore.getState().snapshot?.items).toHaveLength(1));
    expect(useNotifyStore.getState().snapshot?.items[0].todo).toBeUndefined();

    turnTodos(true);
    expect(useNotifyStore.getState().snapshot?.items[0].todo).toEqual({ number: 12, title: 'Invoice PDFs', kind: 'review' });
  });
});

describe('the web app on a host with To-dos off', () => {
  it('forgets the to-dos it showed once the host refuses them', async () => {
    let answer: TodosAnswer<TodosSnapshot> = { success: true, data: SNAPSHOT };
    const api: TodosApi = {
      snapshot: async () => answer,
      detail: async () => ({ success: false, error: 'unused' }),
      create: async () => ({ success: false, error: 'unused' }),
      act: async () => ({ success: false, error: 'unused' }),
      onChanged: () => () => undefined,
      readDoc: () => Promise.reject(new Error('unused')),
      openUrl: () => undefined,
      hostIsHere: false,
    };
    installTodosApi(api);
    await useTodosStore.getState().refresh();
    expect(todosEnabledNow()).toBe(true);

    answer = { success: false, error: 'To-dos is turned off in this Pane, so nothing was read or changed. Saved to-dos are kept. Turn it on in Settings > Advanced > Experimental > To-dos, then run this again.' };
    await useTodosStore.getState().refresh();
    expect(useTodosStore.getState().snapshot).toBeNull();
    expect(useTodosStore.getState().hostTodosOff).toBe(true);
    expect(todosEnabledNow()).toBe(false);

    // Turned back on, the next read shows them again.
    answer = { success: true, data: SNAPSHOT };
    await useTodosStore.getState().refresh();
    expect(useTodosStore.getState().hostTodosOff).toBe(false);
    expect(useTodosStore.getState().snapshot).not.toBeNull();
  });

  it('keeps the to-dos it showed through any other failed read', async () => {
    let answer: TodosAnswer<TodosSnapshot> = { success: true, data: SNAPSHOT };
    installTodosApi({
      snapshot: async () => answer,
      detail: async () => ({ success: false, error: 'unused' }),
      create: async () => ({ success: false, error: 'unused' }),
      act: async () => ({ success: false, error: 'unused' }),
      onChanged: () => () => undefined,
      readDoc: () => Promise.reject(new Error('unused')),
      openUrl: () => undefined,
      hostIsHere: false,
    });
    await useTodosStore.getState().refresh();
    answer = { success: false, error: 'The host is restarting.' };
    await useTodosStore.getState().refresh();
    expect(useTodosStore.getState().snapshot).not.toBeNull();
  });
});
