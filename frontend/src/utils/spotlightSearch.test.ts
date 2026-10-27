import { describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { HotkeyDefinition } from '../stores/hotkeyStore';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import { buildSearchItems, searchItems, type SearchItem, type SearchResults, type SearchSources } from './spotlightSearch';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function project(id: number, name: string): Project {
  return { id, name, path: `/code/${name}`, active: false, created_at: ago(9999), updated_at: ago(9999) };
}

function pane(id: string, name: string, projectId: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    name,
    worktreePath: `/code/worktrees/${name}`,
    prompt: '',
    status: 'stopped',
    createdAt: ago(5000),
    output: [],
    jsonMessages: [],
    projectId,
    ...extra,
  };
}

function session(id: string, name: string, updatedMinutesAgo: number, paneIds: string[] = []): OrchestrationSessionRecord {
  return {
    id,
    name,
    agent: 'claude',
    internalSessionId: `${id}-terminal`,
    panelIds: { claude: `${id}-claude`, codex: `${id}-codex`, cursor: `${id}-cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [],
    associations: paneIds.map(paneId => ({ paneId, panelIds: [], attachedAt: ago(100) })),
    activity: [],
    revision: 1,
    createdAt: ago(9000),
    updatedAt: ago(updatedMinutesAgo),
  };
}

function command(id: string, label: string, keys = '', extra: Partial<HotkeyDefinition> = {}): HotkeyDefinition {
  return { id, label, keys, category: 'session', action: () => {}, ...extra };
}

const PANE = project(1, 'Pane');
const EXPERIMENTS = project(2, 'experiments');
const BLOOM = project(3, 'bloom-mono');
const BENCHMARK = project(4, 'pane-agent-orchestration-benchmark');

function sources(overrides: Partial<SearchSources> = {}): SearchSources {
  return {
    panes: [
      pane('p-posthog', 'pane posthog', 1, { isFavorite: true, lastViewedAt: ago(2880) }),
      pane('p-film', 'pane-workspaces-film', 2, { lastViewedAt: ago(3000) }),
      pane('p-wsl', 'wsl-runpane', 1, {
        lastViewedAt: ago(60),
        gitStatus: { state: 'ahead', prNumber: 1105, prTitle: 'Make runpane work in Pane’s WSL terminals', prUrl: 'https://github.com/greenfield-inc/Pane/pull/1105' },
      }),
      pane('p-update', 'runpane-update-fix', 1, { lastViewedAt: ago(1), lastActivity: ago(0) }),
      pane('p-optout', 'posthog-optout-heartbeat', 1, { lastViewedAt: ago(20000) }),
      pane('p-polish', 'ui-polish-app', 3, { lastViewedAt: ago(5), worktreePath: '/code/worktrees/polish-branch' }),
      pane('p-spotlight', 'spotlight-search', 1, { lastViewedAt: ago(0) }),
      pane('p-archived', 'archived-thing', 1, { archived: true }),
    ],
    sessions: [
      session('s-contrib', 'pane contributors', 0, ['p-spotlight']),
      session('s-ui', 'Pane UI', 120, ['p-film', 'p-wsl', 'p-update']),
      session('s-old', 'pane posthog', 2880, ['p-posthog']),
    ],
    projects: [PANE, EXPERIMENTS, BLOOM, BENCHMARK],
    commands: [
      command('open-command-palette', 'Open Search', 'mod+shift+p'),
      command('new-session', 'New Pane', 'mod+n'),
      command('new-orchestration-session', 'New Session'),
      command('open-settings', 'Open Settings', 'mod+,'),
      command('cycle-session-next-0', 'Next Pane', 'mod+Tab'),
      command('cycle-session-prev-0', 'Previous Pane', 'mod+shift+Tab'),
      command('archive-active-session', 'Archive Pane', 'mod+shift+w'),
      command('switch-session-1', 'Switch to wsl-runpane (Pane)', 'mod+1'),
      command('toggle-sidebar', 'Toggle Sidebar', 'mod+b'),
    ],
    activePaneId: 'p-spotlight',
    selectedSessionId: 's-contrib',
    ...overrides,
  };
}

const run = (query: string, filter: Parameters<typeof searchItems>[1]['filter'] = 'all', src = sources()) =>
  searchItems(buildSearchItems(src), { query, filter });

const titles = (items: SearchItem[]) => items.map(item => item.title);
const flat = (results: SearchResults) => results.sections.flatMap(section => section.items);

describe('spotlight search ranking', () => {
  it('finds a Pane by its initials', () => {
    expect(flat(run('rpuf'))[0].title).toBe('runpane-update-fix');
  });
});

describe('spotlight search journeys', () => {
  it('lists a misspelt name in the top two', () => {
    expect(titles(flat(run('postog')).slice(0, 2))).toContain('pane posthog');
  });

  it('puts the Archive Pane command first for words of its label', () => {
    expect(flat(run('arch pane'))[0].title).toBe('Archive Pane');
  });

  it('finds a Pane by its branch, project, PR number and a word of its PR title', () => {
    expect(flat(run('polish-branch'))[0].title).toBe('ui-polish-app');
    expect(titles(run('bloom-mono', 'panes').sections[0].items)).toEqual(['ui-polish-app']);
    expect(flat(run('1105'))[0].title).toBe('wsl-runpane');
    expect(flat(run('terminals'))[0].title).toBe('wsl-runpane');
  });

  it('leaves out archived Panes', () => {
    expect(flat(run('archived-thing'))).toEqual([]);
  });

  it('shows a Top hit, then Panes, Sessions, Projects and Commands, each capped', () => {
    const results = run('pane');
    expect(results.sections.map(section => section.label))
      .toEqual(['Top hit', 'Panes', 'Sessions', 'Projects', 'Commands']);
    // The project named exactly "Pane" outranks names that only start with it.
    expect(results.sections[0].items[0].title).toBe('Pane');
    const panes = results.sections[1];
    expect(panes.items).toHaveLength(3);
    expect(panes.more).toBeGreaterThan(0);
  });

  it('replaces the Switch to commands with the real items', () => {
    const items = flat(run('switch'));
    expect(items.some(item => item.kind === 'command' && item.title.startsWith('Switch to'))).toBe(false);
  });

  it('orders matches of one strength by recency, whichever name sorts first', () => {
    // Both names contain "runpane" past their first word: one tier, one key.
    const tie = (alphaMinutes: number, betaMinutes: number) => sources({
      panes: [
        pane('p-a', 'alpha-runpane', 1, { lastViewedAt: ago(alphaMinutes) }),
        pane('p-b', 'beta-runpane', 1, { lastViewedAt: ago(betaMinutes) }),
      ],
    });
    expect(titles(run('runpane', 'panes', tie(60, 1)).sections[0].items)).toEqual(['beta-runpane', 'alpha-runpane']);
    expect(titles(run('runpane', 'panes', tie(1, 60)).sections[0].items)).toEqual(['alpha-runpane', 'beta-runpane']);
  });

  it('orders fuzzy matches by recency before letter distance', () => {
    // "pg" fuzzily matches both; posthog's letters sit closer, pane-testing was used more recently.
    const src = sources({
      panes: [
        pane('p-old', 'posthog', 1, { lastViewedAt: ago(600) }),
        pane('p-new', 'pane-testing', 1, { lastViewedAt: ago(5) }),
      ],
    });
    expect(titles(run('pg', 'panes', src).sections[0].items)).toEqual(['pane-testing', 'posthog']);
  });

  it('finds a command by its shortcut or its id', () => {
    expect(titles(run('mod+,', 'commands').sections[0]?.items ?? [])).toEqual(['Open Settings']);
    expect(titles(run('open-settings', 'commands').sections[0]?.items ?? [])).toEqual(['Open Settings']);
  });

  it('lists every match in a filtered view', () => {
    const results = run('pane', 'panes');
    expect(results.sections).toHaveLength(1);
    expect(results.sections[0].more).toBe(0);
    expect(titles(results.sections[0].items).sort()).toEqual([
      // posthog-optout-heartbeat and spotlight-search match through their project, Pane.
      'pane posthog', 'pane-workspaces-film', 'posthog-optout-heartbeat', 'runpane-update-fix', 'spotlight-search', 'wsl-runpane',
    ].sort());
  });

  it('selects Commands for a leading >', () => {
    const results = run('> pane');
    expect(results.filter).toBe('commands');
    expect(flat(results).every(item => item.kind === 'command')).toBe(true);
    expect(titles(flat(results))).toContain('New Pane');
  });

  it('lists disabled commands after enabled ones', () => {
    const src = sources();
    src.commands = [command('first', 'Pane disabled', '', { enabled: () => false }), ...src.commands];
    const listed = titles(run('pane', 'commands', src).sections[0].items);
    expect(listed[listed.length - 1]).toBe('Pane disabled');
  });
});

describe('spotlight search with an empty query', () => {
  it('shows Recent without the current Pane, previously viewed first, then Suggested', () => {
    const results = run('');
    expect(results.sections.map(section => section.label)).toEqual(['Recent', 'Suggested']);
    const recent = titles(results.sections[0].items);
    expect(recent).not.toContain('spotlight-search');
    // runpane-update-fix leads although the Session pane contributors updated after it was viewed.
    expect(recent.slice(0, 2)).toEqual(['runpane-update-fix', 'pane contributors']);
    expect(titles(results.sections[1].items)).toEqual(['New Pane', 'New Session', 'Open Settings']);
  });
});

describe('matchedRanges', () => {
  it('marks a run of letters or each initial', async () => {
    const { matchedRanges } = await import('./spotlightSearch');
    expect(matchedRanges('wsl-runpane', 'pane')).toEqual([[7, 11]]);
    expect(matchedRanges('runpane-update-fix', 'rpuf')).toEqual([[0, 1], [3, 4], [8, 9], [15, 16]]);
  });
});
