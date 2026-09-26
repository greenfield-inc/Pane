import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, it, vi } from 'vitest';
import { CommandRunner } from '../utils/commandRunner';
import { DatabaseService } from '../database/database';
import { SessionManager } from './sessionManager';
import { addSessionLog, cleanupSessionLogs, getSessionLogs } from './session-logs';

it('releases log history when a session leaves the active session list', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-log-lifecycle-'));
  const db = new DatabaseService(path.join(directory, 'sessions.db'));
  const manager = new SessionManager(db);
  try {
    db.initialize();
    db.createSession({
      id: 'archive-logs', name: 'Logs', initial_prompt: '', worktree_name: 'logs',
      worktree_path: directory, project_id: null, tool_type: 'none',
    });
    manager.initializeFromDatabase();
    addSessionLog('archive-logs', 'info', 'script output');
    await manager.archiveSession('archive-logs');
    expect(getSessionLogs('archive-logs')).toEqual([]);
    const project = db.createProject('Fixture', directory);
    const runner = new CommandRunner(project);
    vi.spyOn(runner, 'execAsync').mockResolvedValue({ stdout: 'archive output\n', stderr: '' });
    await manager.runArchiveScript('archive-logs', ['fixture command'], directory, runner);
    addSessionLog('archive-logs', 'info', 'late process exit', 'RunCommand');
    expect(getSessionLogs('archive-logs')).toEqual([]);
  } finally {
    cleanupSessionLogs('archive-logs');
    await manager.cleanup();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
