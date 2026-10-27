import { test, expect, type Page } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import type { FoundRepo, HostRepos, WslRepos } from '../shared/types/onboarding';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

// The renderer's Content-Security-Policy only lets analytics reach the default host.
const POSTHOG_HOST = 'https://runpane.com/api/c';
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const repo = (name: string, displayPath: string, branch: string, hoursAgo: number, source: FoundRepo['source'] = 'code_folder', path = `/home/dev/${displayPath.slice(2)}`): FoundRepo => ({
  name, path, displayPath, branch, lastCommitAt: NOW - hoursAgo * HOUR, source,
});

const MAC_REPOS: FoundRepo[] = [
  repo('acme-web', '~/code/acme-web', 'main', 2, 'claude_config'),
  repo('billing-api', '~/code/billing-api', 'main', 26),
  repo('mobile-app', '~/dev/mobile-app', 'develop', 96),
];

interface FinderSetup {
  host?: HostRepos;
  hostDelayMs?: number;
  /** null makes the WSL call fail. */
  wsl?: WslRepos | null;
  wslDelayMs?: number;
  sample?: { success: boolean; error?: string; data?: JsonObject };
  sampleDelayMs?: number;
  checkFolder?: { success: boolean; error?: string; data?: JsonObject };
}

type OnboardingTestWindow = Window & {
  __onboardingTest: { created: unknown[] };
  __paneTestElectronMock: { getPreferences(): Record<string, string> };
};

async function createdProjects(page: Page): Promise<unknown[]> {
  // SAFETY: openFirstRun's init script installs __onboardingTest before navigation.
  return page.evaluate(() => (window as OnboardingTestWindow).__onboardingTest.created);
}

async function preferences(page: Page): Promise<Record<string, string>> {
  // SAFETY: installElectronApiMock installs this test bridge before navigation.
  return page.evaluate(() => (window as OnboardingTestWindow).__paneTestElectronMock.getPreferences());
}

async function openFirstRun(page: Page, finder: FinderSetup, options: ElectronApiMockOptions = {}) {
  await installElectronApiMock(page, {
    ...options,
    initialPreferences: { onboarding_repo_setup: 'false', ...options.initialPreferences },
  });
  await page.addInitScript((setup: FinderSetup) => {
    const later = <Value>(value: Value, delayMs = 0) => new Promise<Value>(resolve => setTimeout(() => resolve(value), delayMs));
    const onboarding = window.electronAPI.onboarding;
    const created: unknown[] = [];
    Object.defineProperty(window, '__onboardingTest', { configurable: true, value: { created } });
    const create = window.electronAPI.projects.create;
    window.electronAPI.projects.create = (request) => {
      created.push({ ...request });
      return create(request);
    };
    onboarding.detectEnvironment = async () => ({ success: true, data: { gitInstalled: true } });
    onboarding.findRepos = () => later({ success: true, data: setup.host ?? { repos: [], shells: [], wslDistro: null } }, setup.hostDelayMs);
    onboarding.findWslRepos = () => later(setup.wsl ? { success: true, data: setup.wsl } : { success: false, error: 'wsl.exe timed out' }, setup.wslDelayMs);
    if (setup.sample) {
      const sample = setup.sample;
      onboarding.setupDefaultRepo = () => later(sample, setup.sampleDelayMs);
    }
    if (setup.checkFolder) {
      const answer = setup.checkFolder;
      onboarding.checkFolder = async () => answer;
    }
  }, finder);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Open your project' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function dialogHeight(page: Page): Promise<number> {
  const box = await page.getByRole('dialog', { name: 'Open your project' }).boundingBox();
  if (!box) throw new Error('dialog has no box');
  return Math.round(box.height);
}

test('lists found repos newest first and opens the selected one', async ({ page }) => {
  const dialog = await openFirstRun(page, { host: { repos: MAC_REPOS, shells: [], wslDistro: null } });

  const rows = dialog.getByRole('radiogroup', { name: 'Your repos' }).getByRole('radio');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('acme-web~/code/acme-webmain · 2h ago');
  await expect(rows.nth(2)).toContainText('mobile-app~/dev/mobile-appdevelop · 4d ago');
  await expect(rows.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('button', { name: 'Choose another folder…' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clone from GitHub' })).toBeVisible();
  await expect(dialog.getByText('No project handy?')).toBeVisible();

  await rows.nth(1).click();
  await dialog.getByRole('button', { name: 'Open billing-api' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('billing-api').first()).toBeVisible();
  expect(await preferences(page)).toMatchObject({ onboarding_repo_setup: 'true', onboarding_open_project_screen: 'seen' });
});

test('arrow keys move the selection through the repo list', async ({ page }) => {
  const dialog = await openFirstRun(page, { host: { repos: MAC_REPOS, shells: [], wslDistro: null } });
  const rows = dialog.getByRole('radio');

  await rows.nth(0).focus();
  await page.keyboard.press('ArrowDown');

  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('button', { name: 'Open billing-api' })).toBeEnabled();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(2)).toHaveAttribute('aria-checked', 'true');
});

test('loading, empty and three results share one dialog height', async ({ page }) => {
  const loading = await openFirstRun(page, { host: { repos: MAC_REPOS, shells: [], wslDistro: null }, hostDelayMs: 60_000 });
  await expect(loading.getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
  const loadingHeight = await dialogHeight(page);

  const empty = await openFirstRun(page, {});
  await expect(empty.getByText('No Git repos found in your usual code folders.')).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Choose a folder…' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Choose another folder…' })).toHaveCount(0);
  const emptyHeight = await dialogHeight(page);

  await openFirstRun(page, { host: { repos: MAC_REPOS, shells: [], wslDistro: null } });
  const loadedHeight = await dialogHeight(page);

  expect(emptyHeight).toBe(loadingHeight);
  expect(loadedHeight).toBe(loadingHeight);
});

test('a picked folder that is not a repo shows why and adds nothing', async ({ page }) => {
  const dialog = await openFirstRun(page, {
    host: { repos: MAC_REPOS, shells: [], wslDistro: null },
    checkFolder: { success: false, error: "That folder isn't a Git repo. Choose a repo folder. To start a new repo, skip this and use Add repository." },
  });

  await dialog.getByRole('button', { name: 'Choose another folder…' }).click();

  await expect(dialog.getByRole('alert')).toHaveText("That folder isn't a Git repo. Choose a repo folder. To start a new repo, skip this and use Add repository.");
  await expect(dialog.getByRole('button', { name: 'Open acme-web' })).toBeEnabled();
  expect(await createdProjects(page)).toEqual([]);
});

test('the sample repo shows progress, then its failure with Try again', async ({ page }) => {
  const dialog = await openFirstRun(page, {
    host: { repos: MAC_REPOS, shells: [], wslDistro: null },
    sample: { success: false, error: "Pane couldn't reach GitHub" },
    sampleDelayMs: 1_000,
  });

  await dialog.getByRole('button', { name: 'Try Pane on a sample repo' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Setting up the sample repo…');
  await expect(dialog.getByRole('button', { name: 'Open acme-web' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Skip' })).toBeEnabled();

  await expect(dialog.getByRole('alert')).toContainText("Couldn't set up the sample repo: Pane couldn't reach GitHub. Check your connection and try again.");
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open acme-web' })).toBeEnabled();
});

test('Windows with WSL shows both columns and selects the newest repo across them', async ({ page }) => {
  const dialog = await openFirstRun(page, {
    host: {
      repos: [repo('acme-web', 'C:\\code\\acme-web', 'main', 30, 'code_folder', 'C:\\code\\acme-web'), repo('notes-app', 'C:\\dev\\notes-app', 'main', 50, 'code_folder', 'C:\\dev\\notes-app')],
      shells: ['Git Bash', 'PowerShell'],
      wslDistro: 'Ubuntu-24.04',
    },
    wsl: {
      distro: 'Ubuntu-24.04',
      agents: ['Claude Code'],
      repos: [
        repo('billing-api', '~/code/billing-api', 'main', 2, 'claude_config', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\billing-api'),
        repo('infra', '~/work/infra', 'main', 70, 'code_folder', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\work\\infra'),
      ],
    },
    wslDelayMs: 500,
  }, { platform: 'win32' });

  await expect(dialog.getByText('Where does your code live? Pane runs agents in the same place.')).toBeVisible();
  const windows = dialog.getByRole('radiogroup', { name: 'Windows repos' });
  await expect(windows.getByRole('radio').nth(0)).toContainText('acme-webC:\\code');
  await expect(dialog.getByText('Shell: Git Bash · PowerShell')).toBeVisible();
  await expect(dialog.getByText('Agents run inside WSL. Claude Code found.')).toBeVisible();
  const wsl = dialog.getByRole('radiogroup', { name: 'WSL Ubuntu-24.04 repos' });
  await expect(wsl.getByRole('radio').nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(wsl.getByRole('radio').nth(0)).toContainText('billing-api~/code');

  await dialog.getByRole('button', { name: 'Open billing-api' }).click();

  await expect(dialog).toBeHidden();
  expect(await createdProjects(page)).toEqual([
    { name: 'billing-api', path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\code\\billing-api', active: false },
  ]);
});

test('a WSL column that cannot be read says so and keeps the Windows column usable', async ({ page }) => {
  const dialog = await openFirstRun(page, {
    host: { repos: [repo('acme-web', 'C:\\code\\acme-web', 'main', 30, 'code_folder', 'C:\\code\\acme-web')], shells: ['Git Bash'], wslDistro: 'Ubuntu-24.04' },
    wsl: null,
  }, { platform: 'win32' });

  await expect(dialog.getByText("Couldn't read WSL in time. Choose a folder instead.")).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Open acme-web' })).toBeEnabled();
});

test('opening a found repo records onboarding_completed once with its entry and source', async ({ page }) => {
  const events: Array<{ event?: string; properties?: JsonObject }> = [];
  // The SDK drops WebDriver and HeadlessChrome clients, so look like a desktop browser.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // SAFETY: Chromium exposes these optional structured user-agent client hints.
    const clientHints = (navigator as Navigator & { userAgentData?: { brands: Array<{ brand: string; version: string }> } }).userAgentData;
    if (clientHints) {
      Object.defineProperty(clientHints, 'brands', { value: clientHints.brands.filter((entry) => entry.brand !== 'HeadlessChrome') });
      Object.defineProperty(navigator, 'userAgentData', { value: clientHints });
    }
  });
  await page.route(`${POSTHOG_HOST}/**`, async (route) => {
    const raw = route.request().postDataBuffer() ?? Buffer.alloc(0);
    const text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
    try {
      const encoded = new URLSearchParams(text).get('data');
      // SAFETY: PostHog posts a JSON event, a batch, or an array of events, raw or base64 in a data field.
      const body = JSON.parse(encoded ? Buffer.from(encoded, 'base64').toString('utf8') : text) as { batch?: typeof events } | typeof events;
      events.push(...(Array.isArray(body) ? body : body.batch ?? [body]));
    } catch {
      // Not an event payload.
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const dialog = await openFirstRun(page, { host: { repos: MAC_REPOS, shells: [], wslDistro: null } }, {
    initialPreferences: { analytics_default_applied: 'true' },
    initialConfig: { analytics: { enabled: true, posthogApiKey: 'phc_test', posthogHost: POSTHOG_HOST } },
  });

  await dialog.getByRole('button', { name: 'Open acme-web' }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => events.filter(event => event.event === 'onboarding_completed').length, { timeout: 20_000 }).toBe(1);
  expect(events.find(event => event.event === 'onboarding_completed')?.properties).toMatchObject({
    entry: 'found_repo',
    repo_source: 'claude_config',
    wsl: false,
  });
});
