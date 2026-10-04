import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

type InvokeCall = { channel: string; args: unknown[] };

const hostFs = {
  home: '/home/user',
  folders: {
    '/': {},
    '/home': {},
    '/home/user': {},
    '/home/user/.config': {},
    '/home/user/my-repo': { isGitRepo: true },
    '/home/user/notes': {},
  },
};

async function boot(page: Page) {
  await installElectronApiMock(page, { hostFs });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
}

async function connectTo(page: Page, host: 'sandbox' | 'self-hosted') {
  await page.evaluate(async (host) => {
    const profile = host === 'sandbox'
      ? { id: 'sandbox-1', label: 'sandbox-1', hostKind: { label: 'cloud sandbox', icon: 'cloud' as const } }
      : { id: 'devbox', label: 'devbox' };
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      ...profile, baseUrl: `https://${profile.label}.example.ts.net`, token: 'synthetic', transport: 'http+sse',
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: profile.id });
  }, host);
  const name = host === 'sandbox' ? 'sandbox-1' : 'devbox';
  await expect(page.getByRole('button', { name: `Agents run on ${name}. Switch host` })).toBeVisible();
}

function invokeCalls(page: Page, channel: string): Promise<InvokeCall[]> {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate((channel) => (
    window as typeof window & { __paneTestElectronMock: { getInvokeCalls: (channel: string) => InvokeCall[] } }
  ).__paneTestElectronMock.getInvokeCalls(channel), channel);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 2_000 },
  ).catch(() => undefined);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function openHomeCard(page: Page, card: 'Open Project' | 'New Project' | 'GitHub') {
  await page.getByRole('button', { name: 'Home', exact: true }).first().click();
  await page.getByRole('button', { name: card, exact: true }).click();
  if (card === 'Open Project') await page.getByRole('button', { name: '+ Add Repository' }).click();
}

function folderBrowser(page: Page, host: string) {
  return page.getByRole('dialog', { name: `Choose a folder on ${host}` });
}

test('Clone on a cloud sandbox browses the sandbox, not this computer, and clones there', async ({ page }, testInfo) => {
  await boot(page);
  await connectTo(page, 'sandbox');
  await openHomeCard(page, 'GitHub');

  const clone = page.getByRole('dialog', { name: 'Clone from GitHub' });
  await expect(clone.getByText('On: sandbox-1 (cloud sandbox)', { exact: true })).toBeVisible();
  await expect(clone.getByRole('textbox', { name: 'Destination' })).toHaveValue('~');
  await shot(page, testInfo, '01-clone-dialog-sandbox-chip');

  await clone.getByRole('button', { name: 'Browse' }).click();
  const browser = folderBrowser(page, 'sandbox-1');
  await expect(browser).toBeVisible();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home/user');
  await expect(browser.getByRole('button', { name: 'my-repo, git repo' })).toBeVisible();
  await expect(browser.getByRole('button', { name: 'notes', exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: '.config' })).toHaveCount(0);
  await shot(page, testInfo, '02-remote-browser-home');

  await browser.getByRole('checkbox', { name: 'Show hidden folders' }).check();
  await expect(browser.getByRole('button', { name: '.config' })).toBeVisible();
  await shot(page, testInfo, '03-remote-browser-hidden');

  await browser.getByRole('button', { name: 'Up', exact: true }).click();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home');
  await browser.getByRole('button', { name: 'user', exact: true }).click();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home/user');

  await browser.getByRole('button', { name: 'New folder' }).click();
  await browser.getByRole('textbox', { name: 'New folder name' }).fill('repos');
  await shot(page, testInfo, '04-remote-browser-new-folder');
  await browser.getByRole('button', { name: 'Create folder' }).click();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home/user/repos');
  expect(await invokeCalls(page, 'fs:create-directory')).toEqual([
    { channel: 'fs:create-directory', args: [{ parent: '/home/user', name: 'repos', hostLabel: 'sandbox-1' }] },
  ]);

  await browser.getByRole('button', { name: 'Select this folder' }).click();
  await expect(browser).toHaveCount(0);
  await expect(clone.getByRole('textbox', { name: 'Destination' })).toHaveValue('/home/user/repos');

  await clone.getByRole('textbox', { name: 'Repository URL' }).fill('https://github.com/octocat/Hello-World');
  await clone.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(clone).toHaveCount(0);

  expect(await invokeCalls(page, 'dialog:open-directory')).toEqual([]);
  expect((await invokeCalls(page, 'fs:browse-directories')).every((call) => (
    // SAFETY: fs:browse-directories takes one BrowseDirectoriesRequest, per shared/types/hostPaths.ts.
    (call.args[0] as { hostLabel?: string }).hostLabel === 'sandbox-1'
  ))).toBe(true);
  expect(await invokeCalls(page, 'git:clone-repo')).toEqual([{
    channel: 'git:clone-repo',
    args: ['https://github.com/octocat/Hello-World', '/home/user/repos', { hostLabel: 'sandbox-1' }],
  }]);
  expect(await invokeCalls(page, 'projects:create')).toEqual([{
    channel: 'projects:create',
    args: [{ name: 'Hello-World', path: '/home/user/repos/Hello-World', mode: 'open', hostLabel: 'sandbox-1' }],
  }]);
});

test('Open Project on a remote picks an existing repo there and rejects a path from this computer inline', async ({ page }, testInfo) => {
  await boot(page);
  await connectTo(page, 'sandbox');
  await openHomeCard(page, 'Open Project');

  const dialog = page.getByRole('dialog', { name: 'Open Repository' });
  await expect(dialog.getByText('On: sandbox-1 (cloud sandbox)', { exact: true })).toBeVisible();

  const path = dialog.getByRole('textbox', { name: 'Repository Path' });
  await path.fill('C:\\Users\\me\\my-repo');
  await expect(dialog.getByRole('alert')).toHaveText(
    "That's a path on this computer; sandbox-1 is a Linux host. Pick a folder on sandbox-1.",
  );
  // A rejected path has no branch to show.
  await expect(dialog.getByText('Detected Branch')).toHaveCount(0);
  await shot(page, testInfo, '05-open-windows-path-inline-error');

  await dialog.getByRole('button', { name: 'Browse' }).click();
  const browser = folderBrowser(page, 'sandbox-1');
  await expect(browser).toBeVisible();
  // Open never creates folders: the control is absent, not disabled.
  await expect(browser.getByRole('button', { name: 'New folder' })).toHaveCount(0);
  await shot(page, testInfo, '06-open-remote-browser-no-new-folder');
  await browser.getByRole('button', { name: 'my-repo, git repo' }).click();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home/user/my-repo');
  await browser.getByRole('button', { name: 'Select this folder' }).click();

  await expect(path).toHaveValue('/home/user/my-repo');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Enter project name' }).fill('my-repo');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  expect(await invokeCalls(page, 'dialog:open-directory')).toEqual([]);
  expect(await invokeCalls(page, 'projects:create')).toEqual([{
    channel: 'projects:create',
    args: [{ name: 'my-repo', path: '/home/user/my-repo', buildScript: '', runScript: '', mode: 'open', hostLabel: 'sandbox-1' }],
  }]);
});

test('a typed path that is not a repo is rejected by Open on the host, inline', async ({ page }, testInfo) => {
  await boot(page);
  await connectTo(page, 'self-hosted');
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Open Repository' });
  await expect(dialog.getByText('On: devbox (remote host)', { exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Enter project name' }).fill('notes');
  await dialog.getByRole('textbox', { name: 'Repository Path' }).fill('~/notes');
  await expect(dialog.getByRole('alert')).toHaveText('/home/user/notes is not a git repository.');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('/home/user/notes is not a git repository.');
  await shot(page, testInfo, '07-sidebar-add-repository-self-hosted');

  expect(await invokeCalls(page, 'projects:create')).toEqual([{
    channel: 'projects:create',
    args: [{ name: 'notes', path: '~/notes', buildScript: '', runScript: '', mode: 'open', hostLabel: 'devbox' }],
  }]);
});

test('New Project on a remote can create the folder in the browser and asks the host to create the repo', async ({ page }, testInfo) => {
  await boot(page);
  await connectTo(page, 'sandbox');
  await openHomeCard(page, 'New Project');

  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await expect(dialog.getByText('On: sandbox-1 (cloud sandbox)', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Browse' }).click();
  const browser = folderBrowser(page, 'sandbox-1');
  await browser.getByRole('button', { name: 'New folder' }).click();
  await browser.getByRole('textbox', { name: 'New folder name' }).fill('fresh');
  await browser.getByRole('button', { name: 'Create folder' }).click();
  await expect(browser.getByLabel('Current folder')).toHaveText('/home/user/fresh');
  await browser.getByRole('button', { name: 'Select this folder' }).click();

  await dialog.getByRole('textbox', { name: 'Enter project name' }).fill('fresh');
  await shot(page, testInfo, '08-new-project-remote');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  expect(await invokeCalls(page, 'dialog:open-directory')).toEqual([]);
  expect(await invokeCalls(page, 'projects:create')).toEqual([{
    channel: 'projects:create',
    args: [{ name: 'fresh', path: '/home/user/fresh', buildScript: '', runScript: '', mode: 'new', hostLabel: 'sandbox-1' }],
  }]);
});

test('on this computer Browse stays the native dialog and requests carry no host label', async ({ page }, testInfo) => {
  await boot(page);
  await openHomeCard(page, 'New Project');

  const dialog = page.getByRole('dialog', { name: 'New Project' });
  await expect(dialog.getByText('On: This computer', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Browse' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Repository Path' })).toHaveValue('/tmp/pane-worktrees');
  await expect(page.getByRole('dialog', { name: /^Choose a folder on/ })).toHaveCount(0);
  await shot(page, testInfo, '09-local-new-project-native-browse');
  expect(await invokeCalls(page, 'dialog:open-directory')).toHaveLength(1);
  expect(await invokeCalls(page, 'fs:browse-directories')).toEqual([]);

  await dialog.getByRole('textbox', { name: 'Enter project name' }).fill('worktrees');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  expect(await invokeCalls(page, 'projects:create')).toEqual([{
    channel: 'projects:create',
    args: [{ name: 'worktrees', path: '/tmp/pane-worktrees', buildScript: '', runScript: '', mode: 'new' }],
  }]);

  await openHomeCard(page, 'GitHub');
  const clone = page.getByRole('dialog', { name: 'Clone from GitHub' });
  await expect(clone.getByText('On: This computer', { exact: true })).toBeVisible();
  await expect(clone.getByRole('textbox', { name: 'Destination' })).toHaveValue('');
});
