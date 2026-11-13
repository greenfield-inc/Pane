import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppDirectory } from '../utils/appDirectory';
import {
  clearScratchArchived,
  deleteKeepingAgentLogs,
  expireArchivedFolders,
  markScratchArchived,
  preserveAgentLogs,
} from './archiveRetention';
import { parseArchiveRetentionDays } from '../../../shared/constants/archiveRetention';

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let paneDir: string;

function write(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A folder link: a junction on Windows (no privilege needed), a symbolic link elsewhere. */
function linkFolder(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')));
  paneDir = getAppDirectory();
});
afterEach(() => {
  for (const folder of [root, path.join(paneDir, 'agent-logs'), path.join(paneDir, 'scratch')]) fs.rmSync(folder, { recursive: true, force: true });
});

describe('archive retention', () => {
  it('keeps agent logs from a deleted folder and never touches the agents\' own folders behind a link inside it', async () => {
    const realHome = path.join(root, 'home');
    write(path.join(realHome, '.claude', 'projects', 'p', 'real.jsonl'), 'real');
    const worktree = path.join(root, 'worktree');
    const scratch = path.join(worktree, '.pane', 'scratch');
    write(path.join(scratch, 'qa', 'home', '.claude', 'projects', 'p', 'qa.jsonl'), 'qa');
    write(path.join(scratch, 'qa', 'home', '.codex', 'sessions', '2026', '11', '13', 'rollout.jsonl'), 'codex');
    write(path.join(scratch, 'clone', 'node_modules', 'pkg', '.claude', 'projects', 'dep.jsonl'), 'dep');
    linkFolder(path.join(realHome, '.claude'), path.join(scratch, '.claude'));

    await deleteKeepingAgentLogs(worktree, scratch, 'pane-1');

    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.readFileSync(path.join(realHome, '.claude', 'projects', 'p', 'real.jsonl'), 'utf8')).toBe('real');
    expect(fs.readFileSync(path.join(paneDir, 'agent-logs', 'claude', 'pane-1', 'claude-projects', '0', 'p', 'qa.jsonl'), 'utf8')).toBe('qa');
    expect(fs.readFileSync(path.join(paneDir, 'agent-logs', 'codex', 'pane-1', 'codex-sessions', '0', '2026', '11', '13', 'rollout.jsonl'), 'utf8')).toBe('codex');
    expect(fs.readdirSync(path.join(paneDir, 'agent-logs', 'claude', 'pane-1'))).toEqual(['claude-projects']);
  });

  it.each([
    ['the scratch folder itself', (worktree: string, home: string) => linkFolder(home, path.join(worktree, '.pane', 'scratch'))],
    ['its parent', (worktree: string, home: string) => linkFolder(home, path.join(worktree, '.pane'))],
  ])('never moves, walks or deletes the person\'s home when %s links to it', async (_where, link) => {
    const home = path.join(root, 'home');
    write(path.join(home, '.claude', 'projects', 'p', 'real.jsonl'), 'real');
    write(path.join(home, 'scratch', '.codex', 'sessions', 'r.jsonl'), 'codex');
    write(path.join(home, 'code', 'other', '.codex', 'sessions', 'r.jsonl'), 'nested');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    link(worktree, home);
    const scratch = path.join(worktree, '.pane', 'scratch');

    expect(await preserveAgentLogs(worktree, scratch, 'pane-1')).toEqual([]);
    await deleteKeepingAgentLogs(worktree, scratch, 'pane-1');

    expect(fs.readFileSync(path.join(home, '.claude', 'projects', 'p', 'real.jsonl'), 'utf8')).toBe('real');
    expect(fs.readFileSync(path.join(home, 'scratch', '.codex', 'sessions', 'r.jsonl'), 'utf8')).toBe('codex');
    expect(fs.readFileSync(path.join(home, 'code', 'other', '.codex', 'sessions', 'r.jsonl'), 'utf8')).toBe('nested');
    expect(fs.existsSync(path.join(paneDir, 'agent-logs'))).toBe(false);
  });

  it('deletes what has been archived longer than the retention period, and keeps the rest', async () => {
    const now = new Date('2026-11-30T00:00:00Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
    const sessions = path.join(root, 'sessions');
    const folders = {
      oldSession: path.join(sessions, 'old'),
      newSession: path.join(sessions, 'new'),
      restoredDuringPass: path.join(sessions, 'restored'),
    };
    for (const folder of Object.values(folders)) write(path.join(folder, 'report.md'));
    const scratch = (id: string) => path.join(paneDir, 'scratch', id);
    for (const id of ['old-session-pane', 'archived-pane', 'restored-pane', 'future-pane', 'deleted-pane', 'agent-made']) write(path.join(scratch(id), 'file'));
    await markScratchArchived('archived-pane', daysAgo(15));
    await markScratchArchived('restored-pane', daysAgo(15));
    await clearScratchArchived('restored-pane');
    await markScratchArchived('future-pane', new Date(now.getTime() + 30 * DAY));
    await markScratchArchived('deleted-pane', new Date(0));

    const deleted = await expireArchivedFolders({
      now,
      retentionDays: 14,
      archivedSessions: [
        { id: 'old', folder: folders.oldSession, paneId: 'old-session-pane', archivedAt: daysAgo(15) },
        { id: 'new', folder: folders.newSession, paneId: 'new-session-pane', archivedAt: daysAgo(13) },
        { id: 'restored', folder: folders.restoredDuringPass, paneId: 'restored-session-pane', archivedAt: daysAgo(15) },
      ],
      // Restored after the pass read the store: checked again right before the delete.
      sessionIsArchived: id => id !== 'restored',
      paneIsArchivedOrGone: () => true,
    });

    expect(deleted.sort()).toEqual([folders.oldSession, scratch('archived-pane'), scratch('deleted-pane'), scratch('old-session-pane')].sort());
    for (const kept of [folders.newSession, folders.restoredDuringPass, scratch('restored-pane'), scratch('future-pane'), scratch('agent-made')]) {
      expect(fs.existsSync(kept)).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('skips a folder it cannot delete and carries on with the rest', async () => {
    const now = new Date('2026-11-30T00:00:00Z');
    const scratch = (id: string) => path.join(paneDir, 'scratch', id);
    write(path.join(scratch('stuck-pane'), 'locked', 'file'));
    write(path.join(scratch('free-pane'), 'file'));
    fs.chmodSync(path.join(scratch('stuck-pane'), 'locked'), 0o500);
    for (const id of ['stuck-pane', 'free-pane']) await markScratchArchived(id, new Date(0));
    try {
      const deleted = await expireArchivedFolders({ now, retentionDays: 14, archivedSessions: [], sessionIsArchived: () => true, paneIsArchivedOrGone: () => true });
      expect(deleted).toEqual([scratch('free-pane')]);
      expect(fs.existsSync(scratch('stuck-pane'))).toBe(true);
    } finally {
      fs.chmodSync(path.join(scratch('stuck-pane'), 'locked'), 0o700);
    }
  });

  it.each([
    ['0', null], ['1', 1], ['14', 14], ['365', 365], ['366', null], ['1.5', null], ['-3', null], ['', null], [' 7 ', 7],
  ])('reads the Keep archived folders setting %j as %j', (text, days) => {
    expect(parseArchiveRetentionDays(text)).toBe(days);
  });
});
