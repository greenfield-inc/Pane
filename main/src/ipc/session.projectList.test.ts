import { execFileSync } from 'child_process';
import SQLite from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database';
import { SessionManager } from '../services/sessionManager';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { registerSessionHandlers } from './session';

let directory: string;
let databasePath: string;
let db: DatabaseService;
let manager: SessionManager;
let registry: PaneCommandRegistry;

const repository = (name: string, origin: string | null) => {
  const repo = path.join(directory, name);
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: repo });
  return repo;
};

interface ListedProject { name: string; repository?: string; sessions: Array<{ id: string }> }

const projectList = async () => {
  // SAFETY: sessions:get-all-with-projects answers with the project list envelope; success is checked below.
  const response = await registry.invoke('sessions:get-all-with-projects', []) as { success: boolean; data: ListedProject[] };
  expect(response).toMatchObject({ success: true });
  return response.data;
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-project-list-'));
  databasePath = path.join(directory, 'sessions.db');
  db = new DatabaseService(databasePath);
  db.initialize();
  manager = new SessionManager(db);
  // SAFETY: These public handlers only use the supplied services in this fixture; the project list
  // reads only cached git status, which this fixture never has.
  const services = {
    sessionManager: manager, databaseService: db, workspaceJournal: new WorkspaceJournal(), archiveProgressManager: new ArchiveProgressManager(),
    gitStatusManager: { getCachedStatus: () => undefined },
  } as AppServices;
  registry = new PaneCommandRegistry();
  // SAFETY: Registration only needs the IPC handle boundary; invocation uses the real registry.
  registerSessionHandlers({ handle: vi.fn() } as never, services, registry);
});

afterEach(async () => {
  await manager.cleanup();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the project list a host serves', () => {
  it('gives each project its repository identity from the origin remote, and none without one', async () => {
    db.createProject('web', repository('web', 'git@github.com:Acme/Web.git'));
    db.createProject('web-https-clone', repository('web-https-clone', 'https://github.com/acme/web'));
    db.createProject('scratch', repository('scratch', null));

    expect((await projectList()).map(project => [project.name, project.repository])).toEqual([
      ['web', 'github.com/acme/web'],
      ['web-https-clone', 'github.com/acme/web'],
      ['scratch', undefined],
    ]);
  });
});

describe('Pane order in a project, saved on the host', () => {
  let projectId: number;
  /** A Pane created at `minute` past nine, so creation order is unambiguous. */
  const createPane = (id: string, minute: number) => {
    db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: path.join(directory, id), project_id: projectId, tool_type: 'none' });
    const fixture = new SQLite(databasePath);
    fixture.prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?').run(`2026-10-30 09:${String(minute).padStart(2, '0')}:00`, '2026-10-30 10:00:00', id);
    fixture.close();
  };
  const listedOrder = async () => (await projectList())[0].sessions.map(pane => pane.id);
  const invoke = async (channel: string, value: { projectId: number; paneIds: string[] } | { order: 'newest' | 'oldest' }) => {
    // SAFETY: Pane order commands answer with the standard IPC envelope.
    const response = await registry.invoke(channel, [value]) as { success: boolean; error?: string };
    expect(response).toMatchObject({ success: true });
  };

  beforeEach(() => {
    projectId = db.createProject('web', repository('web', null)).id;
    createPane('a', 1);
    createPane('b', 2);
    createPane('c', 3);
  });

  it('lists Panes newest first until they are arranged', async () => {
    expect(await listedOrder()).toEqual(['c', 'b', 'a']);
  });

  it('saves a drag: the listed Panes trade places, unknown ids are ignored, and no timestamp changes', async () => {
    const updated = vi.fn();
    manager.on('session-updated', updated);

    await invoke('sessions:reorder-in-project', { projectId, paneIds: ['a', 'gone', 'c'] });

    expect(await listedOrder()).toEqual(['a', 'b', 'c']);
    expect(db.getSession('a')?.updated_at).toBe('2026-10-30 10:00:00');
    expect(updated.mock.calls.map(([session]) => session.id).sort()).toEqual(['a', 'c']);
  });

  it('puts a new Pane on top and keeps every other Pane in its place', async () => {
    await invoke('sessions:reorder-in-project', { projectId, paneIds: ['a', 'c'] });
    createPane('d', 4);
    db.archiveSession('b');

    expect(await listedOrder()).toEqual(['d', 'a', 'c']);
  });

  it('re-sorts once when Sort is picked, and puts new Panes at the bottom under Oldest first', async () => {
    await invoke('sessions:reorder-in-project', { projectId, paneIds: ['b', 'c'] });
    await invoke('sessions:sort-panes', { order: 'oldest' });
    expect(await listedOrder()).toEqual(['a', 'b', 'c']);
    createPane('d', 4);
    expect(await listedOrder()).toEqual(['a', 'b', 'c', 'd']);

    // A drag after sorting still holds.
    await invoke('sessions:reorder-in-project', { projectId, paneIds: ['d', 'a'] });
    expect(await listedOrder()).toEqual(['d', 'b', 'c', 'a']);

    await invoke('sessions:sort-panes', { order: 'newest' });
    createPane('e', 5);
    expect(await listedOrder()).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('says where new Panes land, newest first until Sort is picked', async () => {
    expect(await registry.invoke('sessions:get-pane-order', [])).toEqual({ success: true, data: { newPanes: 'top', chosen: false } });
    await invoke('sessions:sort-panes', { order: 'oldest' });
    expect(await registry.invoke('sessions:get-pane-order', [])).toEqual({ success: true, data: { newPanes: 'bottom', chosen: true } });
  });

  it('changes nothing when Sort cannot save every project, and says so', async () => {
    const otherProjectId = db.createProject('api', repository('api', null)).id;
    db.createSession({ id: 'x', name: 'x', initial_prompt: '', worktree_name: 'x', worktree_path: path.join(directory, 'x'), project_id: otherProjectId, tool_type: 'none' });
    db.createSession({ id: 'y', name: 'y', initial_prompt: '', worktree_name: 'y', worktree_path: path.join(directory, 'y'), project_id: otherProjectId, tool_type: 'none' });
    const fixture = new SQLite(databasePath);
    fixture.prepare("UPDATE sessions SET created_at = '2026-10-30 08:00:00' WHERE id = 'x'").run();
    fixture.prepare("UPDATE sessions SET created_at = '2026-10-30 08:30:00' WHERE id = 'y'").run();
    // The second project's write fails, as a full disk would.
    fixture.prepare("CREATE TRIGGER refuse_y BEFORE UPDATE OF display_order ON sessions WHEN NEW.id = 'y' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END").run();
    fixture.close();
    const updated = vi.fn();
    manager.on('session-updated', updated);

    const response = await registry.invoke('sessions:sort-panes', [{ order: 'oldest' }]);

    expect(response).toMatchObject({ success: false, error: expect.stringMatching(/disk I\/O error.*Nothing was changed/) });
    expect(await listedOrder()).toEqual(['c', 'b', 'a']);
    expect(await registry.invoke('sessions:get-pane-order', [])).toEqual({ success: true, data: { newPanes: 'top', chosen: false } });
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses a reorder with no Pane ids, and says what to send', async () => {
    const response = await registry.invoke('sessions:reorder-in-project', [{ projectId, paneIds: 'a' }]);
    expect(response).toMatchObject({ success: false, error: expect.stringMatching(/paneIds/) });
  });
});
