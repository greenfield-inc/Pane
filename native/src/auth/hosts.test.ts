import { describe, expect, it } from 'vitest';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { addHost, EMPTY_HOSTS, loadHosts, removeHost, saveHosts, type KeyValueStore } from './hosts';

function profile(label: string, baseUrl: string, token: string): RemotePaneConnectionProfile {
  return { id: `${label}:${baseUrl}:${token.slice(-8)}`, label, baseUrl, token, transport: 'http+sse' };
}

const office = profile('Office', 'https://office.tail1234.ts.net', 'token-office-aaaaaaaa');
const laptop = profile('Laptop', 'http://127.0.0.1:42137', 'token-laptop-bbbbbbbb');

function memoryStore(): KeyValueStore & { keys(): string[] } {
  const values = new Map<string, string>();
  return {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    deleteItem: async key => { values.delete(key); },
    keys: () => [...values.keys()].sort(),
  };
}

describe('saved hosts', () => {
  it('makes a newly paired host the active one', () => {
    const hosts = addHost(addHost(EMPTY_HOSTS, office), laptop);
    expect(hosts.profiles.map(p => p.label)).toEqual(['Office', 'Laptop']);
    expect(hosts.activeId).toBe(laptop.id);
  });

  it('replaces the old pairing when the same host is paired again', () => {
    const repaired = profile('Office', 'https://office.tail1234.ts.net', 'token-office-cccccccc');
    const hosts = addHost(addHost(EMPTY_HOSTS, office), repaired);
    expect(hosts.profiles).toEqual([repaired]);
    expect(hosts.activeId).toBe(repaired.id);
  });

  it('falls back to the next host when the active one is removed', () => {
    const both = addHost(addHost(EMPTY_HOSTS, office), laptop);
    const afterRemove = removeHost(both, laptop.id);
    expect(afterRemove).toEqual({ profiles: [office], activeId: office.id });
    expect(removeHost(afterRemove, office.id)).toEqual(EMPTY_HOSTS);
  });

  it('keeps the active host when another one is removed', () => {
    const both = addHost(addHost(EMPTY_HOSTS, office), laptop);
    expect(removeHost(both, office.id).activeId).toBe(laptop.id);
  });

  it('round-trips through storage and deletes a removed host token', async () => {
    const store = memoryStore();
    const both = addHost(addHost(EMPTY_HOSTS, office), laptop);
    await saveHosts(store, both, EMPTY_HOSTS);
    expect(await loadHosts(store)).toEqual(both);

    const onlyOffice = removeHost(both, laptop.id);
    await saveHosts(store, onlyOffice, both);
    expect(await loadHosts(store)).toEqual(onlyOffice);
    const stored = await Promise.all(store.keys().map(key => store.getItem(key)));
    expect(stored.join('\n')).not.toContain(laptop.token);
  });

  it('stores every key in the character set SecureStore accepts', async () => {
    const store = memoryStore();
    await saveHosts(store, addHost(EMPTY_HOSTS, office), EMPTY_HOSTS);
    for (const key of store.keys()) {
      expect(key).toMatch(/^[\w.-]+$/);
    }
  });

  it('ignores corrupt stored data', async () => {
    const store = memoryStore();
    await store.setItem('pane.hosts.index', '{not json');
    expect(await loadHosts(store)).toEqual(EMPTY_HOSTS);
  });
});
