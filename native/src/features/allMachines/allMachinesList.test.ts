import { describe, expect, it } from 'vitest';

import type { NotifyItem, NotifySharedState } from '@shared/types/notify';
import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';

import { buildAllMachinesList, sinceLabel, type MachineFeed } from './allMachinesList';

const notify = (items: Array<Pick<NotifyItem, 'id' | 'createdAt' | 'title'> & { paneId?: string }>): NotifySharedState => ({
  machine: 'host', epoch: 'e1', revision: 1, enabled: true, queue: [], hidden: [],
  items: items.map(({ paneId, ...item }) => ({
    ...item, ui: 'approve', state: 'waiting', source: { name: 'agent', agent: 'Claude', ...(paneId ? { paneId } : {}) },
  })) as NotifyItem[],
});

const session = (id: string, name: string, paneIds: string[], updatedAt: string): OrchestrationSessionRecord => ({
  id, name, updatedAt, associations: paneIds.map(paneId => ({ paneId })),
} as unknown as OrchestrationSessionRecord);

// Two machines whose hosts both numbered their first repository 1 and named a Pane "fix-tests".
const studio: MachineFeed = {
  key: 'profile-studio',
  name: 'studio-mac',
  snapshot: {
    projects: [{ id: 1, name: 'acme-web', sessions: [
      { id: 'pane-1', name: 'fix-tests', createdAt: '2026-10-30T09:00:00Z', lastActivity: '2026-10-30T09:40:00Z' },
      { id: 'pane-2', name: 'old-branch', createdAt: '2026-10-30T08:00:00Z', archived: true },
    ] }],
    notify: notify([{ id: 'q-2', createdAt: 2_000, title: 'Apply migration 0042 to staging?', paneId: 'pane-1' }]),
    sessions: [session('s-1', 'Spring sale launch', ['pane-1'], '2026-10-30T09:20:00Z')],
  },
};
const build: MachineFeed = {
  key: 'profile-build',
  name: 'build-box',
  snapshot: {
    projects: [{ id: 1, name: 'infra', sessions: [
      { id: 'pane-1', name: 'fix-tests', createdAt: '2026-10-30T09:30:00Z' },
      { id: 'pane-9', name: 'workspace', createdAt: '2026-10-30T09:59:00Z', isHidden: true },
    ] }],
    notify: notify([{ id: 'q-1', createdAt: 1_000, title: 'Rotate the S3 key now?' }]),
    permissions: [{ id: 'perm-1', sessionId: 'pane-1', toolName: 'Bash', input: {}, timestamp: 3_000 }],
  },
};

describe('buildAllMachinesList', () => {
  it('keeps rows from two machines with the same ids apart, each tagged with its machine', () => {
    const { recent } = buildAllMachinesList([studio, build], '');
    const panes = recent.filter(row => row.type === 'pane');
    expect(panes.map(row => [row.key, row.machineKey])).toEqual([
      ['profile-studio:pane:pane-1', 'profile-studio'],
      ['profile-build:pane:pane-1', 'profile-build'],
    ]);
  });

  it('puts every machine\'s questions first, oldest first, then permission requests, then rows newest first', () => {
    const { waiting, recent } = buildAllMachinesList([studio, build], '');
    expect(waiting.map(row => row.key)).toEqual(['profile-build:question:q-1', 'profile-studio:question:q-2', 'profile-build:permission:perm-1']);
    expect(recent.map(row => row.key)).toEqual([
      // Last active 09:40.
      'profile-studio:pane:pane-1',
      // Never active, created 09:30.
      'profile-build:pane:pane-1',
      // Updated 09:20.
      'profile-studio:session:s-1',
    ]);
  });

  it('describes a Pane with its repository and Session, and marks it blocked while it waits on you', () => {
    const { recent } = buildAllMachinesList([studio, build], '');
    const fromStudio = recent.find(row => row.key === 'profile-studio:pane:pane-1');
    expect(fromStudio?.type === 'pane' && fromStudio.pane).toMatchObject({ repository: 'acme-web', session: 'Spring sale launch', status: 'blocked' });
    const fromBuild = recent.find(row => row.key === 'profile-build:pane:pane-1');
    expect(fromBuild?.type === 'pane' && fromBuild.pane).toMatchObject({ repository: 'infra', status: 'blocked' });
  });

  it('searches every machine\'s rows, its machine name included', () => {
    expect(buildAllMachinesList([studio, build], 'infra').recent.map(row => row.key)).toEqual(['profile-build:pane:pane-1']);
    expect(buildAllMachinesList([studio, build], 'build fix').recent.map(row => row.key)).toEqual(['profile-build:pane:pane-1']);
  });

  it('dims an unreachable machine\'s rows and keeps the rest live', () => {
    const { recent } = buildAllMachinesList([studio, { ...build, offlineSince: 1_000 }], '');
    expect(recent.map(row => [row.key, row.stale])).toEqual([
      ['profile-studio:pane:pane-1', false],
      ['profile-build:pane:pane-1', true],
      ['profile-studio:session:s-1', false],
    ]);
  });

  it('lists a machine that has not answered yet as nothing', () => {
    expect(buildAllMachinesList([{ key: 'profile-new', name: 'new-box', snapshot: undefined }], '')).toEqual({ waiting: [], recent: [] });
  });
});

describe('sinceLabel', () => {
  const now = Date.parse('2026-10-30T10:00:00Z');
  it('says how long ago in a few characters', () => {
    expect(sinceLabel(Date.parse('2026-10-30T09:59:30Z'), now)).toBe('now');
    expect(sinceLabel(Date.parse('2026-10-30T09:51:00Z'), now)).toBe('9 min');
    expect(sinceLabel(Date.parse('2026-10-30T07:00:00Z'), now)).toBe('3 h');
    expect(sinceLabel(Date.parse('2026-10-29T09:00:00Z'), now)).toBe('1 day');
    expect(sinceLabel(Date.parse('2026-10-28T09:00:00Z'), now)).toBe('2 days');
  });
});
