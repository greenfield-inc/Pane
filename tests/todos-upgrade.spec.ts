import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchIsolated } from './isolatedPane';
import { AGENT, createSession, detail, json, ownCaller, setup } from './todosHarness';

// R21 (D-423): a database from an earlier to-dos build opens in a real, isolated Pane (D-288). It runs in the
// reported-only Electron step (playwright.ci.stabilizing-electron.config.ts), not with todos-page.spec.ts.

test('a database from an earlier to-dos build opens: reply_to is added and its activity shows (R21)', async ({ baseURL }) => {
  test.setTimeout(180_000);
  const port = new URL(baseURL ?? 'http://localhost:4521').port;
  const run = await setup('pane-todos-r21', { VITE_PORT: port, PANE_TODOS_TIME_SCALE: '1' });
  try {
    const sessionA = await createSession(run.page, 'Billing rewrite');
    await json(run.pane, ['todos', 'create', 'Older to-do'], sessionA);
    await json(run.pane, ['todos', 'comment', 'T-1', 'written before the upgrade'], await ownCaller(run.page, 1));
    await run.app.close();
    // Turn the database back into one an earlier #1481 build made: no reply_to column.
    const db = path.join(run.pane.paneDir, 'sessions.db');
    execFileSync('/usr/bin/sqlite3', [db, 'DROP INDEX idx_todo_activity_reply; ALTER TABLE todo_activity DROP COLUMN reply_to;']);
    expect(execFileSync('/usr/bin/sqlite3', [db, 'PRAGMA table_info(todo_activity);'], { encoding: 'utf8' })).not.toContain('reply_to');
    const again = await launchIsolated(run.pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT, PANE_TODOS_TIME_SCALE: '1', VITE_PORT: port });
    try {
      await expect.poll(async () => (await detail(again.page, 1)).activity.map(row => row.body), { timeout: 30_000 }).toContain('written before the upgrade');
      expect(execFileSync('/usr/bin/sqlite3', [db, 'PRAGMA table_info(todo_activity);'], { encoding: 'utf8' })).toContain('reply_to');
    } finally {
      await again.app.close().catch(() => undefined);
    }
  } finally {
    await run.close();
  }
});
