import { beforeEach, describe, expect, it, vi } from 'vitest';

let storage: Map<string, string>;
let storageThrows: boolean;

function stubStorage(): void {
  storage = new Map();
  storageThrows = false;
  const guard = () => {
    if (storageThrows) throw new Error('SecurityError: storage is disabled');
  };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => { guard(); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { guard(); storage.set(key, value); },
    },
  });
}

/** Loads the module fresh so the store starts empty. */
async function loadModule() {
  vi.resetModules();
  return import('./remoteExpandedSessionsStore');
}

describe('remote expanded Sessions', () => {
  beforeEach(stubStorage);

  it('starts with every Session collapsed when nothing is stored', async () => {
    const { readExpandedSessions } = await loadModule();
    expect([...readExpandedSessions('host-a')]).toEqual([]);
  });

  it('remembers the opened Sessions per host under its own key', async () => {
    const { useRemoteExpandedSessionsStore, readExpandedSessions } = await loadModule();
    const store = useRemoteExpandedSessionsStore.getState();
    store.load('host-a');
    useRemoteExpandedSessionsStore.getState().toggle('session-1');

    expect(storage.get('pane.remotePwa.expandedSessions@host-a')).toBe(JSON.stringify(['session-1']));
    expect([...readExpandedSessions('host-a')]).toEqual(['session-1']);
    expect([...readExpandedSessions('host-b')]).toEqual([]);

    useRemoteExpandedSessionsStore.getState().load('host-b');
    expect([...useRemoteExpandedSessionsStore.getState().expanded]).toEqual([]);
    useRemoteExpandedSessionsStore.getState().load('host-a');
    expect([...useRemoteExpandedSessionsStore.getState().expanded]).toEqual(['session-1']);
  });

  it('collapses a Session again on the second toggle', async () => {
    const { useRemoteExpandedSessionsStore, readExpandedSessions } = await loadModule();
    useRemoteExpandedSessionsStore.getState().load('host-a');
    useRemoteExpandedSessionsStore.getState().toggle('session-1');
    useRemoteExpandedSessionsStore.getState().toggle('session-1');
    expect([...useRemoteExpandedSessionsStore.getState().expanded]).toEqual([]);
    expect([...readExpandedSessions('host-a')]).toEqual([]);
  });

  it('ignores a stored value that is not a list of ids', async () => {
    storage.set('pane.remotePwa.expandedSessions@host-a', JSON.stringify({ ids: ['x'] }));
    storage.set('pane.remotePwa.expandedSessions@host-b', 'not json');
    const { readExpandedSessions } = await loadModule();
    expect([...readExpandedSessions('host-a')]).toEqual([]);
    expect([...readExpandedSessions('host-b')]).toEqual([]);
  });

  it('still toggles for the visit when storage throws', async () => {
    storageThrows = true;
    const { useRemoteExpandedSessionsStore } = await loadModule();
    useRemoteExpandedSessionsStore.getState().load('host-a');
    useRemoteExpandedSessionsStore.getState().toggle('session-1');
    expect([...useRemoteExpandedSessionsStore.getState().expanded]).toEqual(['session-1']);
  });
});
