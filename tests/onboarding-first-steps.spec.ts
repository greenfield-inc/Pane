import { test, expect, type Locator, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

const SAMPLE_REPO = '/tmp/.pane/projects/Pane';
const SEEN_FIRST_SCREEN = { onboarding_repo_setup: 'true', onboarding_open_project_screen: 'seen' };
const STEPS = ['Open your project', 'Start an agent in a new Pane', 'Start a second agent in parallel', 'Review the diff, then archive the Pane'];

const project = (id: number, name: string, path: string): JsonObject => ({
  id, name, path, active: false, created_at: new Date(id * 1000).toISOString(), updated_at: new Date(0).toISOString(),
});

const pane = (id: string, projectId: number, minutesAgo: number, extra: JsonObject = {}): JsonObject => {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id, name: id, projectId, worktreePath: `/tmp/worktrees/${id}`, prompt: '', status: 'stopped', createdAt: at, lastActivity: at,
    output: [], jsonMessages: [], permissionMode: 'ignore', toolType: 'none', archived: false, isHidden: false, isFavorite: false, ...extra,
  };
};

const SAMPLE = project(1, 'Pane', SAMPLE_REPO);
const ACME = project(2, 'acme-web', '/home/dev/code/acme-web');

type MockBridgeWindow = Window & {
  __paneTestElectronMock: {
    getPreferences(): Record<string, string>;
    setProjects(projects: JsonObject[]): void;
    addSession(session: JsonObject): void;
    archiveSession(sessionId: string): void;
  };
};

async function openHome(page: Page, options: ElectronApiMockOptions & { ghReady?: boolean } = {}) {
  await installElectronApiMock(page, options);
  await page.addInitScript((ghReady: boolean) => {
    window.electronAPI.onboarding.detectEnvironment = async () => ({ success: true, data: { gitInstalled: true, ghReady } });
  }, options.ghReady ?? false);
  await page.goto('/');
}

function card(page: Page): Locator {
  return page.getByRole('region', { name: 'Your first steps' });
}

/** Each step's row text, with "(done)" on ticked steps and the button label on the next one. */
async function expectSteps(page: Page, expected: string[]) {
  await expect(card(page).getByRole('listitem')).toHaveText(expected);
}

async function addPane(page: Page, session: JsonObject) {
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  await page.evaluate(value => (window as MockBridgeWindow).__paneTestElectronMock.addSession(value), session);
}

async function archivePane(page: Page, sessionId: string) {
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  await page.evaluate(id => (window as MockBridgeWindow).__paneTestElectronMock.archiveSession(id), sessionId);
}

async function preferences(page: Page): Promise<Record<string, string>> {
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  return page.evaluate(() => (window as MockBridgeWindow).__paneTestElectronMock.getPreferences());
}

test('after Skip, Home shows the first steps with Open as the next step', async ({ page }) => {
  await openHome(page, { initialPreferences: { onboarding_repo_setup: 'false' } });
  const dialog = page.getByRole('dialog', { name: 'Open your project' });
  await dialog.getByRole('button', { name: 'Skip' }).click();

  await expect(card(page)).toContainText('About five minutes. Each step opens the action.');
  await expectSteps(page, [`${STEPS[0]}Open`, STEPS[1], STEPS[2], STEPS[3]]);
  await expect(page.getByRole('heading', { name: 'Get Started' })).toHaveCount(0);

  await card(page).getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toBeVisible();
});

test('steps tick from projects and Panes, ignoring the sample repo, until the card is done', async ({ page }) => {
  await openHome(page, {
    initialPreferences: SEEN_FIRST_SCREEN,
    initialProjects: [SAMPLE, ACME],
    initialSessions: [pane('sample-task', 1, 30), pane('acme-main', 2, 30, { isMainRepo: true })],
  });

  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]}Start`, STEPS[2], STEPS[3]]);
  await card(page).getByRole('button', { name: 'Start' }).click();
  const createDialog = page.getByRole('dialog').filter({ hasText: 'acme-web' });
  await expect(createDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(createDialog).toBeHidden();

  await addPane(page, pane('fix-login-redirect', 2, 20));
  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]} (done)`, `${STEPS[2]}Start`, STEPS[3]]);

  await addPane(page, pane('dark-mode-toggle', 2, 10));
  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]} (done)`, `${STEPS[2]} (done)`, `${STEPS[3]}Review`]);

  await archivePane(page, 'dark-mode-toggle');
  await expect(card(page)).toBeHidden();
  expect(await preferences(page)).toMatchObject({ onboarding_first_steps: 'done' });
});

test('Review opens the newest Pane', async ({ page }) => {
  await openHome(page, {
    initialPreferences: SEEN_FIRST_SCREEN,
    initialProjects: [ACME],
    initialSessions: [pane('fix-login-redirect', 2, 20), pane('dark-mode-toggle', 2, 10)],
  });

  await card(page).getByRole('button', { name: 'Review' }).click();

  await expect(card(page)).toBeHidden();
  await expect(page.getByText('dark-mode-toggle').first()).toBeVisible();
});

test('an archive before the second Pane ticks the last step and keeps the second next', async ({ page }) => {
  await openHome(page, {
    initialPreferences: SEEN_FIRST_SCREEN,
    initialProjects: [ACME],
    initialSessions: [pane('fix-login-redirect', 2, 20)],
  });
  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]} (done)`, `${STEPS[2]}Start`, STEPS[3]]);

  await archivePane(page, 'fix-login-redirect');

  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]} (done)`, `${STEPS[2]}Start`, `${STEPS[3]} (done)`]);
});

test('a user with only the sample repo still has Open your project next', async ({ page }) => {
  await openHome(page, {
    initialPreferences: SEEN_FIRST_SCREEN,
    initialProjects: [SAMPLE],
    initialSessions: [pane('sample-task', 1, 30)],
  });

  await expectSteps(page, [`${STEPS[0]}Open`, STEPS[1], STEPS[2], STEPS[3]]);
});

test('Hide removes the card for good', async ({ page }) => {
  await openHome(page, { initialPreferences: SEEN_FIRST_SCREEN, initialProjects: [ACME] });

  await card(page).getByRole('button', { name: 'Hide' }).click();

  await expect(card(page)).toBeHidden();
  expect(await preferences(page)).toMatchObject({ onboarding_first_steps: 'hidden' });
});

for (const state of ['done', 'hidden']) {
  test(`a card marked ${state} stays gone`, async ({ page }) => {
    await openHome(page, { initialPreferences: { ...SEEN_FIRST_SCREEN, onboarding_first_steps: state }, initialProjects: [ACME] });

    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
}

test('an install that never saw the new first screen keeps Get Started and no checklist', async ({ page }) => {
  await openHome(page, { initialPreferences: { onboarding_repo_setup: 'true', onboarding_open_project_screen: 'false' } });

  await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test('Support Pane shows once, after the first archive, when GitHub CLI is ready', async ({ page }) => {
  await openHome(page, {
    ghReady: true,
    initialPreferences: { onboarding_repo_setup: 'false', onboarding_gh_prompt_shown: 'false' },
  });
  await page.getByRole('dialog', { name: 'Open your project' }).getByRole('button', { name: 'Skip' }).click();
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  await page.evaluate(projects => (window as MockBridgeWindow).__paneTestElectronMock.setProjects(projects), [ACME]);
  await page.evaluate(() => window.dispatchEvent(new Event('project-changed')));
  await addPane(page, pane('fix-login-redirect', 2, 20));
  await addPane(page, pane('dark-mode-toggle', 2, 10));
  await expect(page.getByRole('dialog', { name: 'Support Pane' })).toHaveCount(0);

  await archivePane(page, 'fix-login-redirect');
  const support = page.getByRole('dialog', { name: 'Support Pane' });
  await expect(support).toBeVisible();
  await support.getByRole('button', { name: 'Not now' }).click();

  await archivePane(page, 'dark-mode-toggle');
  await expect(card(page)).toBeHidden();
  await expect(support).toHaveCount(0);
  expect(await preferences(page)).toMatchObject({ onboarding_gh_prompt_shown: 'true' });
});

test('no Support Pane after the first archive when GitHub CLI is not ready', async ({ page }) => {
  await openHome(page, {
    initialPreferences: { ...SEEN_FIRST_SCREEN, onboarding_gh_prompt_shown: 'false' },
    initialProjects: [ACME],
    initialSessions: [pane('fix-login-redirect', 2, 20)],
  });
  await expectSteps(page, [`${STEPS[0]} (done)`, `${STEPS[1]} (done)`, `${STEPS[2]}Start`, STEPS[3]]);

  await archivePane(page, 'fix-login-redirect');

  await expect(card(page).getByRole('listitem').nth(3)).toHaveText(`${STEPS[3]} (done)`);
  await expect(page.getByRole('dialog', { name: 'Support Pane' })).toHaveCount(0);
});
