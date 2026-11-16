import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NotifySnapshot } from '../shared/types/notify';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// A Session loop's Session in a real, isolated Pane (#1446): it lives under Loops, a run restores
// it when it was archived and says so on a card that waits, and Undo archives it and pauses the
// loop. The Session's chat runs the scripted ACP agent, so no real agent or account is touched.

const SHOTS = process.env.LOOP_SESSIONS_SHOTS_DIR;
/** The scripted ACP agent the Session's chat runs instead of Claude. */
const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function json<T>(pane: IsolatedPane, args: string[]): Promise<T> {
  // SAFETY: each call site names the shape `runpane … --json` prints for that command.
  return JSON.parse(await runpane(pane, [...args, '--json'])) as T;
}

async function approvals(page: Page): Promise<NotifySnapshot> {
  return page.evaluate(() => window.electronAPI.notify.getSnapshot());
}

test('a Session loop lives under Loops, and a run restores its archived Session with a card that undoes it', async ({ baseURL }) => {
  test.setTimeout(180_000);
  const pane = isolatedPane('pane-loop-sessions');
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\necho "stand-in claude"\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
  const { app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT });
  try {
    await page.evaluate(async () => { await window.electronAPI.config.update({ notify: { enabled: true, showOutsidePane: false } }); });
    await dismissDialogs(page);
    await expect.poll(() => runpane(pane, ['doctor', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);

    const { loop } = await json<{ loop: { id: string; orchestrationSessionId: string } }>(pane, [
      'loops', 'create', '--session', 'new', '--name', 'promises-watch', '--cron', '30 7 * * *',
      '--agent', 'claude', '--prompt', 'Remind me of what is due.', '--yes',
    ]);
    const sessionId = loop.orchestrationSessionId;
    const row = page.getByTestId(`orchestration-session-${sessionId}`);

    // Under Loops, out of the Sessions list. First-run dialogs can open a few seconds in.
    await dismissDialogs(page);
    await page.getByTestId('loops-nav').click();
    await expect(page.getByTestId('loop-list-item')).toContainText('promises-watch');
    await expect(page.getByTestId('loop-detail').getByRole('button', { name: 'Open Session' })).toBeVisible();
    await expect(row).toHaveCount(0);

    // Archived from outside the app (here, the CLI), then the next run brings it back.
    const archive = path.join(pane.root, 'archive.json');
    writeFileSync(archive, JSON.stringify({ archived: true }));
    await runpane(pane, ['sessions', 'update', '--session', sessionId, '--from-json', archive, '--json']);
    await runpane(pane, ['loops', 'run', '--loop', loop.id, '--yes', '--json']);
    const { session } = await json<{ session: { archived?: boolean; isPinned?: boolean } }>(pane, ['sessions', 'get', '--session', sessionId]);
    expect(session.archived).not.toBe(true);
    expect(session.isPinned).not.toBe(true);

    // The card waits in Approvals, filed under the Session, which joins the list marked as the loop's.
    await expect.poll(async () => (await approvals(page)).items.filter(item => item.state === 'waiting').map(item => item.title), { timeout: 15_000 })
      .toContain('promises-watch: Session restored');
    const card = (await approvals(page)).items.find(item => item.title === 'promises-watch: Session restored');
    expect(card?.ui).toBe('options');
    expect(card?.source.session?.id).toBe(sessionId);
    await expect(row).toContainText('Loop: promises-watch');
    await expect(row.getByTestId('loop-mark')).toBeVisible();
    await shot(page, 'loop-session-waiting');

    // Archiving it from the sidebar first says what it does to the loop.
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Archive Session' }).click();
    const dialog = page.getByRole('dialog', { name: 'Archive promises-watch?' });
    await expect(dialog).toContainText('promises-watch runs here daily at 7:30 AM. Archiving the Session pauses the loop');
    await shot(page, 'loop-session-archive-warning');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Undo on the card archives the Session again and pauses the loop.
    await page.evaluate(async id => { await window.electronAPI.notify.run({ type: 'answer', id, answer: { choice: 'Undo' } }); }, card?.id ?? '');
    await expect.poll(async () => (await json<{ loops: Array<{ id: string; enabled: boolean }> }>(pane, ['loops', 'list'])).loops.find(item => item.id === loop.id)?.enabled, { timeout: 15_000 })
      .toBe(false);
    await expect.poll(async () => (await json<{ session: { archived?: boolean } }>(pane, ['sessions', 'get', '--session', sessionId])).session.archived, { timeout: 15_000 })
      .toBe(true);
    await expect(row).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(pane.root, { recursive: true, force: true });
  }
});
