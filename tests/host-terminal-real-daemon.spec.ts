import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { decodePaneRemoteConnection } from '../shared/types/remoteDaemon';

/**
 * Opt-in: drives the built desktop app against a real Pane daemon used as a
 * self-hosted remote. Set up the daemon with `--remote-setup ... --prefer-tunnel
 * manual --base-url http://127.0.0.1:<port>`, start it with `--daemon-headless`,
 * build main and frontend, then run under a display (e.g. xvfb-run) with:
 *   PANE_E2E_CONNECTION_FILE  file holding the setup output (its pane-remote:// code)
 *   PANE_E2E_CLIENT_DIR       empty Pane data directory for the desktop app
 *   PANE_E2E_CLIENT_HOME      HOME for the desktop app
 *   PANE_E2E_DAEMON_HOME      HOME the daemon runs with (the shell's expected cwd)
 *   PANE_E2E_EVIDENCE_DIR     where screenshots go
 */
const connectionFile = process.env.PANE_E2E_CONNECTION_FILE;
const clientDir = process.env.PANE_E2E_CLIENT_DIR;
const clientHome = process.env.PANE_E2E_CLIENT_HOME;
const evidenceDir = process.env.PANE_E2E_EVIDENCE_DIR;
const HOST = 'agentbox-self';
const PANEL_ID = '__host_terminal_panel__';

test.skip(!connectionFile || !clientDir || !clientHome || !evidenceDir || !process.env.PANE_E2E_DAEMON_HOME, 'real-daemon host terminal check is opt-in');
test.setTimeout(180_000);

function saveConnection(): void {
  // The connection code carries the pairing token: read it here, never print it.
  const code = fs.readFileSync(connectionFile ?? '', 'utf8').match(/pane-remote:\/\/\S+/)?.[0];
  if (!code) throw new Error('No connection code in PANE_E2E_CONNECTION_FILE');
  const payload = decodePaneRemoteConnection(code);
  const profile = {
    id: 'self-hosted', label: HOST, baseUrl: payload.baseUrl, token: payload.token, transport: payload.transport,
    // A headless host must never open a browser (gh prints its device URL instead).
    hostTerminalEnv: [{ name: 'BROWSER', value: 'false' }, { name: 'GH_BROWSER', value: 'false' }],
  };
  const config = { remoteDaemon: { client: { profiles: [profile], activeProfileId: null, mode: 'local' } } };
  fs.writeFileSync(path.join(clientDir ?? '', 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

async function scrollback(page: Page): Promise<string> {
  return page.evaluate(async (panelId) => {
    const state = await window.electronAPI.invoke('terminal:getState', panelId);
    const buffer = state?.scrollbackBuffer;
    return Array.isArray(buffer) ? buffer.join('') : String(buffer ?? '');
  }, PANEL_ID);
}

/** A fresh profile opens first-run dialogs; close them like a user would. */
async function dismissStartupDialogs(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await dialog.count() === 0) {
      await page.waitForTimeout(1000);
      if (await dialog.count() === 0) return;
    }
    const skip = dialog.first().getByRole('button', { name: /^(Skip|Close|Not now|Maybe later)$/ });
    if (await skip.count() > 0) await skip.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  const buttons = await dialog.first().getByRole('button').allInnerTexts();
  throw new Error(`A startup dialog would not close; its buttons: ${buttons.join(' | ')}`);
}

async function shot(page: Page, name: string): Promise<void> {
  // The assertions read the scrollback; give xterm a moment to paint it before the picture.
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(evidenceDir ?? '', name) });
}

test('the host terminal on a self-hosted remote is one plain shell at home', async () => {
  saveConnection();
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..'), '--no-sandbox', '--disable-gpu'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: clientHome ?? '',
      PANE_DIR: clientDir ?? '',
      NODE_ENV: 'production',
      DISPLAY: process.env.DISPLAY ?? '',
      XAUTHORITY: process.env.XAUTHORITY ?? '',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 860 }).catch(() => undefined);
    await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 30_000 });
    await dismissStartupDialogs(page);

    // A real user picks the host first; This computer offers no host terminal.
    await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
    await expect(page.getByRole('menuitem', { name: /^Open terminal on/ })).toHaveCount(0);
    await shot(page, '01-switcher-local-no-terminal.png');
    await page.getByRole('menuitemradio', { name: new RegExp(HOST) }).click();
    const chip = page.getByRole('button', { name: `Agents run on ${HOST}. Switch host` });
    await expect(chip).toBeVisible({ timeout: 30_000 });

    await chip.click();
    const openButton = page.getByRole('menuitem', { name: `Open terminal on ${HOST}` });
    await expect(openButton).toBeVisible();
    await shot(page, '02-switcher-remote-terminal-button.png');
    await openButton.click();

    const tab = page.getByRole('tab', { name: `${HOST} · Terminal` });
    await expect(tab).toBeVisible();
    await expect(tab.locator('..').locator('svg.lucide-server')).toHaveCount(1);
    await expect.poll(async () => (await scrollback(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.locator('.xterm').first().click();
    await page.keyboard.press('Control+U');
    await page.keyboard.type('whoami; pwd');
    await page.keyboard.press('Enter');
    // Output lines, not the echoed command or the prompt.
    const user = process.env.USER ?? 'agent';
    const home = process.env.PANE_E2E_DAEMON_HOME ?? '';
    // The shell persists across runs: read only what follows the last command.
    const lastRun = async () => {
      const text = await scrollback(page);
      return text.slice(text.lastIndexOf('whoami; pwd'));
    };
    await expect.poll(lastRun, { timeout: 15_000 }).toMatch(new RegExp(`^whoami; pwd\\r?\\n${user}\\r?\\n${home}\\r?\\n`));
    await shot(page, '03-host-terminal-whoami-pwd.png');

    // The saved host's environment reached the shell.
    await page.keyboard.type('echo "BROWSER=$BROWSER GH_BROWSER=$GH_BROWSER"');
    await page.keyboard.press('Enter');
    await expect.poll(() => scrollback(page)).toContain('\nBROWSER=false GH_BROWSER=false');
    await shot(page, '03b-host-terminal-no-browser-env.png');

    // Hidden: not a project, not a Pane, not in the sidebar.
    const listed = await page.evaluate(async () => {
      const sessions = await window.electronAPI.invoke('sessions:get-all');
      const projects = await window.electronAPI.invoke('projects:get-all');
      return { sessions: JSON.stringify(sessions), projects: JSON.stringify(projects) };
    });
    expect(listed.sessions).not.toContain('__host_terminal__');
    expect(listed.projects).not.toContain('host-terminal');
    await expect(page.locator('[data-testid="sidebar"]').getByText('Terminal', { exact: true })).toHaveCount(0);

    // Close and reopen: the same shell, still holding its output.
    await page.getByRole('button', { name: `Close ${HOST} · Terminal` }).click();
    await expect(tab).toHaveCount(0);
    await chip.click();
    await page.getByRole('menuitem', { name: `Open terminal on ${HOST}` }).click();
    await expect(tab).toBeVisible();
    expect(await lastRun()).toMatch(new RegExp(`^whoami; pwd\\r?\\n${user}\\r?\\n${home}\\r?\\n`));
    await shot(page, '04-host-terminal-reopened-same-shell.png');

    // Typed for the user, never submitted.
    // Twice: the second replaces the first instead of appending to it.
    await page.evaluate(() => window.electronAPI.hostTerminal.open({ input: 'echo PREFILL_TYPED_NOT_RUN' }));
    await page.evaluate(() => window.electronAPI.hostTerminal.open({ input: 'echo PREFILL_TYPED_NOT_RUN' }));
    await expect.poll(() => scrollback(page)).toContain('echo PREFILL_TYPED_NOT_RUN');
    await page.waitForTimeout(1500);
    // Run, echo would print the word on a line of its own.
    expect(await scrollback(page)).not.toMatch(/\nPREFILL_TYPED_NOT_RUN\r?\n/);
    await shot(page, '05-host-terminal-prefill-not-submitted.png');
    expect(await page.locator('.xterm-rows').innerText()).not.toContain('PREFILL_TYPED_NOT_RUNecho');
  } finally {
    await app.close();
  }
});
