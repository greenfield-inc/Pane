import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import { panelManager } from './panelManager';
import { SessionManager } from './sessionManager';

describe('opening a repository', () => {
  let tempDir: string;
  let db: DatabaseService;
  let manager: SessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-main-pane-'));
    const repo = path.join(tempDir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Pane Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial'], { cwd: repo });
    db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    db.initialize();
    db.createProject('Repo', repo);
    manager = new SessionManager(db);
    vi.spyOn(panelManager, 'ensureExplorerPanel').mockResolvedValue(undefined as never);
    vi.spyOn(panelManager, 'ensureDiffPanel').mockResolvedValue(undefined as never);
    vi.spyOn(panelManager, 'getPanelsForSession').mockReturnValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await manager.cleanup();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('opens an ordinary, listed "(Main) <repo>" Pane, reuses it, and makes a new one once it is archived', async () => {
    const project = db.getAllProjects()[0];
    const opened = await manager.getOrCreateMainRepoSession(project.id);
    const row = db.getSession(opened.id)!;
    expect(row).toMatchObject({ name: '(Main) Repo', worktree_name: '', worktree_path: project.path });
    expect(row.is_main_repo).toBeTruthy();
    expect(db.getAllSessions(project.id).map(session => session.id)).toEqual([opened.id]);

    expect((await manager.getOrCreateMainRepoSession(project.id)).id).toBe(opened.id);

    db.archiveSession(opened.id);
    expect(db.getArchivedSessions(project.id).map(session => session.id)).toEqual([opened.id]);
    const reopened = await manager.getOrCreateMainRepoSession(project.id);
    expect(reopened.id).not.toBe(opened.id);
    expect(db.getSession(reopened.id)?.name).toBe('(Main) Repo');
  });
});
