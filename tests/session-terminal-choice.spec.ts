import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dismissDialogs, isolatedPane, launchIsolated } from './isolatedPane';

const welcome = 'How would you like to start new Sessions?';

async function finishOnboarding(page: Page) {
  await page.getByRole('dialog', { name: 'Open your project' }).getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('dialog', { name: 'Take your agents with you' }).getByRole('button', { name: 'Skip for now', exact: true }).click();
}

function writeMarker(root: string, name: string) {
  const file = path.join(root, name);
  return {
    command: `echo ready > "${file.replaceAll('\\', '/')}"`,
    wait: () => expect.poll(() => readFile(file, 'utf8').then(value => value.trim(), () => ''), { timeout: 30_000 }).toBe('ready'),
  };
}

async function typeInShell(page: Page, command: string) {
  const terminal = page.locator('.xterm:visible').last();
  await terminal.click();
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');
}

function withoutAgent() {
  const pane = isolatedPane('pane-session-terminal-choice', { DO_NOT_TRACK: '1' });
  // Keep Git and the OS utilities available while making the agent CLI genuinely absent.
  const windows = process.platform === 'win32';
  const git = execFileSync(windows ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  pane.env.PATH = [path.dirname(git), ...(windows ? [path.join(pane.env.SystemRoot, 'System32'), path.join(pane.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), pane.env.SystemRoot] : ['/usr/bin', '/bin'])].join(path.delimiter);
  return pane;
}

test('plain-terminal onboarding, custom command, and chat recovery work in Electron', async ({ baseURL }) => {
  const pane = withoutAgent();
  const first = await launchIsolated(pane, baseURL);
  const custom = writeMarker(pane.root, 'custom-ready');
  const command = custom.command;
  try {
    const onboarding = first.page.getByRole('dialog', { name: welcome });
    await expect(onboarding.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible({ timeout: 30_000 });
    await onboarding.getByRole('button', { name: 'Use a plain terminal' }).click();
    const project = first.page.getByRole('dialog', { name: 'Open your project' });
    await project.getByRole('button', { name: 'Skip', exact: true }).evaluate(button => {
      button.click();
      button.click();
    });
    await first.page.getByRole('dialog', { name: 'Take your agents with you' }).getByRole('button', { name: 'Skip for now', exact: true }).click();
    const sessions = await first.page.evaluate(() => window.electronAPI.orchestrationSessions.list());
    expect(sessions.data?.sessions.filter(session => session.terminalCommand === '')).toHaveLength(1);
    const plain = writeMarker(pane.root, 'plain-ready');
    await typeInShell(first.page, plain.command);
    await plain.wait();

    await first.page.getByTestId('new-orchestration-session').click();
    const create = first.page.getByRole('dialog', { name: 'Create Session', exact: true });
    await expect(create.getByRole('radio', { name: 'Use a plain terminal' })).toBeChecked();
    await create.getByText('Add a custom CLI command…', { exact: true }).click();
    await expect(create.getByLabel('Command to run when a Session starts')).toHaveValue('');
    await create.getByLabel('Command to run when a Session starts').fill(command);
    await create.getByLabel('Session name (optional)').fill('Custom CLI QA');
    await create.getByRole('button', { name: 'Create Session', exact: true }).click();
    await custom.wait();
    await expect.poll(async () => (await first.page.evaluate(() => window.electronAPI.config.get())).data?.defaultSessionTerminalCommand).toBe(command);
  } finally {
    await first.app.close();
  }

  const second = await launchIsolated(pane, baseURL);
  try {
    await dismissDialogs(second.page);
    await second.page.getByTestId('new-orchestration-session').click();
    const create = second.page.getByRole('dialog', { name: 'Create Session', exact: true });
    await expect(create.getByRole('radio', { name: 'Use a custom CLI command' })).toBeChecked();
    await expect(create.getByLabel('Command to run when a Session starts')).toHaveValue(command);
    const persisted = await second.page.evaluate(() => window.electronAPI.orchestrationSessions.list());
    expect(persisted.data?.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Terminal', terminalCommand: '' }),
      expect.objectContaining({ name: 'Custom CLI QA', terminalCommand: command }),
    ]));
    await create.getByTestId('create-session-agent-claude').click();
    await create.getByLabel('Session name (optional)').fill('Missing agent QA');
    await create.getByRole('button', { name: 'Create Session', exact: true }).click();
    await expect.poll(async () => (await second.page.evaluate(() => window.electronAPI.config.get())).data?.defaultSessionTerminalCommand).toBeNull();
    const missingSession = await second.page.evaluate(async () => (await window.electronAPI.orchestrationSessions.list()).data?.sessions.find(session => session.name === 'Missing agent QA'));
    expect(missingSession).toBeDefined();
    const missing = second.page.getByTestId(`orchestration-session-${missingSession?.id}`);
    const openTerminal = second.page.getByRole('button', { name: 'Open a plain terminal' });
    await expect(async () => {
      if (!(await openTerminal.isVisible())) await missing.click();
      await expect(openTerminal).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await openTerminal.click();
    const recovery = writeMarker(pane.root, 'recovery-ready');
    await typeInShell(second.page, recovery.command);
    await recovery.wait();
    const recovered = await second.page.evaluate(() => window.electronAPI.orchestrationSessions.get({ name: 'Missing agent QA' }));
    expect(recovered.data?.panel.type).toBe('chat');
  } finally {
    await second.app.close();
  }
});

test('onboarding saves and runs a custom CLI command', async ({ baseURL }) => {
  const pane = withoutAgent();
  const { app, page } = await launchIsolated(pane, baseURL);
  try {
    const onboarding = page.getByRole('dialog', { name: welcome });
    const ready = onboarding.getByRole('button', { name: 'Use a plain terminal' });
    await expect(ready).toBeEnabled({ timeout: 30_000 });
    await onboarding.getByText(/Add a custom CLI command/).click();
    const input = onboarding.getByLabel('Command to run when a Session starts');
    await expect(input).toHaveValue('');
    await expect(onboarding.getByRole('button', { name: 'Use this command' })).toBeDisabled();
    const marker = writeMarker(pane.root, 'onboarding-custom-ready');
    await input.fill(marker.command);
    await onboarding.getByRole('button', { name: 'Use this command' }).click();
    await finishOnboarding(page);
    await marker.wait();
    const config = await page.evaluate(() => window.electronAPI.config.get());
    expect(config.data?.defaultSessionTerminalCommand).toBe(marker.command);
  } finally {
    await app.close();
  }
});
