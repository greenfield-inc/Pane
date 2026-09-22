import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import { readTerminalTheme } from './terminalXterm';
import { THEME_CLASSES, type AppearanceConfig } from '../shared/types/appearance';

type AppearanceMock = {
  getBackgroundColorWrites: () => Array<{ theme: string; color: string }>;
  getTitleBarOverlayWrites: () => Array<{ color: string; symbolColor: string }>;
  getConfig: () => AppearanceConfig;
  failNextBackgroundColorWrite: (error: string) => void;
};

const readBootstrapThemeClasses = (page: import('@playwright/test').Page) => page.evaluate(() => {
  // SAFETY: The head bootstrap assigns this synchronous first-paint artifact before React loads.
  return (window as typeof window & { __paneBootstrapThemeClasses?: string[] }).__paneBootstrapThemeClasses;
});

test('every canonical theme is applied before the React entry point can load', async ({ page }) => {
  test.setTimeout(60_000); // One navigation per supported theme, also under the minimal CI config.
  // No renderer can repair missing bootstrap classes in this test.
  await page.route('**/*', (route) => route.request().resourceType() === 'script' ? route.abort() : route.continue());
  await page.addInitScript(() => {
    const fixedTheme = new URL(location.href).searchParams.get('bootstrap-theme');
    localStorage.setItem('pane.appearance.v1', JSON.stringify({
      v: 1, appearanceMode: 'fixed', theme: fixedTheme,
      systemLightTheme: 'light-rounded', systemDarkTheme: 'dark',
    }));
  });
  for (const [theme, classes] of Object.entries(THEME_CLASSES)) {
    await page.goto(`/?bootstrap-theme=${theme}`, { waitUntil: 'domcontentloaded' });
    expect(await readBootstrapThemeClasses(page)).toEqual(classes);
    expect(await page.locator('html').evaluate((element) => [...element.classList])).toEqual(classes);
    expect(await page.locator('body').evaluate((element) => [...element.classList])).toEqual(classes);
    await expect(page.locator('html')).toHaveCSS('color-scheme', classes[0]);
  }
});

test('first paint resolves the authoritative snapshot against the synchronous system preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('pane.appearance.v1', JSON.stringify({
      v: 1, appearanceMode: 'fixed', theme: 'folio',
      systemLightTheme: 'folio', systemDarkTheme: 'walnut',
    }));
    localStorage.setItem('theme', 'light');
  });
  await installElectronApiMock(page, {
    initialConfig: {
      appearanceMode: 'system', theme: 'light-rounded', systemLightTheme: 'folio', systemDarkTheme: 'abyss',
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b.*\babyss\b/);
  await expect(page.locator('body')).toHaveClass(/\bdark\b.*\babyss\b/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  expect(await readBootstrapThemeClasses(page)).toEqual(['dark', 'abyss']);
});

test('cache and legacy values are fallback-only fixed appearances', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pane.appearance.v1', JSON.stringify({
      v: 1, appearanceMode: 'fixed', theme: 'haar', systemLightTheme: 'light-rounded', systemDarkTheme: 'dark',
    }));
  });
  await installElectronApiMock(page, { appearanceSnapshot: false });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/\blight\b.*\bhaar\b/);
  expect(await readBootstrapThemeClasses(page)).toEqual(['light', 'haar']);

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.close();
});

test('legacy theme is fixed and an invalid legacy value falls back to defaults', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('theme', 'walnut'));
  await installElectronApiMock(page, { appearanceSnapshot: false, initialConfig: { theme: 'walnut' } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b.*\bwalnut\b/);
  expect(await readBootstrapThemeClasses(page)).toEqual(['dark', 'walnut']);
  expect(await page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getConfig();
  })).toMatchObject({ appearanceMode: 'fixed', theme: 'walnut' });
  await context.close();

  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  await invalidPage.addInitScript(() => localStorage.setItem('theme', 'invalid'));
  await installElectronApiMock(invalidPage, { appearanceSnapshot: false });
  await invalidPage.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(invalidPage.locator('html')).toHaveClass(/\blight\b.*\blight-rounded\b/);
  expect(await readBootstrapThemeClasses(invalidPage)).toEqual(['light', 'light-rounded']);
  await invalidContext.close();
});

test('System refreshes native window colors without a Google Fonts connection', async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.emulateMedia({ colorScheme: 'light' });
  await installElectronApiMock(page, {
    windowControlsOverlayEnabled: true,
    initialConfig: {
      appearanceMode: 'system', theme: 'walnut', systemLightTheme: 'folio', systemDarkTheme: 'forge',
    },
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveClass(/folio/);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getBackgroundColorWrites().at(-1)?.theme;
  })).toBe('folio');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/forge/);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getBackgroundColorWrites().at(-1)?.theme;
  })).toBe('forge');
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getTitleBarOverlayWrites().length;
  })).toBeGreaterThan(1);
});

test('fulfilled background-colour failures are logged without interrupting System updates', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await installElectronApiMock(page, {
    initialConfig: {
      appearanceMode: 'system', theme: 'walnut', systemLightTheme: 'folio', systemDarkTheme: 'forge',
    },
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveClass(/folio/);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getBackgroundColorWrites().at(-1)?.theme;
  })).toBe('folio');

  await page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.failNextBackgroundColorWrite('native background failed');
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/forge/);
  await expect.poll(() => consoleErrors.some((message) =>
    message.includes('Failed to apply window background colour:') && message.includes('native background failed')
  )).toBe(true);

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/folio/);
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: A successful write after the injected failure proves the bridge remains operational.
    return (window as typeof window & { __paneTestElectronMock: AppearanceMock }).__paneTestElectronMock.getBackgroundColorWrites().at(-1)?.theme;
  })).toBe('folio');
});

test('Fixed appearance ignores live system preference changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await installElectronApiMock(page, {
    initialConfig: {
      appearanceMode: 'fixed', theme: 'walnut', systemLightTheme: 'folio', systemDarkTheme: 'forge',
    },
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html')).toHaveClass(/walnut/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/walnut/);
});

test('terminal palette and rendered diff follow a System slot flip', async ({ page }) => {
  const now = new Date(0).toISOString();
  const project = { id: 931, name: 'appearance-runtime', path: '/tmp/appearance-runtime', active: true, created_at: now, updated_at: now };
  const session = {
    id: 'appearance-runtime-session', name: 'Appearance runtime', worktreePath: '/tmp/appearance-runtime/worktree',
    prompt: '', status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
    permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
    gitStatus: { state: 'ahead', ahead: 1, behind: 0, hasUncommittedChanges: true, hasUntrackedFiles: false, filesChanged: 1 },
  };
  const panels = [
    { id: 'appearance-terminal', sessionId: session.id, type: 'terminal', title: 'Terminal', state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: true } }, metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true } },
    { id: 'appearance-diff', sessionId: session.id, type: 'diff', title: 'Diff', state: { isActive: true, hasBeenViewed: true }, metadata: { createdAt: now, lastActiveAt: now, position: 1, permanent: true } },
  ];
  const diff = [
    'diff --git a/example.ts b/example.ts', 'index 1111111..2222222 100644', '--- a/example.ts', '+++ b/example.ts',
    '@@ -1 +1 @@', '-export const value = 1;', '+export const value = 2;',
  ].join('\n');
  await page.emulateMedia({ colorScheme: 'light' });
  await installElectronApiMock(page, {
    initialConfig: { appearanceMode: 'system', theme: 'light-rounded', systemLightTheme: 'folio', systemDarkTheme: 'forge' },
    initialProjects: [project], initialSessions: [session], initialPanels: panels, activeProjectId: project.id,
    initialExecutions: [{
      id: 1, session_id: session.id, execution_sequence: 1, after_commit_hash: '2222222', commit_message: 'Change example',
      timestamp: now, stats_additions: 1, stats_deletions: 1, stats_files_changed: 1, author: 'Pane', comparison_branch: 'origin/main', history_source: 'branch',
    }],
    diffManifests: {
      session: {
        scope: { kind: 'session' },
        files: [{ path: 'example.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false }],
        resolvedBase: { kind: 'comparison-base', ref: 'origin/main', hash: '1111111' },
        resolvedTarget: { kind: 'working-tree' },
        stats: { additions: 1, deletions: 1, filesChanged: 1 },
      },
    },
    fileDiffs: {
      'session:example.ts': {
        file: { path: 'example.ts', kind: 'modified', additions: 1, deletions: 1, isBinary: false },
        patch: diff,
        status: 'changed',
      },
    },
    initialTerminalStates: { 'appearance-terminal': { scrollbackBuffer: 'ready\r\n' } },
  });
  await page.goto('/');
  const expandRepo = page.getByRole('button', { name: /^Expand repository appearance-runtime$/ });
  await expect(expandRepo).toBeVisible();
  await expandRepo.click();
  await page.getByRole('button', { name: session.name, exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const expandTerminal = page.getByRole('button', { name: 'Expand terminal', exact: true });
  if (await expandTerminal.isVisible().catch(() => false)) await expandTerminal.click();
  const terminalSurface = page.locator('.xterm-screen').first();
  await expect(terminalSurface).toBeVisible({ timeout: 15_000 });

  const terminalBackground = () => readTerminalTheme(terminalSurface).then((theme) => theme.background ?? '');
  await expect.poll(terminalBackground).not.toBe('');
  const lightBackground = await terminalBackground();
  await page.getByRole('treeitem', { name: /^Open diff for example\.ts,/ }).click();
  await expect(page.getByText('example.ts', { exact: true }).last()).toBeVisible();
  const lightDiffColor = await page.getByText('export const value = 2;', { exact: false }).last().evaluate((element) => getComputedStyle(element).color);

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/forge/);
  await expect.poll(terminalBackground).not.toBe(lightBackground);
  await expect.poll(() => page.getByText('export const value = 2;', { exact: false }).last().evaluate((element) => getComputedStyle(element).color)).not.toBe(lightDiffColor);
});
