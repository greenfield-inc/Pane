/**
 * Unit tests for per-host Session layout memory.
 *
 * The cases that matter here are the ones a host switch creates: config names
 * the incoming host before that host's Session list arrives, so hydrate can be
 * handed a list that belongs to the host being left.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import type { AppConfig } from '../types/config';

const HOSTS = ['host-a', 'host-b'] as const;

let storedLayouts: Map<string, SessionWorkspaceLayout>;
let savedLayouts: Array<{ hostId: string | null; layout: SessionWorkspaceLayout | null }>;

const saveSessionWorkspaceLayout = vi.fn((hostId: string | null, layout: SessionWorkspaceLayout | null) => {
  savedLayouts.push({ hostId, layout });
  if (layout) storedLayouts.set(hostId ?? '', layout);
  else storedLayouts.delete(hostId ?? '');
  return Promise.resolve({ success: true });
});

function stubWindow(): void {
  vi.stubGlobal('window', {
    electronAPI: {
      uiState: {
        getSessionWorkspaceLayout: (hostId: string | null) =>
          Promise.resolve({ success: true, data: storedLayouts.get(hostId ?? '') ?? null }),
        saveSessionWorkspaceLayout,
      },
    },
  });
}

/** Loads the module graph fresh so the stores start empty and module state resets. */
async function loadStore() {
  vi.resetModules();
  stubWindow();
  const [layout, config, tree] = await Promise.all([
    import('./sessionWorkspaceLayoutStore'),
    import('./configStore'),
    import('../utils/sessionWorkspaceLayout'),
  ]);
  return {
    store: layout.useSessionWorkspaceLayoutStore,
    tree,
    setHost: (hostId: string | null) => setActiveHost(config.useConfigStore, hostId),
    clearConfig: () => config.useConfigStore.setState({ config: null }),
  };
}

type ConfigStore = typeof import('./configStore')['useConfigStore'];

/** Stands in for main flipping the active runtime: config changes, nothing else does. */
function setActiveHost(useConfigStore: ConfigStore, hostId: string | null): void {
  const remoteDaemon: AppConfig['remoteDaemon'] = {
    ...createDefaultRemoteDaemonConfig(),
    client: {
      // The host only reads as active while it has a profile to point at.
      profiles: HOSTS.map(id => ({ id, label: id, baseUrl: `https://${id}.example`, token: id, transport: 'http+sse' })),
      activeProfileId: hostId,
      mode: hostId ? 'remote' : 'local',
    },
  };
  // SAFETY: the layout store reads only remoteDaemon off the config.
  useConfigStore.setState({ config: { remoteDaemon } as AppConfig });
}

/** A two-tile layout for `sessionIds`, as a drop would have produced. */
function tiled(sessionIds: string[]): SessionWorkspaceLayout {
  return {
    version: 1,
    root: {
      type: 'split',
      id: 'split-1',
      direction: 'row',
      children: sessionIds.map((sessionId, index) => ({
        type: 'session' as const,
        id: `tile-${index}`,
        sessionId,
      })),
      sizes: sessionIds.map(() => 1 / sessionIds.length),
    },
    focusedTileId: 'tile-0',
  };
}

beforeEach(() => {
  storedLayouts = new Map();
  savedLayouts = [];
  saveSessionWorkspaceLayout.mockClear();
  vi.unstubAllGlobals();
});

describe('hydrate', () => {
  it('restores the host\'s stored layout', async () => {
    const { store, tree, setHost } = await loadStore();
    storedLayouts.set('host-a', tiled(['s1', 's2']));
    setHost('host-a');

    const hydrated = await store.getState().hydrate(['s1', 's2'], 's1');

    expect(hydrated && tree.tiledSessionIds(hydrated.root)).toEqual(['s1', 's2']);
    expect(store.getState().loaded).toBe(true);
    // Nothing changed, so nothing is written back.
    expect(savedLayouts).toHaveLength(0);
  });

  it('drops tiles whose Session is gone and writes the repaired layout back', async () => {
    const { store, tree, setHost } = await loadStore();
    storedLayouts.set('host-a', tiled(['s1', 's2']));
    setHost('host-a');

    const hydrated = await store.getState().hydrate(['s1'], 's1');

    expect(hydrated && tree.tiledSessionIds(hydrated.root)).toEqual(['s1']);
    expect(store.getState().loaded).toBe(true);
  });

  it('hydrates a host only once', async () => {
    const { store, setHost } = await loadStore();
    storedLayouts.set('host-a', tiled(['s1', 's2']));
    setHost('host-a');

    expect(await store.getState().hydrate(['s1', 's2'], 's1')).not.toBeNull();
    expect(await store.getState().hydrate(['s1', 's2'], 's1')).toBeNull();
  });

  it('keeps a stored layout a mismatched Session list would have wiped out', async () => {
    const { store, tree, setHost } = await loadStore();
    // host-b's remembered layout, and the Sessions still on screen from host-a.
    storedLayouts.set('host-b', tiled(['b1', 'b2']));
    setHost('host-b');

    const first = await store.getState().hydrate(['a1', 'a2'], 'a1');

    // Nothing is claimed to have hydrated, and nothing is persisted over the
    // layout host-b still has.
    expect(first).toBeNull();
    expect(store.getState().loaded).toBe(false);
    expect(savedLayouts).toHaveLength(0);
    // Something usable is on screen in the meantime.
    expect(store.getState().layout).not.toBeNull();

    // host-b's own Sessions arrive; its layout comes back whole.
    const second = await store.getState().hydrate(['b1', 'b2'], 'b1');
    expect(second && tree.tiledSessionIds(second.root)).toEqual(['b1', 'b2']);
    expect(store.getState().loaded).toBe(true);
  });

  it('gives a usable layout before config names the host, without storing it', async () => {
    const { store, clearConfig } = await loadStore();
    clearConfig();

    const hydrated = await store.getState().hydrate(['s1'], 's1');

    // No host to file it under, so it does not count as hydrated...
    expect(hydrated).toBeNull();
    expect(store.getState().loaded).toBe(false);
    expect(savedLayouts).toHaveLength(0);
    // ...but the view still has something to render rather than hanging.
    expect(store.getState().layout).not.toBeNull();
  });
});

describe('apply', () => {
  it('a deliberate gesture wins over a layout still waiting to hydrate', async () => {
    const { store, tree, setHost } = await loadStore();
    storedLayouts.set('host-b', tiled(['b1', 'b2']));
    setHost('host-b');
    await store.getState().hydrate(['a1', 'a2'], 'a1');

    store.getState().apply(tree.createSessionWorkspaceLayout('a1'));

    expect(store.getState().loaded).toBe(true);
    // The stored layout no longer overwrites what the user just did.
    expect(await store.getState().hydrate(['b1', 'b2'], 'b1')).toBeNull();
  });
});

describe('reset', () => {
  it('forgets the host so the next one hydrates its own layout', async () => {
    const { store, tree, setHost } = await loadStore();
    storedLayouts.set('host-a', tiled(['s1', 's2']));
    setHost('host-a');
    await store.getState().hydrate(['s1', 's2'], 's1');

    store.getState().reset();
    expect(store.getState().layout).toBeNull();
    expect(store.getState().loaded).toBe(false);

    storedLayouts.set('host-b', tiled(['b1', 'b2']));
    setHost('host-b');
    const hydrated = await store.getState().hydrate(['b1', 'b2'], 'b1');
    expect(hydrated && tree.tiledSessionIds(hydrated.root)).toEqual(['b1', 'b2']);
  });
});
