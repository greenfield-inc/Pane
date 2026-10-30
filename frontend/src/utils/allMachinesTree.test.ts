import { describe, expect, it } from 'vitest';
import { buildAllMachinesTree, type MachineRef, type MachineSnapshot, type MachineView } from './allMachinesTree';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

const studio: MachineRef = { id: 'local', name: 'studio-mac', os: 'macOS', slot: 0 };
const build: MachineRef = { id: 'build-box-profile', name: 'build-box', os: 'Linux', slot: 1 };

const pane = (id: string, name: string, extra: Partial<Session> = {}): Session => ({
  id, name, worktreePath: `/code/${name}`, prompt: '', status: 'running', createdAt: '2026-10-30T09:00:00Z', output: [], jsonMessages: [], ...extra,
});

const project = (id: number, name: string, panes: Session[]): Project & { sessions: Session[] } => ({
  id, name, path: `/code/${name}`, active: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', sessions: panes,
});

const snapshot = (projects: MachineSnapshot['projects'], extra: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
  projects, sessions: [], statuses: [], notify: null, permissions: [], ...extra,
});

const view = (machine: MachineRef, data: MachineSnapshot, offline = false): MachineView => ({ machine, snapshot: data, offline });

describe('buildAllMachinesTree', () => {
  it('keeps two machines\' rows apart when their project and Pane ids are the same', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'acme-web', [pane('p1', 'fix-checkout-race')])])),
      view(build, snapshot([project(1, 'infra', [pane('p1', 'terraform-upgrade')])])),
    ]);

    expect(tree.projects.map(row => row.name)).toEqual(['acme-web', 'infra']);
    expect(tree.projects.map(row => row.panes.map(item => [item.key, item.machine.name, item.pane.name]))).toEqual([
      [['local:p1', 'studio-mac', 'fix-checkout-race']],
      [['build-box-profile:p1', 'build-box', 'terraform-upgrade']],
    ]);
  });

  it('shows a repository open on two machines once, with each machine\'s Panes under it', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(3, 'acme-web', [pane('a', 'fix-checkout-race', { lastActivity: '2026-10-30T09:10:00Z' })])])),
      view(build, snapshot([project(7, 'acme-web', [pane('b', 'load-test-checkout', { lastActivity: '2026-10-30T09:05:00Z' })])])),
    ]);

    expect(tree.projects).toHaveLength(1);
    expect(tree.projects[0].entries.map(entry => [entry.machine.name, entry.project.id])).toEqual([['studio-mac', 3], ['build-box', 7]]);
    expect(tree.projects[0].panes.map(item => `${item.pane.name} on ${item.machine.name}`)).toEqual([
      'fix-checkout-race on studio-mac',
      'load-test-checkout on build-box',
    ]);
  });

  it('puts a Pane that turns active on another machine at the top of its project', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'acme-web', [pane('a', 'add-dark-mode', { lastActivity: '2026-10-30T09:10:00Z' })])])),
      view(build, snapshot(
        [project(1, 'acme-web', [pane('b', 'load-test-checkout', { lastActivity: '2026-10-30T08:00:00Z' })])],
        { statuses: [{ panelId: 'panel-b', sessionId: 'b', state: 'working', reason: null }] },
      )),
    ]);

    expect(tree.projects[0].panes.map(item => [item.pane.name, item.status])).toEqual([
      ['load-test-checkout', 'working'],
      ['add-dark-mode', 'unknown'],
    ]);
  });

  it('keeps an offline machine\'s rows, marked as from when it stopped answering', () => {
    const tree = buildAllMachinesTree([
      view(build, snapshot([project(2, 'infra', [pane('n', 'nightly-backup')])]), true),
    ]);

    expect(tree.panes.map(item => [item.pane.name, item.offline])).toEqual([['nightly-backup', true]]);
  });

  it('leaves out archived Sessions and lists each Session\'s Panes from its own machine', () => {
    const record = (id: string, name: string, paneIds: string[], archived = false): OrchestrationSessionRecord => ({
      id, name, archived, agent: 'claude', internalSessionId: `internal-${id}`,
      panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor` },
      goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
      associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: '2026-10-30T09:00:00Z' })),
      activity: [], revision: 1, createdAt: '2026-10-30T09:00:00Z', updatedAt: '2026-10-30T09:00:00Z',
    });
    const tree = buildAllMachinesTree([
      view(build, snapshot([project(1, 'infra', [pane('p1', 'nightly-backup')])], {
        sessions: [record('s1', 'Backup rotation', ['p1']), record('s2', 'Old', [], true)],
      })),
      view(studio, snapshot([project(1, 'acme-web', [pane('p1', 'fix-checkout-race')])])),
    ]);

    expect(tree.sessions.map(row => [row.key, row.session.name, row.panes.map(item => item.pane.name)])).toEqual([
      ['build-box-profile:s1', 'Backup rotation', ['nightly-backup']],
    ]);
  });
});
