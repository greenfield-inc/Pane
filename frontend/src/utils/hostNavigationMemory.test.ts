import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { HostNavigationMemory } from '../../../shared/types/hostNavigation';
import type { AppConfig } from '../types/config';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

const REMOTE_HOST_ID = 'host-b';

let storedMemories: Map<string, HostNavigationMemory>;
let savedMemories: Array<{ hostId: string | null; memory: HostNavigationMemory }>;
let hostProjects: Project[];

const saveNavigationMemory = vi.fn((hostId: string | null, memory: HostNavigationMemory) => {
  savedMemories.push({ hostId, memory });
  return Promise.resolve({ success: true });
});

function stubWindow(): void {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal('performance', { now: () => 0 });
  vi.stubGlobal('CustomEvent', class {
    constructor(public type: string, public init?: { detail?: unknown }) {}
  });
  vi.stubGlobal('window', {
    dispatchEvent: () => true,
    electronAPI: {
      invoke: () => Promise.resolve({ success: true }),
      sessions: { markViewed: () => Promise.resolve({ success: true }) },
      projects: { getAll: () => Promise.resolve({ success: true, data: hostProjects }) },
      uiState: {
        getNavigationMemory: (hostId: string | null) =>
          Promise.resolve({ success: true, data: storedMemories.get(hostId ?? '') ?? null }),
        saveNavigationMemory,
      },
    },
  });
}

/** Loads the module graph fresh so the stores start empty and module state resets. */
async function loadHostNavigationMemory() {
  vi.resetModules();
  stubWindow();
  const [memory, navigation, sessions, config] = await Promise.all([
    import('./hostNavigationMemory'),
    import('../stores/navigationStore'),
    import('../stores/sessionStore'),
    import('../stores/configStore'),
  ]);
  setActiveHost(config.useConfigStore, REMOTE_HOST_ID);
  return { ...memory, ...navigation, ...sessions, setHost: (hostId: string | null) => setActiveHost(config.useConfigStore, hostId) };
}

type ConfigStore = typeof import('../stores/configStore')['useConfigStore'];

/** Stands in for main flipping the active runtime: config changes, nothing else does. */
function setActiveHost(useConfigStore: ConfigStore, hostId: string | null): void {
  const remoteDaemon: AppConfig['remoteDaemon'] = {
    ...createDefaultRemoteDaemonConfig(),
    client: {
      profiles: [{ id: REMOTE_HOST_ID, label: 'Host B', baseUrl: 'https://host-b.example', token: 'token-b', transport: 'http+sse' }],
      activeProfileId: hostId,
      mode: hostId ? 'remote' : 'local',
    },
  };
  useConfigStore.setState({ config: { remoteDaemon } });
}

function paneFixture(id: string): Session {
  // SAFETY: restoreHostNavigation only matches Panes by id.
  return { id, name: id } as Session;
}

beforeEach(() => {
  storedMemories = new Map();
  savedMemories = [];
  hostProjects = [];
  saveNavigationMemory.mockClear();
  vi.unstubAllGlobals();
});

describe('restoreHostNavigation', () => {
  it('reopens the Pane the host was left on', async () => {
    storedMemories.set(REMOTE_HOST_ID, { view: 'sessions', projectId: null, paneId: 'pane-2' });
    const { restoreHostNavigation, useNavigationStore, useSessionStore } = await loadHostNavigationMemory();
    useSessionStore.getState().loadSessions([paneFixture('pane-1'), paneFixture('pane-2')]);

    await restoreHostNavigation();

    expect(useNavigationStore.getState().activeView).toBe('sessions');
    expect(useSessionStore.getState().activeSessionId).toBe('pane-2');
  });

  it('falls back to the home view when the remembered Pane is gone', async () => {
    storedMemories.set(REMOTE_HOST_ID, { view: 'sessions', projectId: null, paneId: 'archived-pane' });
    const { restoreHostNavigation, useNavigationStore, useSessionStore } = await loadHostNavigationMemory();
    useSessionStore.getState().loadSessions([paneFixture('pane-1')]);

    await restoreHostNavigation();

    expect(useNavigationStore.getState().activeView).toBe('sessions');
    expect(useSessionStore.getState().activeSessionId).toBeNull();
  });

  it('reopens a repository view whose repository still exists on the host', async () => {
    storedMemories.set(REMOTE_HOST_ID, { view: 'project', projectId: 7, paneId: null });
    // SAFETY: projectExists only reads ids.
    hostProjects = [{ id: 7, name: 'pane' } as Project];
    const { restoreHostNavigation, useNavigationStore } = await loadHostNavigationMemory();

    await restoreHostNavigation();

    expect(useNavigationStore.getState().activeView).toBe('project');
    expect(useNavigationStore.getState().activeProjectId).toBe(7);
  });

  it('leaves the home view when the remembered repository is gone', async () => {
    storedMemories.set(REMOTE_HOST_ID, { view: 'project', projectId: 7, paneId: null });
    const { restoreHostNavigation, useNavigationStore } = await loadHostNavigationMemory();

    await restoreHostNavigation();

    expect(useNavigationStore.getState().activeView).toBe('sessions');
    expect(useNavigationStore.getState().activeProjectId).toBeNull();
  });

  it('does nothing for a host that has never been visited', async () => {
    const { restoreHostNavigation, useNavigationStore } = await loadHostNavigationMemory();
    useNavigationStore.getState().navigateToPaneChat();

    await restoreHostNavigation();

    expect(useNavigationStore.getState().activeView).toBe('pane-chat');
  });
});

describe('withHostNavigationWritesPaused', () => {
  it('records only the location the switch landed on', async () => {
    vi.useFakeTimers();
    try {
      const { startHostNavigationMemoryWrites, withHostNavigationWritesPaused, useNavigationStore } =
        await loadHostNavigationMemory();
      const stop = startHostNavigationMemoryWrites();

      await withHostNavigationWritesPaused(async () => {
        // Stands in for the clearing a host switch does before restoring.
        useNavigationStore.getState().navigateToSessions();
        useNavigationStore.getState().navigateToPaneChat();
      });
      expect(saveNavigationMemory).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      stop();

      expect(savedMemories).toEqual([
        { hostId: REMOTE_HOST_ID, memory: { view: 'pane-chat', projectId: null, paneId: null, orchestrationSessionId: null } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('credits a pending write to the host it came from, not the one being switched to', async () => {
    vi.useFakeTimers();
    try {
      const { startHostNavigationMemoryWrites, useNavigationStore, setHost } = await loadHostNavigationMemory();
      const stop = startHostNavigationMemoryWrites();

      useNavigationStore.getState().navigateToPaneChat();
      // Main flips the runtime before the renderer is told to resync, so config
      // already names the incoming host while this location belongs to Host B.
      setHost(null);
      await vi.advanceTimersByTimeAsync(500);
      stop();

      expect(savedMemories).toEqual([
        { hostId: REMOTE_HOST_ID, memory: { view: 'pane-chat', projectId: null, paneId: null, orchestrationSessionId: null } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
