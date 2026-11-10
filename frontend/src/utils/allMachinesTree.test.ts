import { describe, expect, it } from 'vitest';
import { buildAllMachinesTree, savedOrderAfterMove, seedArrangement, type MachineRef, type MachineSnapshot, type MachineView } from './allMachinesTree';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

const studio: MachineRef = { id: 'local', name: 'studio-mac', os: 'macOS', slot: 0, letters: 'S' };
const build: MachineRef = { id: 'build-box-profile', name: 'build-box', os: 'Linux', slot: 1, letters: 'B' };

const pane = (id: string, name: string, extra: Partial<Session> = {}): Session => ({
  id, name, worktreePath: `/code/${name}`, prompt: '', status: 'running', createdAt: '2026-10-30T09:00:00Z', output: [], jsonMessages: [], ...extra,
});

const project = (id: number, name: string, panes: Session[], repository?: string): Project & { sessions: Session[] } => {
  const row: Project & { sessions: Session[] } = { id, name, path: `/code/${name}`, active: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', sessions: panes };
  if (repository) row.repository = repository;
  return row;
};

const snapshot = (projects: MachineSnapshot['projects'], extra: Partial<MachineSnapshot> = {}): MachineSnapshot => ({
  projects, sessions: [], statuses: [], notify: null, permissions: [], ...extra,
});

const record = (id: string, name: string, paneIds: string[] = [], extra: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord => ({
  id, name, archived: false, agent: 'claude', internalSessionId: `internal-${id}`,
  panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor`, opencode: `${id}-opencode` },
  goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
  associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: '2026-10-30T09:00:00Z' })),
  activity: [], revision: 1, createdAt: '2026-10-30T09:00:00Z', updatedAt: '2026-10-30T09:00:00Z', ...extra,
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

  it('never moves a Pane because it turns active or asks you something', () => {
    const projects = (states: MachineSnapshot['statuses']) => [
      view(studio, snapshot([project(1, 'acme-web', [
        pane('a', 'add-dark-mode', { createdAt: '2026-10-30T09:10:00Z' }),
        pane('c', 'fix-checkout-race', { createdAt: '2026-10-30T09:00:00Z', lastActivity: '2026-10-30T09:30:00Z' }),
      ])])),
      view(build, snapshot(
        [project(1, 'acme-web', [pane('b', 'load-test-checkout', { createdAt: '2026-10-30T08:00:00Z' })])],
        { statuses: states },
      )),
    ];
    const before = buildAllMachinesTree(projects([]));
    const after = buildAllMachinesTree(projects([{ panelId: 'panel-b', sessionId: 'b', state: 'blocked', reason: null }]));

    expect(before.projects[0].panes.map(item => item.pane.name)).toEqual(['add-dark-mode', 'fix-checkout-race', 'load-test-checkout']);
    expect(after.projects[0].panes.map(item => item.pane.name)).toEqual(['add-dark-mode', 'fix-checkout-race', 'load-test-checkout']);
  });

  it('puts a pinned Pane first in its project, and keeps the rest in their order', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'acme-web', [pane('a', 'add-dark-mode'), pane('c', 'fix-checkout-race')])])),
      view(build, snapshot([project(1, 'acme-web', [pane('b', 'load-test-checkout', { isFavorite: true })])])),
    ]);

    expect(tree.projects[0].panes.map(item => item.pane.name)).toEqual(['load-test-checkout', 'add-dark-mode', 'fix-checkout-race']);
  });

  it('starts from each machine\'s own Session order, machines in menu order, and never re-sorts by status', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([], { sessions: [record('s2', 'Frontend Refactor'), record('s1', 'Pane Fixes')] })),
      view(build, snapshot([], {
        sessions: [record('s3', 'Clinic Branding')],
        statuses: [{ panelId: 'x', sessionId: 'internal-s3', state: 'working', reason: null }],
      })),
    ]);

    expect(tree.sessions.map(row => row.session.name)).toEqual(['Frontend Refactor', 'Pane Fixes', 'Clinic Branding']);
  });

  it('orders Sessions across machines as this computer arranged them, pinned first', () => {
    const views = [
      view(studio, snapshot([], { sessions: [record('s1', 'Pane Fixes'), record('s2', 'Frontend Refactor', [], { isPinned: true })] })),
      view(build, snapshot([], { sessions: [record('s3', 'Clinic Branding')] })),
    ];
    const tree = buildAllMachinesTree(views, { sessions: ['local:s1', 'build-box-profile:s3', 'local:s2'], panes: {} });

    expect(tree.sessions.map(row => row.session.name)).toEqual(['Frontend Refactor', 'Pane Fixes', 'Clinic Branding']);
  });

  it('puts rows the saved order does not name first, newest first, and ignores ids it names that are gone', () => {
    const views = [
      view(studio, snapshot([project(1, 'acme-web', [
        pane('a', 'add-dark-mode', { createdAt: '2026-10-30T08:00:00Z' }),
        pane('n1', 'new-older', { createdAt: '2026-10-30T10:00:00Z' }),
      ])], { sessions: [record('s1', 'Pane Fixes'), record('s9', 'New Session', [], { createdAt: '2026-10-31T09:00:00Z' })] })),
      view(build, snapshot([project(1, 'acme-web', [
        pane('b', 'load-test-checkout', { createdAt: '2026-10-30T07:00:00Z' }),
        pane('n2', 'new-newer', { createdAt: '2026-10-30T11:00:00Z' }),
      ])], { sessions: [record('s3', 'Clinic Branding')] })),
    ];
    const tree = buildAllMachinesTree(views, {
      sessions: ['build-box-profile:s3', 'local:gone', 'local:s1'],
      panes: { 'name:acme-web': ['build-box-profile:b', 'local:archived', 'local:a'] },
    });

    expect(tree.sessions.map(row => row.session.name)).toEqual(['New Session', 'Clinic Branding', 'Pane Fixes']);
    expect(tree.projects[0].panes.map(item => item.pane.name)).toEqual(['new-newer', 'new-older', 'load-test-checkout', 'add-dark-mode']);
  });

  it('lists a Session\'s Panes in the order they were added to it', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot(
        [project(1, 'acme-web', [pane('a', 'add-dark-mode', { lastActivity: '2026-10-30T09:30:00Z' }), pane('b', 'fix-checkout-race')])],
        { sessions: [record('s1', 'Pane Fixes', ['b', 'a'])], statuses: [{ panelId: 'pa', sessionId: 'a', state: 'working', reason: null }] },
      )),
    ]);

    expect(tree.sessions[0].panes.map(item => item.pane.name)).toEqual(['fix-checkout-race', 'add-dark-mode']);
  });

  it('shows one project row for a repository cloned under different folder names on two machines', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'pane', [pane('a', 'cmd-f-find')], 'github.com/greenfield-inc/pane')])),
      view(build, snapshot([project(4, 'Pane-work', [pane('b', 'browser-session-persist')], 'github.com/greenfield-inc/pane')])),
    ]);

    expect(tree.projects.map(row => [row.name, row.entries.map(entry => entry.machine.name)])).toEqual([['pane', ['studio-mac', 'build-box']]]);
    expect(tree.projects[0].panes.map(item => `${item.pane.name} on ${item.machine.name}`)).toEqual(['cmd-f-find on studio-mac', 'browser-session-persist on build-box']);
  });

  it('keeps two repositories with the same folder name apart', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'web', [], 'github.com/acme/web')])),
      view(build, snapshot([project(1, 'web', [], 'github.com/other/web')])),
    ]);

    expect(tree.projects.map(row => row.entries.map(entry => entry.machine.name))).toEqual([['studio-mac'], ['build-box']]);
  });

  it('matches a project from a machine on an older Pane by its name', () => {
    const tree = buildAllMachinesTree([
      view(studio, snapshot([project(1, 'Acme-Web', [], 'github.com/acme/web')])),
      view(build, snapshot([project(2, 'acme-web', [])])),
      view({ id: 'old', name: 'old-mac', os: 'macOS', slot: 2, letters: 'O' }, snapshot([project(3, 'scratch', [])])),
    ]);

    expect(tree.projects.map(row => [row.name, row.entries.map(entry => entry.machine.name)])).toEqual([
      ['Acme-Web', ['studio-mac', 'build-box']],
      ['scratch', ['old-mac']],
    ]);
  });

  it('keeps an offline machine\'s rows, marked as from when it stopped answering', () => {
    const tree = buildAllMachinesTree([
      view(build, snapshot([project(2, 'infra', [pane('n', 'nightly-backup')])]), true),
    ]);

    expect(tree.panes.map(item => [item.pane.name, item.offline])).toEqual([['nightly-backup', true]]);
  });

  it('leaves out archived Sessions and lists each Session\'s Panes from its own machine', () => {
    const tree = buildAllMachinesTree([
      view(build, snapshot([project(1, 'infra', [pane('p1', 'nightly-backup')])], {
        sessions: [record('s1', 'Backup rotation', ['p1']), record('s2', 'Old', [], { archived: true })],
      })),
      view(studio, snapshot([project(1, 'acme-web', [pane('p1', 'fix-checkout-race')])])),
    ]);

    expect(tree.sessions.map(row => [row.key, row.session.name, row.panes.map(item => item.pane.name)])).toEqual([
      ['build-box-profile:s1', 'Backup rotation', ['nightly-backup']],
    ]);
  });
});

describe('savedOrderAfterMove', () => {
  it('saves the rows shown in their new order and keeps rows not shown in their places', () => {
    expect(savedOrderAfterMove(['a', 'archived', 'b', 'c'], ['new', 'c', 'a', 'b'])).toEqual(['new', 'c', 'archived', 'a', 'b']);
  });

  it('saves the rows shown when nothing was saved yet', () => {
    expect(savedOrderAfterMove(null, ['b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('seedArrangement', () => {
  const sessionsOf = (machine: MachineRef, names: string[], created = '2026-10-30T09:00:00Z') => names.map(name => record(`${machine.id}-${name}`, name, [], { createdAt: created }));
  const everything = () => true;

  it('takes each machine\'s first look in its own order, then puts later arrivals first', () => {
    const first = [
      view(studio, snapshot([project(1, 'web', [pane('a', 'studio-pane')], 'github.com/acme/web')], { sessions: sessionsOf(studio, ['Studio session']) })),
      { machine: build, snapshot: null, offline: false },
    ];
    // build-box answers a moment later: its rows are its first look, not arrivals.
    const seededOnce = seedArrangement({ sessions: null, panes: {}, seeded: [] }, first, everything);
    const later = [
      first[0],
      view(build, snapshot([project(9, 'web-clone', [pane('b', 'build-pane')], 'github.com/acme/web')], { sessions: sessionsOf(build, ['Build session']) })),
    ];
    const seeded = seedArrangement(seededOnce ?? { sessions: null, panes: {}, seeded: [] }, later, everything);
    expect(seeded?.sessions).toEqual(['local:local-Studio session', 'build-box-profile:build-box-profile-Build session']);
    expect(seeded?.panes['repo:github.com/acme/web']).toEqual(['local:a', 'build-box-profile:b']);
    expect(seedArrangement(seeded!, later, everything)).toBeNull();

    // A new Session and a new Pane on build-box, before anyone drags anything.
    const arrived = [
      first[0],
      view(build, snapshot(
        [project(9, 'web-clone', [pane('n', 'new-build-pane', { createdAt: '2026-10-31T09:00:00Z' }), pane('b', 'build-pane')], 'github.com/acme/web')],
        { sessions: [...sessionsOf(build, ['New build session'], '2026-10-31T09:00:00Z'), ...sessionsOf(build, ['Build session'])] },
      )),
    ];
    const tree = buildAllMachinesTree(arrived, seedArrangement(seeded!, arrived, everything) ?? seeded!);
    expect(tree.sessions.map(row => row.session.name)).toEqual(['New build session', 'Studio session', 'Build session']);
    expect(tree.projects[0].panes.map(row => row.pane.name)).toEqual(['new-build-pane', 'studio-pane', 'build-pane']);
  });

  it('keeps machine-menu order when a later machine answers first, for Sessions and a shared project\'s Panes', () => {
    const studioView = view(studio, snapshot([project(1, 'web', [pane('a', 'studio-pane')], 'github.com/acme/web')], { sessions: sessionsOf(studio, ['Studio session']) }));
    const buildView = view(build, snapshot([project(9, 'web-clone', [pane('b', 'build-pane')], 'github.com/acme/web')], { sessions: sessionsOf(build, ['Build session']) }));
    const third: MachineRef = { id: 'devbox', name: 'devbox', os: 'Linux', slot: 2, letters: 'D' };
    const thirdView = view(third, snapshot([project(4, 'web', [pane('c', 'devbox-pane')], 'github.com/acme/web')], { sessions: sessionsOf(third, ['Devbox session']) }));
    // Menu order: studio, build, devbox. They answer devbox, then studio, then build.
    const empty = { sessions: null, panes: {}, seeded: [] };
    const loading = (ready: MachineRef[]) => [studio, build, third].map(machine => {
      const loaded = ready.includes(machine);
      const full = machine === studio ? studioView : machine === build ? buildView : thirdView;
      return loaded ? full : { machine, snapshot: null, offline: false };
    });
    const afterDevbox = seedArrangement(empty, loading([third]), everything)!;
    const afterStudio = seedArrangement(afterDevbox, loading([third, studio]), everything)!;
    const seeded = seedArrangement(afterStudio, loading([third, studio, build]), everything)!;

    expect(seeded.sessions).toEqual(['local:local-Studio session', 'build-box-profile:build-box-profile-Build session', 'devbox:devbox-Devbox session']);
    expect(seeded.panes['repo:github.com/acme/web']).toEqual(['local:a', 'build-box-profile:b', 'devbox:c']);
  });

  it('puts a late machine\'s first look after the rows of machines before it, keeping your moves', () => {
    // studio and devbox looked first and you moved devbox's Session to the top; build-box answers last.
    const third: MachineRef = { id: 'devbox', name: 'devbox', os: 'Linux', slot: 2, letters: 'D' };
    const arranged = { sessions: ['devbox:devbox-Devbox session', 'local:local-Studio session'], panes: {}, seeded: ['sessions:local', 'sessions:devbox'] };
    const views = [
      view(studio, snapshot([], { sessions: sessionsOf(studio, ['Studio session']) })),
      view(build, snapshot([], { sessions: sessionsOf(build, ['Build session']) })),
      view(third, snapshot([], { sessions: sessionsOf(third, ['Devbox session']) })),
    ];

    expect(seedArrangement(arranged, views, everything)?.sessions).toEqual([
      'devbox:devbox-Devbox session', 'local:local-Studio session', 'build-box-profile:build-box-profile-Build session',
    ]);
  });

  it('waits for a machine\'s list to answer before taking its first look', () => {
    const views = [view(studio, snapshot([], { sessions: sessionsOf(studio, ['Studio session']) }))];
    expect(seedArrangement({ sessions: null, panes: {}, seeded: [] }, views, () => false)).toBeNull();
  });
});
