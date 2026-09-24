import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 512, name: 'Pane', path: '/tmp/chrome-evidence', active: true, created_at: now, updated_at: now };
const session = {
  id: 'chrome-evidence-session',
  name: 'Flat chrome',
  worktreePath: '/tmp/chrome-evidence/flat-chrome',
  prompt: '',
  status: 'stopped',
  createdAt: now,
  lastActivity: now,
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const basePanel = {
  id: 'chrome-terminal',
  sessionId: session.id,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true },
};

const changedPath = 'frontend/src/components/panels/PanelGroupView.tsx';
const execution = {
  id: 1,
  session_id: session.id,
  execution_sequence: 1,
  after_commit_hash: '1234567890abcdef',
  commit_message: 'Guard macOS chrome typography',
  timestamp: '2026-08-29T12:00:00.000Z',
  stats_additions: 8,
  stats_deletions: 3,
  stats_files_changed: 1,
  author: 'Pane QA',
  comparison_branch: 'origin/main',
  history_source: 'branch',
};
const combinedDiff = {
  diff: [
    `diff --git a/${changedPath} b/${changedPath}`,
    'index 1111111..2222222 100644',
    `--- a/${changedPath}`,
    `+++ b/${changedPath}`,
    '@@ -1 +1 @@',
    '-old chrome',
    '+flat chrome',
  ].join('\n'),
  stats: { additions: 8, deletions: 3, filesChanged: 1 },
  changedFiles: [changedPath],
};

interface BootOptions {
  theme?: string;
  mountTerminal?: boolean;
  diff?: boolean;
}

async function bootChromeFixture(page: Page, opts: BootOptions = {}) {
  if (opts.theme) {
    await page.addInitScript((theme) => window.localStorage.setItem('theme', theme), opts.theme);
  }

  const fixturePanels = [{
    ...basePanel,
    state: { ...basePanel.state, isActive: !opts.mountTerminal },
  }];
  if (opts.mountTerminal) {
    fixturePanels.push({
      id: 'chrome-live-terminal',
      sessionId: session.id,
      type: 'terminal',
      title: 'Shell',
      state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: true } },
      metadata: { createdAt: now, lastActiveAt: now, position: 1, permanent: false },
    });
  }
  if (opts.diff) {
    fixturePanels.push({
      id: 'chrome-diff',
      sessionId: session.id,
      type: 'diff',
      title: 'Diff',
      state: { isActive: false, hasBeenViewed: true, customState: { isInitialized: false } },
      metadata: { createdAt: now, lastActiveAt: now, position: fixturePanels.length, permanent: true },
    });
  }

  await installElectronApiMock(page, {
    platform: 'darwin',
    initialConfig: opts.theme ? { theme: opts.theme, appearanceMode: 'fixed' } : undefined,
    initialProjects: [project],
    initialSessions: [{
      ...session,
      gitStatus: opts.diff
        ? { ...session.gitStatus, ahead: 1, filesChanged: 1, additions: 8, deletions: 3, totalCommits: 1 }
        : session.gitStatus,
    }],
    initialPanels: fixturePanels,
    initialTerminalStates: opts.mountTerminal
      ? { 'chrome-live-terminal': { scrollbackBuffer: 'ready\r\n' } }
      : undefined,
    initialCombinedDiff: opts.diff ? combinedDiff : undefined,
    initialExecutions: opts.diff ? [execution] : undefined,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Pane$/ }).click();
  await page.getByRole('button', { name: 'Flat chrome', exact: true }).click();
  if (opts.theme) {
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${opts.theme}\\b`));
  }
  if (opts.mountTerminal) {
    await expect(page.locator('.xterm-screen')).toHaveCount(1, { timeout: 15_000 });
  }
}

async function computedVar(page: Page, cssProp: string, value: string): Promise<string> {
  return page.evaluate(({ cssProp, value }) => {
    const probe = document.createElement('span');
    document.body.append(probe);
    try {
      probe.style.setProperty(cssProp, value);
      return getComputedStyle(probe).getPropertyValue(cssProp);
    } finally {
      probe.remove();
    }
  }, { cssProp, value });
}

async function expectTabRowChrome(page: Page, row: Locator): Promise<void> {
  await expect(row).toBeVisible();
  const expectedBackground = await computedVar(page, 'background-color', 'var(--color-bg-chrome)');
  const styles = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderBottomWidth: style.borderBottomWidth,
      borderTopWidth: style.borderTopWidth,
      borderLeftWidth: style.borderLeftWidth,
      borderRightWidth: style.borderRightWidth,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
    };
  });
  expect(styles).toEqual({
    backgroundColor: expectedBackground,
    borderBottomWidth: '1px',
    borderTopWidth: '0px',
    borderLeftWidth: '0px',
    borderRightWidth: '0px',
    borderRadius: '0px',
    boxShadow: 'none',
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' });
}

test('flat chrome preserves the primary navigation hierarchy', async ({ page }, testInfo) => {
  await bootChromeFixture(page);

  await expect(page.getByRole('button', { name: 'Home menu' })).toBeVisible();
  await expect(page.getByTestId('usage-nav')).toHaveCount(0);
  await expect(page.locator('.pane-sidebar-shell')).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.pane-session-shell')).toHaveCSS('border-radius', '0px');
  await attachScreenshot(page, testInfo, 'chrome-expanded');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByTestId('compact-usage')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sidebar menu' })).toBeVisible();
  await attachScreenshot(page, testInfo, 'chrome-collapsed');
});

test('inspector and add-tool surfaces remain reachable', async ({ page }, testInfo) => {
  await bootChromeFixture(page);

  const inspectorToggle = page.getByRole('button', { name: /Hide details|Show details/ });
  await expect(inspectorToggle).toBeVisible();
  await inspectorToggle.click();
  await inspectorToggle.click();
  await expect(page.getByRole('tab', { name: 'Details', exact: true })).toBeVisible();
  await attachScreenshot(page, testInfo, 'chrome-inspector');

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await attachScreenshot(page, testInfo, 'chrome-add-tool');
});

for (const theme of ['light-rounded', 'dark']) {
  test(`tab row paints on the chrome plane (${theme})`, async ({ page }) => {
    await bootChromeFixture(page, { theme, mountTerminal: true });
    const row = page.locator('.panel-tab-bar');
    await expectTabRowChrome(page, row);
    const activeTab = row.getByRole('tab', { selected: true });
    await expect(activeTab).toHaveCSS('border-top-left-radius', '6px');
    const tabBox = await activeTab.boundingBox();
    const rowBox = await row.boundingBox();
    if (!tabBox || !rowBox) throw new Error('Tab row is missing');
    expect(tabBox.y).toBeLessThanOrEqual(rowBox.y + 1);
    expect(tabBox.y + tabBox.height).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  });
}

test('macOS UI uses the sans stack; content surfaces stay monospace', async ({ page }) => {
  await bootChromeFixture(page, { mountTerminal: true, diff: true });

  const sans = await computedVar(page, 'font-family', 'var(--font-family-sans)');
  const expectSans = async (locator: Locator) => {
    await expect(locator).toBeVisible();
    await expect(locator).toHaveCSS('font-family', sans);
  };

  await expectSans(page.locator('body'));
  await expectSans(page.getByRole('button', { name: 'Add tool', exact: true }));
  await expectSans(page.getByRole('tab', { name: 'Details', exact: true }));

  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expectSans(page.getByRole('tab', { name: 'Changes', exact: true }));

  await page.getByRole('button', { name: 'Home menu' }).click();
  await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
  const feedback = page.getByRole('dialog', { name: 'Send feedback' });
  await expectSans(feedback.getByRole('heading', { name: 'Send feedback' }).last());
  await expectSans(feedback.getByText('Create a public issue in greenfield-inc/Pane.'));
  await feedback.getByRole('button', { name: 'Close modal' }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const settings = page.getByTestId('settings-page');
  await expectSans(settings.getByRole('heading', { name: 'Settings', exact: true }));
  await settings.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expectSans(settings.getByText('Choose an enumerated monospace font or enter a custom installed font name. Nerd Font symbols remain available.'));
  await expectSans(settings.getByRole('textbox', { name: 'Custom terminal font family' }));
  await expectSans(settings.getByRole('button', { name: 'Decrease terminal font size' }));
  await settings.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Flat chrome', exact: true }).click();

  await expect(page.locator('[data-terminal-font]').first()).toHaveAttribute(
    'data-terminal-font',
    '"Geist Mono", "Symbols Nerd Font Mono", monospace',
  );

});
