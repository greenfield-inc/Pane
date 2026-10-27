import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js/dist/module.no-external';
import type { ImportSession, SessionImportRunResult, SessionImportScan } from '../../../../shared/types/sessionImport';
import { SessionImportCard, ImportRows, ImportResult } from './SessionImportCard';
import { captureSessionImport } from './sessionImportCopy';

const HOUR = 60 * 60 * 1000;

function session(key: string, overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    key, source: 'claude', agent: 'claude', sessionId: key, title: `Fix ${key}`, branch: 'main',
    checkout: '/r/app', repoRoot: '/r/app', repoName: 'app', lastActiveMs: Date.now() - 2 * HOUR,
    running: 'no', alreadyInPane: false, preselected: true, ...overrides,
  };
}

const scan: SessionImportScan = {
  scannedAt: 0,
  sources: [
    { source: 'claude', status: 'ok', storePaths: ['/h/.claude/projects'] },
    { source: 'conductor', status: 'ok', storePaths: ['/h/conductor.db'] },
    { source: 'emdash', status: 'unreadable', version: '1.4', reason: 'unknown schema', storePaths: ['/h/emdash4.db'] },
  ],
  sessions: [
    session('a'),
    session('b', { checkout: '/r/api', repoRoot: '/r/api', repoName: 'api' }),
    session('c', { source: 'conductor', checkout: '/r/app-wt1' }),
    session('d', { source: 'conductor', checkout: '/r/app-wt2', running: 'yes', preselected: false }),
  ],
};

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
}

describe('SessionImportCard', () => {
  it('shows the approved collapsed card: one row per tool with preselected counts', () => {
    const shown = text(renderToStaticMarkup(<SessionImportCard surface="home" scan={scan} onClose={() => undefined} />));

    expect(shown).toContain('Bring your sessions into Pane');
    expect(shown).toContain('Pane found recent agent work on this computer. Each session opens as its own Pane, with the agent resumed.');
    expect(shown).toContain('Claude Code 2 sessions · 2 repos');
    expect(shown).toContain('Conductor workspaces 1 worktree');
    expect(shown).toContain("Emdash tasks Couldn't read Emdash 1.4");
    expect(shown).toContain('Check again');
    expect(shown).toContain('Not now Bring them in');
  });

  it('shows the empty state when nothing was found', () => {
    const shown = text(renderToStaticMarkup(<SessionImportCard surface="settings" scan={{ scannedAt: 0, sources: [], sessions: [] }} onClose={() => undefined} />));

    expect(shown).toContain('No sessions found from Claude Code, Codex, Conductor, Superset, Herdr, Emdash, Orca or T3 Code on this computer.');
    expect(shown).not.toContain('Pane found recent agent work');
    expect(shown).not.toContain('Bring them in');
  });

  it('counts older sessions when nothing is preselected', () => {
    const older: SessionImportScan = { ...scan, sessions: [session('a', { preselected: false }), session('b', { preselected: false })] };
    const shown = text(renderToStaticMarkup(<ImportRows scan={older} selected={new Set()} expanded={null} onExpand={() => undefined} onToggle={() => undefined} />));

    expect(shown).toContain('Claude Code 2 older sessions');
  });

  it('opens a row into its sessions grouped by repository, with status and the running help', () => {
    const shown = text(renderToStaticMarkup(
      <ImportRows scan={scan} selected={new Set(['c'])} expanded="conductor" onExpand={() => undefined} onToggle={() => undefined} />,
    ));

    expect(shown).toContain('app Fix c main · 2 hours ago Fix d main · 2 hours ago · Running in Conductor');
    expect(shown).toContain('Quit it in Conductor and press Check again, or say "migrate to Pane" in Pane Chat to fork it.');
  });

  it('shows progress per row while bringing sessions in', () => {
    const shown = text(renderToStaticMarkup(
      <ImportRows scan={scan} selected={new Set(['a'])} progress={{ running: true, done: { claude: 1 }, total: { claude: 2 } }} expanded={null} onExpand={() => undefined} onToggle={() => undefined} />,
    ));

    expect(shown).toContain('Claude Code 1 of 2');
  });

  it('reports the result with failures, trust waits and sessions left running', () => {
    const result: SessionImportRunResult = {
      panesCreated: 2,
      tabsInExistingPanes: 1,
      results: [
        { key: 'a', source: 'claude', agent: 'claude', title: 'Fix a', outcome: 'continued', paneId: 'p1', paneName: 'app' },
        { key: 'b', source: 'claude', agent: 'claude', title: 'Fix b', outcome: 'waiting for trust', paneId: 'p2', paneName: 'api' },
        { key: 'c', source: 'conductor', agent: 'claude', title: 'Fix c', outcome: 'continued', paneId: 'p0', paneName: 'old' },
        { key: 'e', source: 'claude', agent: 'claude', title: 'Fix e', outcome: 'not continued', reason: 'Claude Code has no saved conversation with this id on this computer, so there is nothing to resume.' },
      ],
    };
    const shown = text(renderToStaticMarkup(<ImportResult result={result} runningElsewhere={1} onDone={() => undefined} />));

    expect(shown).toContain('Brought in 3 sessions as 2 Panes and 1 tab in existing Panes.');
    expect(shown).toContain('1 waiting for you to trust its folder: api · Fix b');
    expect(shown).toContain('1 not continued Fix e : Claude Code has no saved conversation');
    expect(shown).toContain('1 still running elsewhere');
    expect(shown).toContain('Done');
  });
});

describe('session_import analytics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends one event per step with counts only', () => {
    const capture = vi.spyOn(posthog, 'capture').mockReturnValue(undefined);
    const result: SessionImportRunResult = {
      panesCreated: 1,
      tabsInExistingPanes: 0,
      results: [
        { key: 'a', source: 'claude', agent: 'claude', title: 'Fix a', outcome: 'continued', paneId: 'p1', paneName: 'app' },
        { key: 'b', source: 'claude', agent: 'claude', title: 'Fix b', outcome: 'not continued', reason: 'gone' },
      ],
    };

    captureSessionImport('shown', 'home', scan);
    captureSessionImport('dismissed', 'home', scan);
    captureSessionImport('started', 'settings', scan, { selected: 2 });
    captureSessionImport('finished', 'settings', scan, { selected: 2, result });

    const found = { claude: 2, conductor: 2 };
    const featureKeys = ['step', 'surface', 'found', 'selected', 'panes_created', 'tabs_added', 'continued', 'not_continued', 'waiting_trust', 'running_skipped'];
    const sent = capture.mock.calls.map(([name, properties]) => [
      name,
      Object.fromEntries(Object.entries(properties ?? {}).filter(([key]) => featureKeys.includes(key))),
    ]);
    expect(sent).toEqual([
      ['session_import', { step: 'shown', surface: 'home', found }],
      ['session_import', { step: 'dismissed', surface: 'home', found }],
      ['session_import', { step: 'started', surface: 'settings', found, selected: 2 }],
      ['session_import', {
        step: 'finished', surface: 'settings', found, selected: 2,
        panes_created: 1, tabs_added: 1, continued: 1, not_continued: 1, waiting_trust: 0, running_skipped: 1,
      }],
    ]);
    expect(JSON.stringify(capture.mock.calls)).not.toMatch(/Fix a|\/r\/app|"a"/);
  });
});
