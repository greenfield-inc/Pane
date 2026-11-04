import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
// SAFETY: Selection tests need only record id and name; no record content is rendered.
const sessions = ['a', 'b'].map(id => ({ id, name: id.toUpperCase() } as OrchestrationSessionRecord));
const reply = (id: string) => ({ success: true, data: { sessions, selectedSessionId: id } });
const select = vi.fn();
const list = vi.fn();
async function setup() {
  vi.resetModules();
  vi.stubGlobal('window', { electronAPI: { orchestrationSessions: { select, list } } });
  const { useOrchestrationSessionStore: store } = await import('./orchestrationSessionStore');
  store.setState({ sessions, selectedSessionId: 'a', availability: 'ready' });
  return store;
}
beforeEach(() => { vi.clearAllMocks(); });

it('does not acknowledge required restoration when a newer Session refresh is still pending', async () => {
  const first = deferred<ReturnType<typeof reply>>();
  const newer = deferred<ReturnType<typeof reply>>();
  list.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise);
  const store = await setup();
  const required = store.getState().refresh({ throwOnError: true });
  const rejection = expect(required).rejects.toThrow('Session list changed during restoration');
  const background = store.getState().refresh();
  first.resolve(reply('a'));
  await rejection;
  newer.resolve(reply('b'));
  await background;
});

describe('Session intent ownership', () => {
  it('selects B immediately and ignores late A replies', async () => {
    const a = deferred<ReturnType<typeof reply>>();
    const b = deferred<ReturnType<typeof reply>>();
    select.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const store = await setup();
    const first = store.getState().select({ sessionId: 'a' });
    const last = store.getState().select({ sessionId: 'b' });
    expect(store.getState().selectedSessionId).toBe('b');
    b.resolve(reply('b')); await last;
    a.resolve(reply('a')); await first;
    expect(store.getState().selectedSessionId).toBe('b');
  });
});

it.each([true, false])('stale selected-event refresh cannot replace B (ack first: %s)', async ackFirst => {
  const selection = deferred<ReturnType<typeof reply>>();
  const snapshot = deferred<ReturnType<typeof reply>>();
  select.mockReturnValue(selection.promise);
  list.mockReturnValue(snapshot.promise);
  const store = await setup();
  const selecting = store.getState().select({ sessionId: 'b' });
  const refreshing = store.getState().refresh({ adoptServerSelection: true });
  if (ackFirst) { selection.resolve(reply('b')); await selecting; }
  snapshot.resolve(reply('a')); await refreshing;
  expect(store.getState().selectedSessionId).toBe('b');
  if (!ackFirst) { selection.resolve(reply('b')); await selecting; }
  // Another client selecting A later does not move this desktop either.
  list.mockResolvedValue(reply('a'));
  await store.getState().refresh({ adoptServerSelection: true });
  expect(store.getState().selectedSessionId).toBe('b');
});

it('invalidates outgoing-host requests even when Session ids collide', async () => {
  const old = deferred<ReturnType<typeof reply>>();
  select.mockReturnValue(old.promise);
  const store = await setup();
  const selecting = store.getState().select({ sessionId: 'a' });
  // The public runtime boundary resets store requests before the new host loads.
  store.getState().invalidateHost();
  // SAFETY: This host invalidation test observes only the incoming record name.
  store.setState({ sessions: [{ id: 'a', name: 'Incoming A' } as OrchestrationSessionRecord], selectedSessionId: 'a', availability: 'ready' });
  old.resolve(reply('a')); await selecting;
  expect(store.getState().sessions[0].name).toBe('Incoming A');
});

describe('Session selection per desktop', () => {
  async function freshStore() {
    vi.resetModules();
    vi.stubGlobal('window', { electronAPI: { orchestrationSessions: { select, list } } });
    const { useOrchestrationSessionStore: store } = await import('./orchestrationSessionStore');
    return store;
  }

  it('opens on the Session this desktop remembered, not the one another client picked last', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await freshStore();
    store.getState().preferSelection('b');
    await store.getState().load();
    expect(store.getState().selectedSessionId).toBe('b');
  });

  it('starts from the host’s last-used Session when it remembers none', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await freshStore();
    await store.getState().load();
    expect(store.getState().selectedSessionId).toBe('a');
  });

  it('switches to the remembered Session when the memory arrives after the list', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await freshStore();
    await store.getState().load();
    store.getState().preferSelection('b');
    expect(store.getState().selectedSessionId).toBe('b');
  });
});

describe('Session order', () => {
  // SAFETY: Order tests read only record ids.
  const four = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() } as OrchestrationSessionRecord));
  const ids = (records: OrchestrationSessionRecord[]) => records.map(record => record.id);
  const reorder = vi.fn();
  async function orderStore() {
    vi.resetModules();
    vi.stubGlobal('window', { electronAPI: { orchestrationSessions: { select, list, reorder } } });
    const { useOrchestrationSessionStore: store } = await import('./orchestrationSessionStore');
    store.setState({ sessions: four, selectedSessionId: 'a', availability: 'ready' });
    return store;
  }

  it('shows the new order before the host answers, moving only the listed Sessions', async () => {
    const answer = deferred<{ success: boolean; data: { sessions: OrchestrationSessionRecord[] } }>();
    reorder.mockReturnValue(answer.promise);
    const store = await orderStore();

    const saving = store.getState().reorder(['d', 'b']);

    expect(ids(store.getState().sessions)).toEqual(['a', 'd', 'c', 'b']);
    expect(reorder).toHaveBeenCalledWith(['d', 'b']);
    answer.resolve({ success: true, data: { sessions: [four[0], four[3], four[2], four[1]] } });
    await saving;
    expect(ids(store.getState().sessions)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('puts the order back and reports the failure when the host does not save it', async () => {
    reorder.mockResolvedValue({ success: false, error: 'disk full' });
    list.mockResolvedValue({ success: true, data: { sessions: four, selectedSessionId: 'a' } });
    const store = await orderStore();

    await expect(store.getState().reorder(['d', 'a'])).rejects.toThrow('disk full');

    expect(ids(store.getState().sessions)).toEqual(['a', 'b', 'c', 'd']);
  });
});
