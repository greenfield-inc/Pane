import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceJournal } from './workspaceJournal';

describe('durable PR event delivery', () => {
  it('keeps the old baseline and cursor on rename failure, then publishes a readable snapshot before waking', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-journal-'));
    try {
      const filePath = path.join(directory, 'journal.json');
      const journal = new WorkspaceJournal({ filePath });
      journal.commitGithubState({ head: 'old' }, []);
      const wake = journal.waitAfter(0, { kinds: ['pr.head'] }, 1000).then(result => {
        const disk = new WorkspaceJournal({ filePath });
        expect(disk.githubState).toEqual({ head: 'new' });
        expect(disk.readAfter(0, { kinds: ['pr.head'] }).entries).toEqual(result.entries);
        return result;
      });
      const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
      expect(() => journal.commitGithubState({ head: 'new' }, [{ paneId: 'worker', kind: 'pr.head', source: 'github' }])).toThrow('disk failure');
      rename.mockRestore();
      expect(journal.generation).toBe(0);
      expect(journal.githubState).toEqual({ head: 'old' });
      expect(new WorkspaceJournal({ filePath }).githubState).toEqual({ head: 'old' });
      journal.commitGithubState({ head: 'new' }, [{ paneId: 'worker', kind: 'pr.head', source: 'github' }]);
      expect((await wake).entries).toHaveLength(1);
      journal.dispose();
    } finally { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('retries agent and exit transitions after a failed durable write', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-journal-'));
    const filePath = path.join(directory, 'journal.json');
    try {
      const journal = new WorkspaceJournal({ filePath,
        resolvePane: () => ({ paneId: 'worker', paneName: 'Worker' }),
        resolvePanel: () => ({ panelId: 'panel', paneId: 'worker', isCliPanel: true }),
      });
      const status = { panelId: 'panel', sessionId: 'worker', state: 'working' };
      journal.send('panel:agentStatus', status);
      rmSync(filePath); mkdirSync(filePath);
      expect(() => journal.send('panel:agentStatus', { ...status, state: 'idle' })).toThrow();
      expect(journal.readySince('panel')).toBeUndefined();
      rmSync(filePath, { recursive: true });
      journal.send('panel:agentStatus', { ...status, state: 'idle' });
      expect(journal.readAfter(0, { kinds: ['agent.ready'] }).entries).toHaveLength(1);
      const exit = { type: 'terminal:exit', source: { panelId: 'panel', sessionId: 'worker' }, data: { exitCode: 0 } };
      rmSync(filePath); mkdirSync(filePath);
      expect(() => journal.send('panel:event', exit)).toThrow();
      rmSync(filePath, { recursive: true });
      journal.send('panel:event', exit);
      expect(journal.readAfter(0, { kinds: ['panel.exited'] }).entries).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('reloads missing reports and blocked prompts with their output and screen lines', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-journal-'));
    try {
      const filePath = path.join(directory, 'journal.json');
      const journal = new WorkspaceJournal({ filePath });
      journal.appendPaneEntry('worker', { kind: 'agent.blocked', panelId: 'panel', source: 'agent', screenLines: ['Red or blue?', '❯ 1. Red'] });
      journal.appendPaneEntry('worker', {
        kind: 'agent.report.missing', panelId: 'panel', source: 'agent', reason: 'ready',
        expectedSince: '2026-10-15T10:00:00.000Z', lastOutput: 'Opened PR #12.', lastOutputSource: 'transcript',
      });
      journal.dispose();

      const reloaded = new WorkspaceJournal({ filePath });
      expect(reloaded.readAfter(0, { kinds: ['agent.blocked', 'agent.report.missing'] }).entries).toEqual([
        expect.objectContaining({ kind: 'agent.blocked', screenLines: ['Red or blue?', '❯ 1. Red'] }),
        expect.objectContaining({ kind: 'agent.report.missing', lastOutput: 'Opened PR #12.', lastOutputSource: 'transcript', expectedSince: '2026-10-15T10:00:00.000Z' }),
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('restores the baseline and unread events together without changing cursor identity', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-journal-'));
    try {
      const filePath = path.join(directory, 'journal.json');
      const first = new WorkspaceJournal({ filePath });
      first.commitGithubState({ tracked: 'new-head' }, [{ paneId: 'worker', kind: 'pr.head', source: 'github' }]);
      const second = new WorkspaceJournal({ filePath });
      expect(second.epoch).toBe(first.epoch);
      expect(second.githubState).toEqual({ tracked: 'new-head' });
      expect(second.readAfter(0, { kinds: ['pr.head'] }).entries).toMatchObject([{ gen: 1, kind: 'pr.head' }]);
      expect(second.readAfter(1, { kinds: ['pr.head'] }).entries).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('loads a journal an older build wrote with panel.resumed entries, skipping them', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-journal-'));
    try {
      const filePath = path.join(directory, 'journal.json');
      const first = new WorkspaceJournal({ filePath });
      first.commitGithubState({ tracked: 'head' }, [{ paneId: 'worker', kind: 'pr.head', source: 'github' }]);
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      saved.entries.push({
        gen: 2, at: '2026-10-18T09:00:00.000Z', paneId: 'worker', paneName: 'worker', kind: 'panel.resumed',
        panelId: 'panel-1', source: 'session', reason: 'pane-start', nudged: true, interruptedAt: '2026-10-18T08:59:00.000Z',
      });
      saved.generation = 2;
      fs.writeFileSync(filePath, JSON.stringify(saved));

      const second = new WorkspaceJournal({ filePath });
      expect(second.epoch).toBe(first.epoch);
      expect(second.readAfter(0, { kinds: ['pr.head'] }).entries).toMatchObject([{ gen: 1, kind: 'pr.head' }]);
      second.appendPaneEntry('worker', { kind: 'panel.stopped', panelId: 'panel-1', source: 'session' });
      expect(second.readAfter(0, { kinds: ['panel.stopped'] }).entries).toMatchObject([{ gen: 3, kind: 'panel.stopped' }]);

      saved.entries.push({ ...saved.entries[0], gen: 3, kind: 'pane.unheard-of' });
      fs.writeFileSync(filePath, JSON.stringify(saved));
      expect(() => new WorkspaceJournal({ filePath })).toThrow(/watch journal could not be read/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

it('counts meaningful activity even when output filters hide it', () => {
  const journal = new WorkspaceJournal();
  journal.appendPaneEntry('worker', { kind: 'agent.busy', source: 'agent' });
  expect(journal.activityGeneration({ paneIds: ['worker'], kinds: ['agent.report'] })).toBe(1);
  journal.appendPaneEntry('other', { kind: 'agent.report', source: 'agent' });
  journal.appendPaneEntry('worker', { kind: 'agent.idle', source: 'agent' });
  expect(journal.activityGeneration({ paneIds: ['worker'], kinds: ['agent.report'] })).toBe(1);
});
