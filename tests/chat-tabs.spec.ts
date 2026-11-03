import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Journeys J1 and J5 against the scripted ACP agent (never a real Claude account):
// open a Claude chat tab from the + menu, get a streamed reply, answer an approval,
// quit mid-turn, relaunch, and find the history with the interrupted turn marked.

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');

async function launch(paneDir: string, baseURL: string | undefined): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.resolve('main/dist/main/src/index.js')],
    env: { ...process.env, PANE_DIR: paneDir, NODE_ENV: 'development', VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port, PANE_CHAT_TEST_AGENT: AGENT },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function dismissDialogs(page: Page): Promise<void> {
  for (const name of ['No thanks', 'Get Started', 'Skip']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) await button.click();
  }
}

test('a chat tab streams, asks for approval, and comes back after a restart with its history', async ({ baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'pane-chat-tabs-'));
  const paneDir = path.join(root, 'pane');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  let { app, page } = await launch(paneDir, baseURL);
  try {
    await page.evaluate(async repoPath => {
      const api = window.electronAPI;
      await api.config.update({ chatTabsEnabled: true });
      const project = await api.projects.create({ name: 'demo', path: repoPath, active: true });
      await api.sessions.create({ prompt: '', projectId: project.data?.id, isMainRepo: true, toolType: 'none' });
    }, repo);
    await dismissDialogs(page);
    await page.getByText('New Task').first().click();
    await page.getByRole('button', { name: 'Add tool', exact: true }).first().click();
    await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeVisible();
    await expect(page.getByText('In a terminal', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Claude', exact: true }).click();

    const box = page.getByRole('textbox', { name: 'Message Claude' });
    await box.fill('hello there');
    await box.press('Enter');
    const conversation = page.getByRole('region', { name: 'Conversation messages' });
    await expect(conversation).toContainText('You said: hello there');

    await box.fill('permission');
    await box.press('Enter');
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(conversation).toContainText('Permission: allow');
    await page.screenshot({ path: testInfo.outputPath('j1-chat.png') });

    await box.fill('slow');
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop agent turn' })).toBeVisible();
    await app.close();

    ({ app, page } = await launch(paneDir, baseURL));
    await dismissDialogs(page);
    await page.getByText('New Task').first().click();
    const reopened = page.getByRole('region', { name: 'Conversation messages' });
    await expect(reopened).toContainText('You said: hello there', { timeout: 20_000 });
    await expect(reopened).toContainText('Stopped when Pane closed.');
    await expect(page.getByRole('alert', { name: 'Chat stopped' })).toHaveCount(0);
    const again = page.getByRole('textbox', { name: 'Message Claude' });
    await again.fill('after restart');
    await again.press('Enter');
    await expect(reopened).toContainText('You said: after restart');
    await page.screenshot({ path: testInfo.outputPath('j5-restored.png') });
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
