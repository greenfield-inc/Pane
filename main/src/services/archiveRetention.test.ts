import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppDirectory } from '../utils/appDirectory';
import { deleteKeepingAgentLogs, expireArchivedFolders, markScratchArchived } from './archiveRetention';

let root: string;
let paneDir: string;

function write(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-retention-')));
  paneDir = getAppDirectory();
});
afterEach(() => {
  for (const folder of [root, path.join(paneDir, 'agent-logs'), path.join(paneDir, 'scratch')]) fs.rmSync(folder, { recursive: true, force: true });
});

describe('archive retention', () => {
  it('keeps agent logs from a deleted folder and never touches the agents\' own folders behind a link', async () => {
    const realHome = path.join(root, 'home');
    write(path.join(realHome, '.claude', 'projects', 'p', 'real.jsonl'), 'real');
    const scratch = path.join(root, 'scratch');
    write(path.join(scratch, 'qa', 'home', '.claude', 'projects', 'p', 'qa.jsonl'), 'qa');
    write(path.join(scratch, 'qa', 'home', '.codex', 'sessions', '2026', '11', '13', 'rollout.jsonl'), 'codex');
    write(path.join(scratch, 'clone', 'node_modules', 'pkg', '.claude', 'projects', 'dep.jsonl'), 'dep');
    fs.symlinkSync(path.join(realHome, '.claude'), path.join(scratch, '.claude'));

    await deleteKeepingAgentLogs(scratch, 'pane-1');

    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.readFileSync(path.join(realHome, '.claude', 'projects', 'p', 'real.jsonl'), 'utf8')).toBe('real');
    expect(fs.readFileSync(path.join(paneDir, 'agent-logs', 'claude', 'pane-1', '0', 'p', 'qa.jsonl'), 'utf8')).toBe('qa');
    expect(fs.readFileSync(path.join(paneDir, 'agent-logs', 'codex', 'pane-1', '0', '2026', '11', '13', 'rollout.jsonl'), 'utf8')).toBe('codex');
    expect(fs.readdirSync(path.join(paneDir, 'agent-logs', 'claude', 'pane-1'))).toEqual(['0']);
  });

  it('deletes what has been archived longer than the retention period, and keeps the rest', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = new Date('2026-11-30T00:00:00Z');
    const oldSession = path.join(root, 'sessions', 'old');
    const newSession = path.join(root, 'sessions', 'new');
    write(path.join(oldSession, 'report.md'));
    write(path.join(newSession, 'report.md'));
    const scratch = (id: string) => path.join(paneDir, 'scratch', id);
    for (const id of ['old-session-pane', 'archived-pane', 'restored-pane', 'agent-made']) write(path.join(scratch(id), 'file'));
    await markScratchArchived('archived-pane', new Date(now.getTime() - 15 * day));
    await markScratchArchived('restored-pane', new Date(now.getTime() - 15 * day));

    const deleted = await expireArchivedFolders({
      now,
      retentionDays: 14,
      archivedSessions: [
        { folder: oldSession, paneId: 'old-session-pane', archivedAt: new Date(now.getTime() - 15 * day) },
        { folder: newSession, paneId: 'new-session-pane', archivedAt: new Date(now.getTime() - 13 * day) },
      ],
      paneIsArchivedOrGone: id => id !== 'restored-pane',
    });

    expect(deleted.sort()).toEqual([oldSession, scratch('archived-pane'), scratch('old-session-pane')].sort());
    expect(fs.existsSync(newSession)).toBe(true);
    expect(fs.existsSync(scratch('restored-pane'))).toBe(true);
    expect(fs.existsSync(scratch('agent-made'))).toBe(true);
  });
});
