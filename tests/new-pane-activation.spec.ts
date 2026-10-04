import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

const project = {
  id: 41,
  name: 'activation-fixture',
  path: '/tmp/activation-fixture',
  active: true,
  displayOrder: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const mainSession = {
  id: 'activation-main',
  name: 'activation-fixture (Main)',
  worktreePath: project.path,
  prompt: '',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  baseBranch: 'main',
  isMainRepo: true,
};

async function openMainView(page: Page) {
  await page.getByRole('button', { name: `Repository actions for ${project.name}`, exact: true }).click();
  await page.getByText('Open session on main', { exact: true }).click();
  const mainView = page.getByRole('separator', { name: /main repository/i });
  await expect(mainView).toBeVisible();
  return mainView;
}

async function createPane(page: Page, name: string) {
  await page.getByRole('button', { name: `New pane in ${project.name}` }).first().click();
  const dialog = page.getByRole('dialog', { name: /^New Pane/ });
  await dialog.getByPlaceholder('Enter a name for your pane').fill(name);
  await dialog.getByRole('button', { name: /^Create/ }).click();
  await expect(dialog).toHaveCount(0);
}

test('a Pane created from the repository Main view opens instead of leaving Main on screen', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainSession],
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const mainView = await openMainView(page);

  await createPane(page, 'feature-x');

  await expect(page.getByRole('button', { name: /feature-x$/ }).first()).toBeVisible();
  await expect(mainView).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('new-pane-open.png') });
});

test('the same holds while connected to a remote host', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainSession],
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.evaluate(async () => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'cloud', label: 'rp-loop-cs-fake', baseUrl: 'https://rp-loop-cs-fake.tail1234.ts.net',
      token: 'synthetic', transport: 'http+sse',
    });
    await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'cloud' });
  });
  await expect(page.getByRole('button', { name: 'Agents run on rp-loop-cs-fake. Switch host' })).toBeVisible();
  const mainView = await openMainView(page);

  await createPane(page, 'remote-feature');

  await expect(page.getByRole('button', { name: /remote-feature$/ }).first()).toBeVisible();
  await expect(mainView).toHaveCount(0);
});

test('a Pane created in the background leaves the Main view where it is', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project],
    initialSessions: [mainSession],
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const mainView = await openMainView(page);

  await page.evaluate((session) => {
    // SAFETY: installElectronApiMock creates this test-only bridge and owns the call shape.
    (window as typeof window & { __paneTestElectronMock: { emitSessionCreated: (value: JsonObject) => void } })
      .__paneTestElectronMock.emitSessionCreated(session);
  }, { ...mainSession, id: 'background-pane', name: 'background-pane', isMainRepo: false, worktreePath: `${project.path}/worktrees/background-pane`, activateOnCreate: false });

  await page.getByRole('button', { name: `Expand repository ${project.name}` }).click();
  await expect(page.getByRole('button', { name: /background-pane$/ }).first()).toBeVisible();
  await expect(mainView).toBeVisible();
});
