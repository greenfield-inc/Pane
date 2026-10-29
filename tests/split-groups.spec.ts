import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { PanelActivationRequest, ToolPanel } from '../shared/types/panels';

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

test('a split pane keeps its tabs in the group strips and collapses the top row', async ({ page }, testInfo) => {
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

  // The top row has nothing to show while every tab is in a group strip.
  await expect(page.locator('.panel-tab-bar')).toBeHidden();

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

  // Each group strip has its own "+", which opens a New tab in that group.
  const addButtons = page.getByRole('button', { name: 'Add tool', exact: true });
  await expect(addButtons).toHaveCount(2);
  const rightAdd = addButtons.nth(1);
  await rightAdd.click();
  const newTab = page.getByRole('tab', { name: /New tab/ });
  await expect(newTab).toBeVisible();
  const tabBox = await newTab.boundingBox();
  const leftAddBox = await addButtons.nth(0).boundingBox();
  const rightAddBox = await rightAdd.boundingBox();
  expect(tabBox && leftAddBox && rightAddBox && tabBox.x > leftAddBox.x && tabBox.x < rightAddBox.x).toBe(true);
  await page.getByRole('button', { name: 'Close New tab', exact: true }).click();
  await expect(newTab).toHaveCount(0);

  // Group tabs are left-aligned real tabs: they close.
  await expect(page.getByRole('button', { name: 'Close Beta', exact: true })).toHaveCount(1);
});

for (const layoutReadFails of [false, true]) {
  test(`first visit places agent-opened pages beside the conversation when layout is ${layoutReadFails ? 'unavailable' : 'missing'}`, async ({ page }) => {
    await installElectronApiMock(page, {
      platform: 'darwin',
      initialProjects: [project],
      initialSessions: [session],
      initialPanels: [
        ...panels.slice(0, 2),
        {
          id: 'agent-plan', sessionId: session.id, type: 'browser', title: 'plan.html',
          state: { isActive: false, hasBeenViewed: false, customState: { currentUrl: 'about:blank' } },
          metadata: { createdAt: now, lastActiveAt: now, position: 2, openPlacement: 'split' },
        },
      ],
      initialLayout: null,
      activeProjectId: project.id,
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    if (layoutReadFails) {
      await page.evaluate(() => {
        const invoke = window.electronAPI.invoke;
        Object.assign(window.electronAPI, {
          invoke: (channel: string, ...args: unknown[]) => channel === 'panels:get-layout'
            ? Promise.resolve({ success: false, error: 'Layout unavailable' })
            : invoke(channel, ...args),
        });
      });
    }
    await page.getByRole('button', { name: /^Expand project Split fixture$/ }).click();
    await page.getByRole('button', { name: 'Split pane', exact: true }).click();

    const groups = page.locator('.panel-group-tab-bar');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).getByRole('tab', { name: 'Alpha', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(groups.nth(1).getByRole('tab', { name: 'plan.html', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}

for (const leaveVia of ['another Pane', 'the repository view'] as const) {
  test(`pages an agent opens while you are in ${leaveVia} land in the split, keeping the remembered focus`, async ({ page }) => {
    const other = { ...session, id: 'other-session', name: 'Other pane', worktreePath: '/tmp/split-fixture/other-session', displayOrder: 1 };
    await installElectronApiMock(page, {
      platform: 'darwin',
      initialProjects: [project],
      initialSessions: [session, other],
      initialPanels: panels,
      initialLayout: layout,
      activeProjectId: project.id,
      rememberPaneLayouts: true,
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Expand project Split fixture$/ }).click();
    await page.getByRole('button', { name: 'Split pane', exact: true }).click();
    const groups = page.locator('.panel-group-tab-bar');
    await expect(groups).toHaveCount(2);
    // Focus the right group, then leave: this desktop now remembers the layout.
    await groups.nth(1).getByRole('tab', { name: 'Beta', exact: true }).click();
    await expect.poll(() => rememberedFocusedGroup(page, session.id)).toEqual(['beta']);
    if (leaveVia === 'another Pane') await page.getByRole('button', { name: 'Other pane', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Project actions for Split fixture', exact: true }).click();
      await page.getByText('Open session on main', { exact: true }).click();
    }
    await expect(page.getByRole('tab', { name: 'Beta', exact: true })).toHaveCount(0);

    await page.evaluate(sessionId => {
      // SAFETY: installElectronApiMock adds these controls before the app loads.
      const mock = (window as typeof window & { __paneTestElectronMock: { emitPanelCreated: (panel: ToolPanel) => void; emitPanelActivation: (request: PanelActivationRequest) => void } }).__paneTestElectronMock;
      const now = new Date(0).toISOString();
      // As the host does for `panels open --file src/app.ts` and `--url http://localhost:5173`.
      for (const [id, title] of [['agent-file', 'app.ts'], ['agent-url', 'localhost:5173']] as const) {
        mock.emitPanelCreated({
          id, sessionId, type: 'browser', title,
          state: { isActive: true, hasBeenViewed: false, customState: { currentUrl: 'about:blank' } },
          metadata: { createdAt: now, lastActiveAt: now, position: 3, openPlacement: 'split' },
        });
        mock.emitPanelActivation({ sessionId, panelId: id, placement: 'split' });
      }
    }, session.id);
    await page.getByRole('button', { name: 'Split pane', exact: true }).click();

    await expect(groups).toHaveCount(2);
    await expect(groups.nth(1).getByRole('tab')).toHaveCount(3);
    expect(await groups.nth(0).getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(['Alpha']);
    expect(await groups.nth(1).getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(['Beta', 'app.ts', 'localhost:5173']);
    // Loading never steals focus: the side group keeps showing the tab it showed.
    await expect(groups.nth(1).getByRole('tab', { name: 'Beta', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(groups.nth(0).getByRole('tab', { name: 'Alpha', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}

/** The group this desktop remembers as focused for a Pane, as its panel ids. */
async function rememberedFocusedGroup(page: Page, paneId: string): Promise<string[] | null> {
  return page.evaluate(paneId => {
    type Node = { type: 'group'; id: string; panelIds: string[] } | { type: 'split'; children: Node[] };
    // SAFETY: installElectronApiMock's rememberPaneLayouts keeps layouts under this key, keyed `${hostId}/${paneId}`.
    const layouts = JSON.parse(window.localStorage.getItem('__pane_test_pane_layouts__') ?? '{}') as Record<string, { root: Node; focusedGroupId?: string }>;
    const layout = Object.entries(layouts).find(([key]) => key.endsWith(`/${paneId}`))?.[1];
    if (!layout) return null;
    const find = (node: Node): string[] | null => node.type === 'group'
      ? (node.id === layout.focusedGroupId ? node.panelIds : null)
      : node.children.map(find).find(Boolean) ?? null;
    return find(layout.root);
  }, paneId);
}
