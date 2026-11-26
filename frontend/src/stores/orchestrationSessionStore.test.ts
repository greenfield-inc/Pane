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
    expect(store.getState().selectionRevision).toBe(1);
  });

  // The Session workspace lets its stored layout's focus win only while the
  // revision is zero, so the remembered Session must count (D-241).
  it('counts landing on the remembered Session after a host switch as this desktop’s selection', async () => {
    const store = await setup();
    store.getState().invalidateHost();
    store.getState().preferSelection('b');
    expect(store.getState().selectionRevision).toBe(0);
    list.mockResolvedValue(reply('a'));
    await store.getState().refresh({ adoptServerSelection: true });
    expect(store.getState()).toMatchObject({ selectedSessionId: 'b', selectionRevision: 1 });
  });

  it('does not count the host’s last-used Session as this desktop’s selection', async () => {
    const store = await setup();
    store.getState().invalidateHost();
    list.mockResolvedValue(reply('a'));
    await store.getState().refresh({ adoptServerSelection: true });
    expect(store.getState()).toMatchObject({ selectedSessionId: 'a', selectionRevision: 0 });
    await store.getState().refresh({ adoptServerSelection: true });
    expect(store.getState().selectionRevision).toBe(0);
  });

  it('counts the remembered Session on first load, but only once', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await freshStore();
    store.getState().preferSelection('b');
    await store.getState().load();
    expect(store.getState()).toMatchObject({ selectedSessionId: 'b', selectionRevision: 1 });
    await store.getState().refresh({ adoptServerSelection: true });
    expect(store.getState().selectionRevision).toBe(1);
  });
});

describe('Session order', () => {
  // SAFETY: Order tests read only record ids.
  const four = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() } as OrchestrationSessionRecord));
  const ids = (records: ReadonlyArray<{ id: string }>) => records.map(record => record.id);
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

describe('landing on the Session pressed on another machine (T-128)', () => {
  // The rig in #1767 found Enter on another machine's Session showing the host's own last-used one.
  it('lands on the pressed Session even when a select from the restored layout is still in flight', async () => {
    const layoutSelect = deferred<ReturnType<typeof reply>>();
    select.mockReturnValueOnce(layoutSelect.promise);
    list.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().invalidateHost();
    store.setState({ sessions });
    const layout = store.getState().select({ sessionId: 'a' });
    await store.getState().refresh({ adoptServerSelection: true });
    store.getState().preferSelection('b');
    layoutSelect.resolve(reply('a'));
    await layout;
    await store.getState().refresh({ adoptServerSelection: true });

    expect(store.getState().selectedSessionId).toBe('b');
  });

  it('keeps the pressed Session through the switch, which clears the outgoing host\'s Sessions', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().invalidateHost();
    await store.getState().load();

    expect(store.getState().selectedSessionId).toBe('b');
    expect(store.getState().selectionRevision).toBeGreaterThan(0);
  });

  it('lands only once, so a later click on the new host is not undone', async () => {
    list.mockResolvedValue(reply('a'));
    select.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().invalidateHost();
    await store.getState().load();
    await store.getState().select({ sessionId: 'a' });
    await store.getState().refresh({ adoptServerSelection: true });

    expect(store.getState().selectedSessionId).toBe('a');
  });

  // #1767 review F-12: the first open to a machine landed on its Onboarding Session, later ones on the host's own selection.
  it('first open: an automatic select of the host\'s Onboarding Session after the landing leaves the pressed Session shown', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().invalidateHost();
    await store.getState().load();
    // The restored layout or first-run state picks the host's Onboarding Session after the list landed.
    await store.getState().select({ sessionId: 'a' }, { automatic: true });

    expect(store.getState().selectedSessionId).toBe('b');
    expect(select).not.toHaveBeenCalled();
  });

  it('later opens: the host\'s own selection, in every list and automatic select through the restore, never replaces the pressed Session', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    list.mockResolvedValue(reply('a'));
    select.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().invalidateHost();
    await store.getState().refresh({ adoptServerSelection: true });
    await store.getState().refresh();
    await store.getState().select({ sessionId: 'a' }, { automatic: true });
    store.getState().settleLanding();
    now.mockReturnValue(1_900);
    await store.getState().select({ sessionId: 'a' }, { automatic: true });
    await store.getState().refresh({ adoptServerSelection: true });
    expect(store.getState().selectedSessionId).toBe('b');
    expect(select).not.toHaveBeenCalled();

    // A second after the restore ends, the layout may pick again.
    now.mockReturnValue(2_100);
    await store.getState().select({ sessionId: 'a' }, { automatic: true });
    expect(store.getState().selectedSessionId).toBe('a');
    now.mockRestore();
  });

  it('drops a landing that a newer press or a cancelled switch replaced', async () => {
    list.mockResolvedValue(reply('a'));
    const store = await setup();

    store.getState().landOn('b');
    store.getState().landOn(undefined);
    store.getState().invalidateHost();
    await store.getState().load();

    expect(store.getState().selectedSessionId).toBe('a');
  });
});
