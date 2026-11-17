import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DatabaseService } from './database';

/** Moving a Session back sets the archived Pane aside instead of deleting it (sessionMove/importer.ts, F-6). */

let dir: string;
let db: DatabaseService;

const pane = (id: string) => ({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: dir, project_id: null, tool_type: 'none' as const });
const terminal = (id: string, sessionId: string, bytes: string) => ({
  id, sessionId, type: 'terminal' as const, title: 'Terminal',
  state: { isActive: false, customState: { scrollbackBuffer: bytes, serializedBuffer: bytes, cwd: dir } },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-set-aside-'));
  db = new DatabaseService(path.join(dir, 'sessions.db'));
  db.initialize();
  // The archive an earlier move away left here: history, output, a tab with saved terminal bytes, a layout.
  db.createSession(pane('p1'));
  db.addConversationMessage('p1', 'user', 'from before the move');
  db.addSessionOutput('p1', 'stdout', 'old output');
  db.createPanel(terminal('t1', 'p1', 'old terminal bytes'));
  db.setSessionPanelLayout('p1', '{"tabs":["t1"]}');
  db.archiveSession('p1');
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

it('keeps everything the archive saved while the arriving Pane takes its ids, and puts it back unchanged', () => {
  const aside = db.setArchivedSessionAside('p1', 'p1.moving-m1');
  expect(aside).not.toBeNull();
  // Hidden from the archive list, and the ids are free for the arriving Pane and its tab.
  expect(db.getSession('p1')).toBeUndefined();
  expect(db.getArchivedSessions().map(row => row.id)).not.toContain('p1.moving-m1');
  db.createSession(pane('p1'));
  db.createPanel(terminal('t1', 'p1', 'arriving bytes'));
  db.addConversationMessage('p1', 'user', 'arriving');

  // The move fails: the arriving Pane goes, and the archive comes back as it was.
  db.archiveSession('p1');
  db.deleteArchivedSessionPermanently('p1');
  db.restoreSetAsideSession(aside!);
  expect(db.getSession('p1')?.archived).toBeTruthy();
  expect(db.getArchivedSessions().map(row => row.id)).toContain('p1');
  expect(db.getConversationMessages('p1').map(message => message.content)).toEqual(['from before the move']);
  expect(db.getSessionOutputs('p1').map(output => output.data)).toEqual(['old output']);
  expect(db.getPanelsForSession('p1').map(panel => panel.id)).toEqual(['t1']);
  expect(db.getPanelBuffers('t1')?.scrollback).toBe('old terminal bytes');
  expect(db.getSessionPanelLayout('p1')).toBe('{"tabs":["t1"]}');
  expect(db.getSession('p1.moving-m1')).toBeUndefined();
});

it('deletes the set-aside archive only when the move commits, leaving the arriving Pane alone', () => {
  db.setArchivedSessionAside('p1', 'p1.moving-m1');
  db.createSession(pane('p1'));
  db.createPanel(terminal('t1', 'p1', 'arriving bytes'));
  db.addConversationMessage('p1', 'user', 'arriving');
  expect(db.deleteArchivedSessionPermanently('p1.moving-m1')).toBe(true);
  expect(db.getConversationMessages('p1').map(message => message.content)).toEqual(['arriving']);
  expect(db.getPanelBuffers('t1')?.scrollback).toBe('arriving bytes');
  expect(db.getConversationMessages('p1.moving-m1')).toEqual([]);
});

it('sets nothing aside for a Pane that isn\'t archived', () => {
  db.createSession(pane('p2'));
  expect(db.setArchivedSessionAside('p2', 'p2.moving-m1')).toBeNull();
  expect(db.getSession('p2')).toBeDefined();
});
