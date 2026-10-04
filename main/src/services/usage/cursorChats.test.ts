import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { listPaneCursorChats } from './cursorChats';

const CHAT_ID = '8ff011fb-7f01-4e74-bbe1-e026d47ea50f';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, archived INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE tool_panels (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT);
  `);
  return db;
}

function addPanel(db: Database.Database, id: string, sessionId: string, customState: Record<string, string>) {
  db.prepare('INSERT INTO tool_panels (id, session_id, state) VALUES (?, ?, ?)').run(id, sessionId, JSON.stringify({ customState }));
}

describe('listPaneCursorChats', () => {
  it('returns chat ids captured on Cursor panels, including archived Panes, with the Pane worktree', () => {
    const db = createDb();
    db.prepare('INSERT INTO sessions (id, worktree_path, archived, updated_at) VALUES (?, ?, ?, ?)').run('pane-1', '/work/pane', 1, '2026-10-03 00:00:00');
    addPanel(db, 'cursor', 'pane-1', { agentType: 'cursor', agentSessionId: CHAT_ID.toUpperCase() });
    addPanel(db, 'cursor-again', 'pane-1', { agentType: 'cursor', agentSessionId: CHAT_ID });
    addPanel(db, 'claude', 'pane-1', { agentType: 'claude', agentSessionId: OTHER_ID });
    addPanel(db, 'not-a-chat', 'pane-1', { agentType: 'cursor', agentSessionId: 'pending' });
    addPanel(db, 'untracked', 'pane-1', { agentType: 'cursor' });

    expect(listPaneCursorChats(db)).toEqual([{ chatId: CHAT_ID, cwd: '/work/pane' }]);
  });
});

describe('listPaneCursorChats with damaged panel state', () => {
  it('skips a panel whose state is not JSON and still lists the others', () => {
    const db = createDb();
    db.prepare('INSERT INTO sessions (id, worktree_path, archived, updated_at) VALUES (?, ?, ?, ?)').run('pane-1', '/work/pane', 0, '2026-10-03 00:00:00');
    db.prepare('INSERT INTO tool_panels (id, session_id, state) VALUES (?, ?, ?)').run('broken', 'pane-1', '{"customState": {');
    addPanel(db, 'cursor', 'pane-1', { agentType: 'cursor', agentSessionId: CHAT_ID });

    expect(listPaneCursorChats(db)).toEqual([{ chatId: CHAT_ID, cwd: '/work/pane' }]);
  });
});
