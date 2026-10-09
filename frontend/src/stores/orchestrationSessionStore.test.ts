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
