import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { GitHubDeviceLoginState } from '../shared/types/githubDeviceLogin';

// BROWSER=false: gh must print its device code, never open a browser on the host.
const SIGN_IN_COMMAND = 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
const POWERSHELL_SIGN_IN_COMMAND = "$env:BROWSER='false'; gh auth login --web --git-protocol https; if ($?) { gh auth setup-git }";
const CMD_SIGN_IN_COMMAND = 'set BROWSER=false && gh auth login --web --git-protocol https && gh auth setup-git';
const DEVICE_HINT = 'Open github.com/login/device on your computer, enter the code, and wait here.';
const REPO_URL = 'https://github.com/octocat/Hello-World';
const LOCAL_HTTPS_MESSAGE = 'Authentication failed — check your credentials or use an SSH URL.';
const SSH_URL = 'git@github.com:octocat/Hello-World.git';
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

/** The host's daemon reports that its terminal runs this shell (host-terminal:shell). */
async function hostTerminalRuns(page: Page, shell: string) {
  await page.evaluate((shell) => {
    const invoke = window.electronAPI.invoke;
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => (channel === 'host-terminal:shell'
      ? Promise.resolve({ success: true, data: { shell } })
      : invoke(channel, ...args));
  }, shell);
}

interface FakeDeviceLogin {
  state: GitHubDeviceLoginState;
  starts: unknown[];
  statusCalls: number;
  cancels: number;
}

declare global {
  interface Window {
    __deviceLogin?: FakeDeviceLogin;
  }
}

/** A fake gh device sign-in on the host's daemon; the test moves it from state to state. */
async function fakeDeviceLogin(page: Page) {
  await page.evaluate(() => {
    const login: FakeDeviceLogin = { state: { status: 'idle' }, starts: [], statusCalls: 0, cancels: 0 };
    window.__deviceLogin = login;
    const invoke = window.electronAPI.invoke;
    const ok = () => Promise.resolve({ success: true, data: structuredClone(login.state) });
    window.electronAPI.invoke = (channel: string, ...args: unknown[]) => {
      if (channel === 'github:device-login-start') {
        login.starts.push(args[0]);
        login.state = { status: 'starting', loginId: 'login-1' };
        return ok();
      }
      if (channel === 'github:device-login-status') {
        login.statusCalls += 1;
        return ok();
      }
      if (channel === 'github:device-login-cancel') {
        login.cancels += 1;
        login.state = { status: 'cancelled', loginId: 'login-1' };
        return ok();
      }
      return invoke(channel, ...args);
    };
  });
}

async function setDeviceLogin(page: Page, state: FakeDeviceLogin['state']) {
  await page.evaluate((state) => {
    if (window.__deviceLogin) window.__deviceLogin.state = state;
  }, state);
}

async function openedExternalUrls(page: Page) {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock defines __paneTestElectronMock with getOpenedExternalUrls.
    const mock = (window as typeof window & { __paneTestElectronMock: { getOpenedExternalUrls: () => string[] } }).__paneTestElectronMock;
    return mock.getOpenedExternalUrls();
  });
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
  await hostTerminalRuns(page, '/bin/bash');
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page, '~');
  const notice = dialog.getByRole('alert');
  await expect(notice).toContainText("devbox isn't signed in to GitHub.");
  await expect(notice).toContainText('Sign in on devbox, then try again.');
  await expect(notice.getByText(DEVICE_HINT, { exact: true })).toBeVisible();
  await expect(notice.getByRole('button')).toHaveText(['Sign in to GitHub', 'Open terminal on devbox to sign in', 'Try again']);
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
  await expect(dialog.getByText(DEVICE_HINT)).toHaveCount(0);
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
    await expect(notice.getByText(DEVICE_HINT, { exact: true })).toBeVisible();
    await expect(notice.getByText(SSH_HINT, { exact: true })).toBeVisible();
    await expect(notice.getByRole('button')).toHaveText(['Sign in to GitHub', 'Open terminal on devbox to sign in', 'Try again']);
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
    await expect(dialog.getByText(DEVICE_HINT)).toHaveCount(0);
    await expect(dialog.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  });
}

for (const [shell, command] of [
  ['C:\\Program Files\\Git\\bin\\bash.exe', SIGN_IN_COMMAND],
  ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', POWERSHELL_SIGN_IN_COMMAND],
  ['C:\\Windows\\System32\\cmd.exe', CMD_SIGN_IN_COMMAND],
] as const) {
  test(`a host terminal running ${shell} gets its own sign-in line, still not submitted`, async ({ page }) => {
    await installElectronApiMock(page);
    await page.goto('/');
    await connectRemote(page);
    await hostTerminalRuns(page, shell);
    await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

    const dialog = await fillAndClone(page, '~');
    await dialog.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
    await expect(page.getByRole('tab', { name: 'devbox · Terminal' })).toBeVisible();
    expect(await hostTerminalOpenRequests(page)).toEqual([{ input: command }]);
    expect(command).not.toMatch(/[\r\n]/);
  });
}

test('signing in from Pane shows the code, opens GitHub on this computer and then tries the clone again', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await fakeDeviceLogin(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const dialog = await fillAndClone(page, '~');
  const notice = dialog.getByRole('alert');
  await notice.getByRole('button', { name: 'Sign in to GitHub' }).click();
  await expect.poll(() => page.evaluate(() => window.__deviceLogin?.starts)).toEqual([{ hostLabel: 'devbox', ghInsecureStorage: false }]);

  // A malicious or odd verification URL from the host is never opened: only GitHub's device page is.
  await setDeviceLogin(page, { status: 'waiting', loginId: 'login-1', code: 'fake-0000', verificationUrl: 'https://example.com/phish' });
  await expect(notice.getByLabel('One-time code')).toHaveText('fake-0000');
  await expect(notice.getByText('Waiting for you to approve on GitHub…')).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Sign in to GitHub' })).toHaveCount(0);
  await notice.getByRole('button', { name: 'Open github.com/login/device' }).click();
  await expect.poll(() => openedExternalUrls(page)).toEqual(['https://github.com/login/device']);
  await page.screenshot({ path: testInfo.outputPath('device-login-waiting.png') });

  // A state from another sign-in is ignored.
  await setDeviceLogin(page, { status: 'signed-in', loginId: 'someone-else', user: 'mallory' });
  await page.waitForTimeout(1500);
  await expect(notice.getByText('Waiting for you to approve on GitHub…')).toBeVisible();

  await setDeviceLogin(page, { status: 'approved', loginId: 'login-1' });
  await expect(notice.getByText('Approved on GitHub. Finishing sign-in on devbox…')).toBeVisible();
  await setDeviceLogin(page, { status: 'signed-in', loginId: 'login-1', user: 'octocat' });
  const signedIn = dialog.getByRole('alert');
  await expect(signedIn.getByText('Signed in to GitHub as octocat')).toBeVisible();
  await expect(signedIn.getByText(/isn't signed in/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('device-login-signed-in.png') });

  // Polling stops once gh is done.
  const calls = await page.evaluate(() => window.__deviceLogin?.statusCalls);
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.__deviceLogin?.statusCalls)).toBe(calls);

  await signedIn.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => window.__cloneProbe?.cloneCalls)).toEqual([[REPO_URL, '~'], [REPO_URL, '~']]);
});

test('Cancel stops the sign-in on the host and offers it again', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await fakeDeviceLogin(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const notice = (await fillAndClone(page, '~')).getByRole('alert');
  await notice.getByRole('button', { name: 'Sign in to GitHub' }).click();
  await setDeviceLogin(page, { status: 'waiting', loginId: 'login-1', code: 'fake-0000', verificationUrl: 'https://github.com/login/device' });
  await notice.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.evaluate(() => window.__deviceLogin?.cancels)).toBe(1);
  await expect(notice.getByLabel('One-time code')).toHaveCount(0);
  await expect(notice.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible();
});

test('a failed sign-in says why and keeps the terminal fallback', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await connectRemote(page);
  await hostTerminalRuns(page, '/bin/bash');
  await fakeDeviceLogin(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const notice = (await fillAndClone(page, '~')).getByRole('alert');
  await notice.getByRole('button', { name: 'Sign in to GitHub' }).click();
  await setDeviceLogin(page, { status: 'failed', loginId: 'login-1', reason: 'gh-missing', exitCode: null, message: "GitHub CLI (gh) isn't installed on devbox." });
  await expect(notice.getByText("GitHub CLI (gh) isn't installed on devbox.")).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('device-login-failed.png') });
  await notice.getByRole('button', { name: 'Open terminal on devbox to sign in' }).click();
  expect(await hostTerminalOpenRequests(page)).toEqual([{ input: SIGN_IN_COMMAND }]);
});

test('a host saved to keep gh\'s token in a file asks the daemon for that', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'sandbox-1', label: 'sandbox-1', baseUrl: 'https://sandbox-1.example.ts.net',
      token: 'synthetic', transport: 'http+sse', ghInsecureStorage: true,
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'sandbox-1' });
  });
  await expect(page.getByRole('button', { name: /Agents run on sandbox-1/ })).toBeVisible();
  await fakeDeviceLogin(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);

  const notice = (await fillAndClone(page, '~')).getByRole('alert');
  await notice.getByRole('button', { name: 'Sign in to GitHub' }).click();
  await expect.poll(() => page.evaluate(() => window.__deviceLogin?.starts)).toEqual([{ hostLabel: 'sandbox-1', ghInsecureStorage: true }]);
});

test('a host whose GitHub sign-in lives in Settings sends the user there', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'sandbox-1', label: 'sandbox-1', baseUrl: 'https://sandbox-1.example.ts.net',
      token: 'synthetic', transport: 'http+sse', githubSignIn: 'settings',
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'sandbox-1' });
  });
  await expect(page.getByRole('button', { name: /Agents run on sandbox-1/ })).toBeVisible();
  await fakeDeviceLogin(page);
  await failClonesWithAuth(page, LOCAL_HTTPS_MESSAGE);
  const dialog = await fillAndClone(page, '~');
  const notice = dialog.getByRole('alert');
  await expect(notice.getByText('Add a GitHub token in Settings', { exact: true })).toBeVisible();
  await expect(notice.getByRole('button')).toHaveText(['Open Settings', 'Try again']);
  await expect(notice.getByText(/isn't signed in to GitHub/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('settings-route-notice.png') });

  await notice.getByRole('button', { name: 'Open Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Clone from GitHub' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('settings-route-opened-settings.png') });
  expect(await page.evaluate(() => window.__deviceLogin?.starts)).toEqual([]);
  expect(await hostTerminalOpenRequests(page)).toEqual([]);

  // The URL and destination wait for the user to come back.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Remote Access' })).toHaveCount(0);
  await goHome(page);
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Repository URL' })).toHaveValue(REPO_URL);
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Destination' })).toHaveValue('~');
});
