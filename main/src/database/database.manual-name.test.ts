import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SessionManager } from '../services/sessionManager';
import { DatabaseService } from './database';

it('persists an explicit display name through refresh, database reopen and changed PR/commit metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-manual-name-'));
  const databasePath = path.join(directory, 'sessions.db');
  let database = new DatabaseService(databasePath);
  try {
    database.initialize();
    const project = database.createProject('Repo', path.join(directory, 'repo'));
    database.createSession({
      id: 'manual', name: 'Original', initial_prompt: '', worktree_name: 'feature',
      worktree_path: path.join(directory, 'feature'), project_id: project.id, tool_type: 'none',
    });
    const manager = new SessionManager(database);
    manager.renameSessionDisplayName('manual', '  Human label  ');
    expect(manager.getSession('manual')).toMatchObject({ name: 'Human label', nameManuallySet: true });
    database.close();
    database = new DatabaseService(databasePath);
    database.initialize();
    const restarted = new SessionManager(database);
    expect(restarted.getSession('manual')).toMatchObject({ name: 'Human label', nameManuallySet: true });
    database.saveSessionGitStatusCache('manual', {
      state: 'ahead', ahead: 3, prNumber: 42, prTitle: 'Changed PR title',
      commitAdditions: 20, commitDeletions: 4, commitFilesChanged: 2,
    }, Date.now());
    restarted.updateSession('manual', { status: 'stopped', gitStatus: { state: 'ahead', ahead: 3 } });
    expect(restarted.getSession('manual')).toMatchObject({ name: 'Human label', nameManuallySet: true });
    expect(database.getSession('manual')).toMatchObject({
      name: 'Human label', name_manually_set: 1, worktree_name: 'feature',
      worktree_path: path.join(directory, 'feature'),
    });
    restarted.renameSessionDisplayName('manual', 'Second label');
    expect(restarted.getSession('manual')?.name).toBe('Second label');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
