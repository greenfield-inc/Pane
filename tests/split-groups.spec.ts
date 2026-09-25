import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Once a pane is split, every tab lives in its group's strip: the top tab
// row collapses (its Run / inspector controls sit on the title strip), and
// each group carries its own "+" that opens the add-tool menu for that group.

const now = new Date(0).toISOString();
const project = { id: 42, name: 'Split fixture', path: '/tmp/split-fixture', active: true, created_at: now, updated_at: now };
const session = {
  id: 'split-session',
  name: 'Split pane',
  worktreePath: '/tmp/split-fixture/split-session',
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

const terminal = (id: string, title: string, position: number, isActive = false) => ({
  id,
  sessionId: session.id,
  type: 'terminal',
  title,
  state: { isActive, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position },
});

// The first terminal is the pinned dock terminal and never enters the layout.
const panels = [terminal('dock', 'Terminal', 0), terminal('alpha', 'Alpha', 1, true), terminal('beta', 'Beta', 2)];

const layout = {
  version: 1,
  focusedGroupId: 'g-left',
  root: {
    type: 'split',
    id: 's-root',
    direction: 'row',
    sizes: [1, 1],
    children: [
      { type: 'group', id: 'g-left', panelIds: ['alpha'], activePanelId: 'alpha' },
      { type: 'group', id: 'g-right', panelIds: ['beta'], activePanelId: 'beta' },
    ],
  },
};

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

test('a split pane keeps its tabs in the group strips and a draggable top row', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    initialLayout: layout,
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Split fixture$/ }).click();
  await page.getByRole('button', { name: 'Split pane', exact: true }).click();

  const alpha = page.getByRole('tab', { name: 'Alpha', exact: true });
  const beta = page.getByRole('tab', { name: 'Beta', exact: true });
  await expect(alpha).toBeVisible();
  await expect(beta).toBeVisible();

  // The top row stays at the window edge for dragging and global controls.
  const topBar = page.locator('.panel-tab-bar');
  await expect(topBar).toBeVisible();
  await expect(topBar.getByRole('tab')).toHaveCount(0);

  const groupRows = page.locator('.panel-group-tab-bar');
  await expect(groupRows).toHaveCount(2);
  const expectedBackground = await computedVar(page, 'background-color', 'var(--color-bg-chrome)');
  for (let index = 0; index < 2; index += 1) {
    const styles = await groupRows.nth(index).evaluate((element) => {
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

  // Global controls moved to the title strip.
  const trailing = page.getByTestId('window-title-bar-trailing-controls');
  await expect(trailing.getByRole('button', { name: /Hide details|Show details/ })).toBeVisible();

  await page.mouse.move(4, 4);
  const shot = testInfo.outputPath('split-groups.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('split-groups.png', { path: shot, contentType: 'image/png' });

  // Each group strip has its own "+", anchored menu included.
  const addButtons = page.getByRole('button', { name: 'Add tool', exact: true });
  await expect(addButtons).toHaveCount(2);
  const rightAdd = addButtons.nth(1);
  await rightAdd.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  const buttonBox = await rightAdd.boundingBox();
  expect(menuBox && buttonBox && Math.abs(menuBox.x - buttonBox.x) < 40).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Group tabs are left-aligned real tabs: they close.
  await expect(page.getByRole('button', { name: 'Close Beta', exact: true })).toHaveCount(1);
});
