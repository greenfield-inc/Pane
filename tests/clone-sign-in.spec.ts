import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const SIGN_IN_COMMAND = 'gh auth login --web --git-protocol https && gh auth setup-git';
const REPO_URL = 'https://github.com/jamari-morrison/montlakev2';
const LOCAL_HTTPS_MESSAGE = 'Authentication failed — check your credentials or use an SSH URL.';
const SSH_URL = 'git@github.com:jamari-morrison/montlakev2.git';
const SSH_HINT = 'This is an SSH URL; after signing in, use the HTTPS URL instead.';
// What the daemon says on this computer for each SSH sign-in failure.
const SSH_FAILURES = [
  ['an unknown host key', "SSH host key verification failed — this computer doesn't trust the Git server yet. Connect to it once with ssh to accept its host key, or use an HTTPS URL."],
  ['no accepted key', 'SSH authentication failed — the Git server rejected this computer\'s SSH key. Add your SSH key to your Git host, or use an HTTPS URL.'],
] as const;

interface CloneProbe {
  cloneCalls: Array<[string, string]>;
}

declare global {
  interface Window {
    __cloneProbe?: CloneProbe;
  }
}

/** Makes every clone fail the way the host's daemon reports a sign-in failure, and records the clones. */
async function failClonesWithAuth(page: Page, error: string, authProtocol: 'https' | 'ssh' = 'https') {
  await page.evaluate(({ error, authProtocol }) => {
    const probe: CloneProbe = { cloneCalls: [] };
    window.__cloneProbe = probe;
    Object.assign(window.electronAPI.git, {
      cloneRepo: async (url: string, destDir: string) => {
        probe.cloneCalls.push([url, destDir]);
        return { success: false, error, code: 'GIT_CLONE_AUTH_REQUIRED', authProtocol };
      },
    });
  }, { error, authProtocol });
}

async function hostTerminalOpenRequests(page: Page) {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock defines __paneTestElectronMock with getInvokeCalls.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      getInvokeCalls: (channel: string) => Array<{ args: unknown[] }>;
    } }).__paneTestElectronMock;
    return mock.getInvokeCalls('host-terminal:open').map((call) => call.args[0] ?? null);
  });
}

/** Back to the home page: a sidebar button here, an item of the sidebar's Home menu on newer layouts. */
async function goHome(page: Page) {
  const homeButton = page.getByRole('button', { name: 'Home', exact: true });
  if (await homeButton.count() > 0) {
    await homeButton.click();
    return;
  }
  await page.getByRole('button', { name: 'Home menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Home', exact: true }).click();
}

async function connectRemote(page: Page) {
  await page.evaluate(async () => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'devbox', label: 'devbox', baseUrl: 'https://devbox.example.ts.net',
      token: 'synthetic', transport: 'http+sse',
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'devbox' });
  });
  await expect(page.getByRole('button', { name: 'Agents run on devbox. Switch host' })).toBeVisible();
}

/** A remote clone keeps its default destination, the host's home; this computer browses with the native dialog. */
async function fillAndClone(page: Page, destination: '~' | '/tmp/pane-worktrees', url = REPO_URL) {
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(url);
  if (destination !== '~') await dialog.getByRole('button', { name: 'Browse' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Destination' })).toHaveValue(destination);
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click();
  return dialog;
}

test('a remote host that is not signed in offers its terminal, prefilled, and a retry', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page, '~');
  const notice = dialog.getByRole('alert');
  await expect(notice).toContainText("devbox isn't signed in to GitHub.");
  await expect(notice).toContainText('Sign in on devbox, then try again.');
  await expect(notice.getByRole('button')).toHaveText(['Open terminal on devbox to sign in', 'Try again']);
  await expect(dialog.getByText(LOCAL_HTTPS_MESSAGE)).toHaveCount(0);
  await expect(dialog.getByText(SSH_HINT)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-sign-in-notice.png') });

  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls)).toEqual([
    [REPO_URL, '~'],
    [REPO_URL, '~'],
  ]);
  await expect(notice).toContainText("devbox isn't signed in to GitHub.");

  await notice.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'devbox · Terminal' })).toBeVisible();
  const requests = await hostTerminalOpenRequests(page);
  expect(requests).toEqual([{ input: SIGN_IN_COMMAND }]);
  expect(SIGN_IN_COMMAND).not.toMatch(/[\r\n]/);
  await page.screenshot({ path: testInfo.outputPath('remote-terminal-opened.png') });

  // Coming back after signing in finds the same URL and destination.
  await goHome(page);
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const reopened = page.getByRole('dialog');
  await expect(reopened.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(REPO_URL);
  await expect(reopened.getByRole('textbox', { name: 'Destination' })).toHaveValue('~');
  await reopened.getByRole('alert').getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls.at(-1))).toEqual([REPO_URL, '~']);
  await page.screenshot({ path: testInfo.outputPath('remote-reopened-try-again.png') });
});

test('this computer keeps the plain sign-in message', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toBeVisible();
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page, '/tmp/pane-worktrees');
  await expect(dialog.getByText(LOCAL_HTTPS_MESSAGE)).toBeVisible();
  await expect(dialog.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Open terminal/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('local-https-message.png') });
});

test('a sign-in draft stays with its host when the user switches hosts', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page, '~');
  await expect(dialog.getByRole('alert')).toContainText("devbox isn't signed in to GitHub.");
  await dialog.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => window.electronAPI.remoteDaemon.updateClientState({ mode: 'local', activeProfileId: null }));
  await expect(page.getByRole('button', { name: 'Agents run on This computer. Switch host' })).toBeVisible();
  await goHome(page);
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const local = page.getByRole('dialog');
  await expect(local.getByRole('textbox', { name: 'Repository URL' })).toHaveValue('');
  await expect(local.getByRole('textbox', { name: 'Destination' })).toHaveValue('');
  await expect(local.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  await expect(local.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('switched-host-clean-dialog.png') });
  await local.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__cloneProbe?.cloneCalls.length)).toBe(1);
});

for (const [failure, message] of SSH_FAILURES) {
  test(`an SSH clone on a remote host with ${failure} also points to the HTTPS URL`, async ({ page }, testInfo) => {
    await installElectronApiMock(page);
    await page.goto('/');
    await connectRemote(page);
    await failClonesWithAuth(page, message, 'ssh');

    const dialog = await fillAndClone(page, '~', SSH_URL);
    const notice = dialog.getByRole('alert');
    await expect(notice).toContainText("devbox isn't signed in to GitHub.");
    await expect(notice).toContainText('Sign in on devbox, then try again.');
    await expect(notice.getByText(SSH_HINT, { exact: true })).toBeVisible();
    await expect(notice.getByRole('button')).toHaveText(['Open terminal on devbox to sign in', 'Try again']);
    await page.screenshot({ path: testInfo.outputPath(`remote-ssh-${failure.replaceAll(' ', '-')}.png`) });

    // The URL stays as typed: Try again clones the same SSH URL to the same place.
    await notice.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls)).toEqual([[SSH_URL, '~'], [SSH_URL, '~']]);
    await expect(dialog.getByRole('textbox', { name: 'Repository URL' })).toHaveValue(SSH_URL);
  });

  test(`an SSH clone on this computer with ${failure} keeps its own message`, async ({ page }) => {
    await installElectronApiMock(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'GitHub', exact: true })).toBeVisible();
    await failClonesWithAuth(page, message, 'ssh');

    const dialog = await fillAndClone(page, '/tmp/pane-worktrees', SSH_URL);
    await expect(dialog.getByText(message, { exact: true })).toBeVisible();
    await expect(dialog.getByText(SSH_HINT)).toHaveCount(0);
    await expect(dialog.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  });
}
