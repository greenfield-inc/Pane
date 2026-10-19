import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpectedReportTracker, MAX_MISSING_REPORT_OUTPUT_LENGTH, type PanelLastOutput } from './expectedReports';
import { WorkspaceJournal } from './workspaceJournal';
import type { TerminalExpectedReport } from '../../../shared/types/panels';
import { detectAgentBackgroundWork } from './agents/agentScreenSignature';
import { CLAUDE_API_ENOTFOUND_SCREEN, CLAUDE_API_SLEEP_SCREEN } from './agentStatus/__fixtures__/claudeApiErrorScreens';

function setup(lastOutput: PanelLastOutput | undefined = { text: 'All done, PR #12 is open.', source: 'transcript' }, filePath?: string) {
  const journal = new WorkspaceJournal({ resolvePane: paneId => ({ paneId, paneName: 'Worker' }), blockedDebounceMs: 0 });
  const reports = new Map<string, string>();
  const background = new Map<string, string>();
  const tracker = new ExpectedReportTracker({
    journal,
    filePath,
    lastReportAt: panelId => reports.get(panelId),
    lastOutput: async () => lastOutput,
    backgroundWork: panelId => background.get(panelId),
    recheckMs: 1_000,
  });
  const expectations = {
    set: (panelId: string, expected: TerminalExpectedReport) => tracker.arm(panelId, expected.since),
    has: (panelId: string) => tracker.expectation(panelId) !== undefined,
  };
  const busy = () => journal.append({ kind: 'agent.busy', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', agentType: 'claude', source: 'agent' });
  const ready = () => journal.append({ kind: 'agent.ready', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', agentType: 'claude', source: 'agent' });
  const missing = () => journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { journal, expectations, reports, background, tracker, ready, busy, missing, settle };
}

describe('ExpectedReportTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses overlapping work until output collection finishes, even if a report arrives', async () => {
    const journal = new WorkspaceJournal();
    let release!: (value: PanelLastOutput) => void;
    const tracker = new ExpectedReportTracker({ journal, lastReportAt: () => undefined,
      lastOutput: () => new Promise(resolve => { release = resolve; }) });
    tracker.arm('panel-1', '2026-10-15T10:00:00.000Z');
    journal.appendPaneEntry('pane-1', { kind: 'agent.ready', panelId: 'panel-1', source: 'agent' });
    expect(() => tracker.arm('panel-1', '2026-10-15T10:01:00.000Z')).toThrow(/wait/i);
    journal.appendPaneEntry('pane-1', { kind: 'agent.report', panelId: 'panel-1', source: 'agent' });
    expect(() => tracker.arm('panel-1', '2026-10-15T10:01:00.000Z')).toThrow(/wait/i);
    release({ text: 'A finished', source: 'screen' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries).toEqual([]);
    expect(() => tracker.arm('panel-1', '2026-10-15T10:01:00.000Z')).not.toThrow();
    tracker.dispose();
  });

  it('retries a failed durable missing outcome after reopening the stores', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-missing-retry-'));
    const journalPath = path.join(directory, 'journal', 'state.json');
    const filePath = path.join(directory, 'expected.json');
    const options = { filePath, lastReportAt: () => undefined,
      lastOutput: async () => ({ text: 'Finished silently', source: 'screen' as const }) };
    let journal = new WorkspaceJournal({ filePath: journalPath });
    let tracker = new ExpectedReportTracker({ ...options, journal });
    tracker.arm('panel-1', '2026-10-15T10:00:00.000Z');
    journal.appendPaneEntry('pane-1', { kind: 'agent.ready', panelId: 'panel-1', source: 'agent' });
    // Fail the outcome's rename, after READY was committed and before output resolves.
    fs.mkdirSync(journalPath + '.saved');
    fs.renameSync(journalPath, path.join(journalPath + '.saved', 'state.json'));
    fs.mkdirSync(journalPath);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tracker.expectation('panel-1')).toEqual({ since: '2026-10-15T10:00:00.000Z' });
    tracker.dispose();
    journal.dispose();
    fs.rmdirSync(journalPath);
    fs.renameSync(path.join(journalPath + '.saved', 'state.json'), journalPath);
    journal = new WorkspaceJournal({ filePath: journalPath });
    tracker = new ExpectedReportTracker({ ...options, journal });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries).toEqual([
      expect.objectContaining({ lastOutput: 'Finished silently', expectedSince: '2026-10-15T10:00:00.000Z' }),
    ]);
    expect(tracker.expectation('panel-1')).toBeUndefined();
    tracker.dispose();
    journal.dispose();
    fs.rmSync(directory, { recursive: true });
  });

  it.each([['panel.exited', 'exited'], ['agent.ready', 'ready']] as const)('wakes an agents-only missing-report watch for an unidentified wrapper on %s', async (kind, reason) => {
    const { journal, tracker } = setup();
    try {
      tracker.arm('wrapper-1', '2026-10-15T10:00:00.000Z');
      const waiting = journal.waitAfter(0, { agentsOnly: true, kinds: ['agent.report.missing'] }, 100);
      journal.appendPaneEntry('pane-1', { kind, panelId: 'wrapper-1', source: 'agent' });

      expect(await waiting).toMatchObject({ timedOut: false, entries: [{
        kind: 'agent.report.missing', panelId: 'wrapper-1',
        reason,
        lastOutput: 'All done, PR #12 is open.',
      }] });
      expect(journal.readAfter(0, { agentsOnly: true }).entries.some(entry => entry.kind === 'agent.report.missing')).toBe(false);
    } finally {
      tracker.dispose();
      journal.dispose();
    }
  });

  it.each(['agent.blocked', 'agent.unknown', 'panel.stopped'] as const)(
    'keeps deferred work after restart when READY was superseded by %s', async (kind) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expected-state-'));
      const journalPath = path.join(directory, 'journal.json');
      let backgroundWork = true;
      const options = { filePath: path.join(directory, 'expected.json'), lastReportAt: () => undefined,
        lastOutput: async () => ({ text: 'Finished', source: 'screen' as const }),
        backgroundWork: () => backgroundWork ? '1 shell' : undefined };
      let journal = new WorkspaceJournal({ filePath: journalPath });
      let tracker = new ExpectedReportTracker({ ...options, journal });
      const since = '2026-10-15T10:00:00.000Z';
      try {
        tracker.arm('panel-1', since);
        journal.appendPaneEntry('pane-1', { kind: 'agent.ready', panelId: 'panel-1', source: 'agent' });
        journal.appendPaneEntry('pane-1', { kind, panelId: 'panel-1', source: 'agent' });
        tracker.dispose();
        journal.dispose();
        backgroundWork = false;
        journal = new WorkspaceJournal({ filePath: journalPath });
        tracker = new ExpectedReportTracker({ ...options, journal });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries).toEqual([]);
        expect(tracker.expectation('panel-1')).toEqual({ since });
        // A later completion still owns the original expectation.
        journal.appendPaneEntry('pane-1', { kind: 'agent.ready', panelId: 'panel-1', source: 'agent' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries).toEqual([
          expect.objectContaining({ expectedSince: since, lastOutput: 'Finished', reason: 'ready' }),
        ]);
      } finally {
        tracker.dispose();
        journal.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('journals agent.report.missing with the last reply when an expected report never came', async () => {
    const { expectations, ready, missing, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    ready();
    await settle();

    expect(missing()).toEqual([expect.objectContaining({
      kind: 'agent.report.missing',
      paneId: 'pane-1',
      panelId: 'panel-1',
      agentType: 'claude',
      reason: 'ready',
      expectedSince: '2026-10-15T10:00:00.000Z',
      lastOutput: 'All done, PR #12 is open.',
      lastOutputSource: 'transcript',
    })]);
    // One missing report per expectation.
    expect(expectations.has('panel-1')).toBe(false);
    ready();
    await settle();
    expect(missing()).toHaveLength(1);
  });

  it('stays quiet when the agent reported after the work was sent', async () => {
    const { expectations, reports, ready, missing, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    reports.set('panel-1', '2026-10-15T10:05:00.000Z');
    ready();
    await settle();

    expect(missing()).toEqual([]);
    expect(expectations.has('panel-1')).toBe(false);
  });

  it('treats a report from before the work was sent as missing', async () => {
    const { expectations, reports, journal, missing, settle } = setup({ text: 'line one\nline two', source: 'screen' });
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    reports.set('panel-1', '2026-10-15T09:00:00.000Z');
    journal.append({ kind: 'panel.exited', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', source: 'exit' });
    await settle();

    expect(missing()).toEqual([expect.objectContaining({ reason: 'exited', lastOutput: 'line one\nline two', lastOutputSource: 'screen' })]);
  });

  it('clears the expectation when the report arrives', async () => {
    const { expectations, journal, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    journal.append({ kind: 'agent.report', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', source: 'agent' });
    await settle();

    expect(expectations.has('panel-1')).toBe(false);
  });

  it('keeps the end of a long reply', async () => {
    const text = `${'x'.repeat(5_000)}THE END`;
    const { expectations, ready, missing, settle } = setup({ text, source: 'transcript' });
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    ready();
    await settle();

    const [entry] = missing();
    expect(entry.lastOutput).toHaveLength(MAX_MISSING_REPORT_OUTPUT_LENGTH);
    expect(entry.lastOutput?.endsWith('THE END')).toBe(true);
  });

  it('keeps expectations across a restart and forgets them once raised', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expected-'));
    try {
      const filePath = path.join(directory, 'expected-reports.json');
      setup(undefined, filePath).tracker.arm('panel-1', '2026-10-15T10:00:00.000Z');

      const restarted = setup(undefined, filePath);
      expect(restarted.tracker.expectation('panel-1')).toEqual({ since: '2026-10-15T10:00:00.000Z' });
      restarted.ready();
      await restarted.settle();
      expect(restarted.missing()).toHaveLength(1);

      const again = setup(undefined, filePath);
      again.ready();
      await again.settle();
      expect(again.missing()).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores panels nobody expects a report from', async () => {
    const { ready, missing, settle } = setup();
    ready();
    await settle();

    expect(missing()).toEqual([]);
  });

  it('waits while the agent still runs background work, then raises once it has ended', async () => {
    vi.useFakeTimers();
    const { expectations, background, ready, missing } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    background.set('panel-1', '1 shell');
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(missing()).toEqual([]);
    expect(expectations.has('panel-1')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(missing()).toEqual([]);

    // Codex takes no new turn when a background terminal ends, so the recheck raises it.
    background.delete('panel-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(missing()).toEqual([expect.objectContaining({ kind: 'agent.report.missing', reason: 'ready' })]);
  });

  it('lets the follow-up turn decide when the agent wakes for its finished background work', async () => {
    vi.useFakeTimers();
    const { expectations, reports, background, ready, busy, missing } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    background.set('panel-1', 'background agent general-purpose');
    ready();
    await vi.advanceTimersByTimeAsync(0);

    // Claude wakes when its subagent finishes, works, and this time reports.
    background.delete('panel-1');
    busy();
    reports.set('panel-1', '2026-10-15T10:05:00.000Z');
    ready();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(missing()).toEqual([]);
    expect(expectations.has('panel-1')).toBe(false);
  });

  it('raises at once when a panel exits with background work still listed', async () => {
    const { expectations, background, journal, missing, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    background.set('panel-1', '1 shell');
    journal.append({ kind: 'panel.exited', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', source: 'exit' });
    await settle();

    expect(missing()).toEqual([expect.objectContaining({ reason: 'exited' })]);
  });
});

/**
 * A worker launched with `--tool-command "agent-farm run …"`: Pane sees a plain command until it
 * identifies Claude Code behind it (by process or screen), then treats it as a Claude panel.
 */
describe('ExpectedReportTracker with an agent-farm wrapper', () => {
  const API_ERROR = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

  /** What the daemon knows about the wrapper panel's agent, before and after detection. */
  interface WrapperIdentity {
    isCliPanel: boolean;
    agentType?: string;
  }

  function wrapperSetup(screen: string) {
    const identity: WrapperIdentity = { isCliPanel: false };
    const journal = new WorkspaceJournal({
      resolvePane: paneId => ({ paneId, paneName: 'Farm worker' }),
      resolvePanel: panelId => ({ panelId, paneId: 'pane-1', ...identity }),
      blockedDebounceMs: 0,
    });
    const tracker = new ExpectedReportTracker({
      journal,
      lastReportAt: () => undefined,
      // The transcript's last assistant message is Claude's synthetic API error.
      lastOutput: async () => ({ text: API_ERROR, source: 'transcript' }),
      backgroundWork: () => detectAgentBackgroundWork(screen, 'claude'),
    });
    const status = (state: string, reason?: string) =>
      journal.send('panel:agentStatus', { panelId: 'panel-1', sessionId: 'pane-1', state, reason });
    const detectClaude = () => {
      identity.isCliPanel = true;
      identity.agentType = 'claude';
    };
    const missing = () => journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries;
    return { journal, tracker, status, detectClaude, missing };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('raises a missing report when a wrapped worker goes idle without reporting', async () => {
    const { tracker, status, detectClaude, missing } = wrapperSetup(CLAUDE_API_ENOTFOUND_SCREEN);
    tracker.arm('panel-1', '2026-10-17T16:00:00.000Z');
    detectClaude();
    status('working', 'agent_detected');
    status('idle');
    await settle();

    expect(missing()).toEqual([expect.objectContaining({
      kind: 'agent.report.missing', panelId: 'panel-1', agentType: 'claude', reason: 'ready', lastOutput: API_ERROR,
    })]);
  });

  it('raises one for a turn that ended on a network error or a sleep mid-response', async () => {
    for (const screen of [CLAUDE_API_ENOTFOUND_SCREEN, CLAUDE_API_SLEEP_SCREEN]) {
      const { tracker, status, detectClaude, missing } = wrapperSetup(screen);
      detectClaude();
      status('idle', 'agent_detected');
      tracker.arm('panel-1', '2026-10-17T16:00:00.000Z');
      // The retries keep it working; the error ends the turn.
      status('working');
      status('idle');
      await settle();
      expect(missing()).toHaveLength(1);
    }
  });

  it('raises nothing from idle before Pane identifies the agent, only from an exit (#743)', async () => {
    const { journal, tracker, status, missing } = wrapperSetup(CLAUDE_API_ENOTFOUND_SCREEN);
    tracker.arm('panel-1', '2026-10-17T16:00:00.000Z');
    status('working');
    status('idle');
    await settle();
    expect(missing()).toEqual([]);

    journal.send('panel:event', { type: 'terminal:exit', source: { panelId: 'panel-1', sessionId: 'pane-1' }, data: { exitCode: 1 } });
    await settle();
    expect(missing()).toEqual([expect.objectContaining({ reason: 'exited', lastOutput: API_ERROR })]);
  });
});

