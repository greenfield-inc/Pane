import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

interface TestDatabase {
  db: DatabaseService;
  tempDir: string;
}

function createTestDatabase(): TestDatabase {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-hidden-sessions-'));
  tempDirs.push(tempDir);
  const db = new DatabaseService(path.join(tempDir, 'sessions.db'));
  db.initialize();
  return { db, tempDir };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('hidden sessions', () => {
  it('allows detached hidden sessions and filters them from normal session lists', () => {
    const { db, tempDir } = createTestDatabase();
    const project = db.createProject('Repo', path.join(tempDir, 'repo'));

    db.createSession({
      id: 'visible-session',
      name: 'Visible Session',
      initial_prompt: '',
      worktree_name: 'visible',
      worktree_path: path.join(tempDir, 'repo'),
      project_id: project.id,
      tool_type: 'claude',
    });

    const hidden = db.createSession({
      id: 'hidden-session',
      name: 'Hidden Session',
      initial_prompt: '',
      worktree_name: 'hidden',
      worktree_path: tempDir,
      project_id: null,
      tool_type: 'none',
      is_hidden: true,
    });

    expect(hidden.project_id).toBeNull();
    expect(Boolean(hidden.is_hidden)).toBe(true);

    expect(db.getAllSessions().map(session => session.id)).toEqual(['visible-session']);
    expect(db.getAllSessions(undefined, { includeHidden: true }).map(session => session.id).sort()).toEqual([
      'hidden-session',
      'visible-session',
    ]);

    db.archiveSession('hidden-session');
    expect(db.getArchivedSessions().map(session => session.id)).toEqual([]);
    expect(db.getArchivedSessions(undefined, { includeHidden: true }).map(session => session.id).sort()).toEqual([
      'hidden-session',
    ]);

    db.close();
  });
});

describe('permanent archived session deletion', () => {
  it('only permanently deletes sessions after they are archived', () => {
    const { db, tempDir } = createTestDatabase();
    const project = db.createProject('Repo', path.join(tempDir, 'repo'));

    db.createSession({
      id: 'active-session',
      name: 'Active Session',
      initial_prompt: '',
      worktree_name: 'active',
      worktree_path: path.join(tempDir, 'repo-active'),
      project_id: project.id,
      tool_type: 'claude',
    });
    db.addSessionOutput('active-session', 'stdout', 'still here');

    expect(db.deleteArchivedSessionPermanently('active-session')).toBe(false);
    expect(db.getSession('active-session')).toBeDefined();
    expect(db.getSessionOutputs('active-session')).toHaveLength(1);

    db.archiveSession('active-session');

    expect(db.deleteArchivedSessionPermanently('active-session')).toBe(true);
    expect(db.getSession('active-session')).toBeUndefined();
    expect(db.getSessionOutputs('active-session')).toHaveLength(0);

    db.close();
  });

  it('bulk deletes visible archived sessions without deleting hidden archived sessions or active sessions', () => {
    const { db, tempDir } = createTestDatabase();
    const project = db.createProject('Repo', path.join(tempDir, 'repo'));

    db.createSession({
      id: 'archived-one',
      name: 'Archived One',
      initial_prompt: '',
      worktree_name: 'archived-one',
      worktree_path: path.join(tempDir, 'repo-archived-one'),
      project_id: project.id,
      tool_type: 'claude',
    });
    db.createSession({
      id: 'archived-two',
      name: 'Archived Two',
      initial_prompt: '',
      worktree_name: 'archived-two',
      worktree_path: path.join(tempDir, 'repo-archived-two'),
      project_id: project.id,
      tool_type: 'claude',
    });
    db.createSession({
      id: 'active-session',
      name: 'Active Session',
      initial_prompt: '',
      worktree_name: 'active',
      worktree_path: path.join(tempDir, 'repo-active'),
      project_id: project.id,
      tool_type: 'claude',
    });
    db.createSession({
      id: 'hidden-archived',
      name: 'Hidden Archived',
      initial_prompt: '',
      worktree_name: 'hidden',
      worktree_path: tempDir,
      project_id: null,
      tool_type: 'none',
      is_hidden: true,
    });

    db.archiveSession('archived-one');
    db.archiveSession('archived-two');
    db.archiveSession('hidden-archived');

    expect(db.deleteArchivedSessionsPermanently()).toBe(2);
    expect(db.getSession('archived-one')).toBeUndefined();
    expect(db.getSession('archived-two')).toBeUndefined();
    expect(db.getSession('active-session')).toBeDefined();
    expect(db.getSession('hidden-archived')).toBeDefined();

    db.close();
  });
});

describe('archived session ids', () => {
  it('lists at most the limit, leaving out the excluded projects', () => {
    const { db, tempDir } = createTestDatabase();
    const own = db.createProject('Own', path.join(tempDir, 'own'));
    const sample = db.createProject('Sample', path.join(tempDir, 'sample'));
    for (const [id, projectId] of [['own-a', own.id], ['own-b', own.id], ['own-c', own.id], ['sample-a', sample.id]] as const) {
      db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: path.join(tempDir, id), project_id: projectId, tool_type: 'none' });
      db.archiveSession(id);
    }
    db.createSession({ id: 'own-active', name: 'own-active', initial_prompt: '', worktree_name: 'own-active', worktree_path: path.join(tempDir, 'own-active'), project_id: own.id, tool_type: 'none' });

    expect(db.getArchivedSessionIds(10, [sample.id]).sort()).toEqual(['own-a', 'own-b', 'own-c']);
    expect(db.getArchivedSessionIds(2, [sample.id])).toHaveLength(2);
    expect(db.getArchivedSessionIds(10).sort()).toEqual(['own-a', 'own-b', 'own-c', 'sample-a']);

    db.close();
  });
});
