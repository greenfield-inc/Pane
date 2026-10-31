/**
 * Opening a row on another machine switches to it and lands on that row. The
 * landing is decided after the switch, from what this desktop remembers for the
 * machine: its location and its Session layout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import type { AppConfig } from '../types/config';

const OTHER_MACHINE = 'machine-b';
const LAST_VIEWED = 'session-last-viewed';
const CLICKED = 'session-clicked';

let storedLayouts: Map<string, SessionWorkspaceLayout>;

function stubWindow(): void {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  });
  vi.stubGlobal('window', {
    electronAPI: {
      uiState: {
        saveNavigationMemory: () => Promise.resolve({ success: true }),
        getSessionWorkspaceLayout: (hostId: string | null) =>
          Promise.resolve({ success: true, data: storedLayouts.get(hostId ?? '') ?? null }),
        saveSessionWorkspaceLayout: (hostId: string | null, layout: SessionWorkspaceLayout | null) => {
          if (layout) storedLayouts.set(hostId ?? '', layout);
          return Promise.resolve({ success: true });
        },
      },
    },
  });
}

function activeHostConfig(hostId: string | null): AppConfig {
  const remoteDaemon: AppConfig['remoteDaemon'] = {
    ...createDefaultRemoteDaemonConfig(),
    client: {
      profiles: [{ id: OTHER_MACHINE, label: OTHER_MACHINE, baseUrl: 'https://machine-b.example', token: 't', transport: 'http+sse' }],
      activeProfileId: hostId,
      mode: hostId ? 'remote' : 'local',
    },
  };
  // SAFETY: these modules read only remoteDaemon off the config.
  return { remoteDaemon } as AppConfig;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  storedLayouts = new Map();
  stubWindow();
});

describe('openOnMachine', () => {
  it('lands on the clicked Session even when the machine last showed another one', async () => {
    const [{ openOnMachine }, { useAllMachinesStore }, { useConfigStore }, { useSessionWorkspaceLayoutStore }, layoutTree] = await Promise.all([
      import('./machineRowActions'),
      import('../stores/allMachinesStore'),
      import('../stores/configStore'),
      import('../stores/sessionWorkspaceLayoutStore'),
      import('./sessionWorkspaceLayout'),
    ]);
    // Last time this desktop was on machine B it was looking at another Session.
    storedLayouts.set(OTHER_MACHINE, layoutTree.createSessionWorkspaceLayout(LAST_VIEWED));
    useConfigStore.setState({ config: activeHostConfig(null) });
    useAllMachinesStore.setState({
      entries: [
        { id: 'local', name: 'This computer', os: 'macOS', slot: 0, active: true },
        { id: OTHER_MACHINE, name: 'Machine B', os: 'Windows', slot: 1, active: false },
      ],
      switchMachine: (machineId) => {
        useConfigStore.setState({ config: activeHostConfig(machineId) });
        return Promise.resolve({ ok: true });
      },
    });

    await openOnMachine(OTHER_MACHINE, { kind: 'session', id: CLICKED, name: 'Clicked' });

    // After the switch the Session view hydrates machine B's layout around the
    // restored selection, which counts as no new pick of this desktop's.
    const layout = await useSessionWorkspaceLayoutStore.getState().hydrate([LAST_VIEWED, CLICKED], CLICKED, false);
    expect(layout && layoutTree.focusedSessionId(layout)).toBe(CLICKED);
  });
});
