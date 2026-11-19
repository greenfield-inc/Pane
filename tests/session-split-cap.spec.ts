import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import type { SessionPanelLayout } from '../shared/types/panels';

// A Pane's own panel layout obeys the main area's two-split rule (T-40, D-448): with two splits
// shown, Split Right/Down are disabled and say why, an edge drop joins the group as a tab, and a
// layout saved with three splits opens as two with every tab. Stills go to T40_SHOTS_DIR when set.

const SHOTS = process.env.T40_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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

// The first terminal is the pinned dock terminal and never enters the layout. `hostActive` is the
// tab the host last marked active (what a desktop with no remembered layout falls back to).
const panelsWith = (hostActive: string) => [
  terminal('dock', 'Terminal', 0),
  ...[['alpha', 'Alpha'], ['gamma', 'Gamma'], ['beta', 'Beta'], ['delta', 'Delta']]
    .map(([id, title], index) => terminal(id, title, index + 1, id === hostActive)),
];

const group = (id: string, panelIds: string[], activePanelId = panelIds[0]) => ({ type: 'group' as const, id, panelIds, activePanelId });

const twoSplits: SessionPanelLayout = {
  version: 1,
  focusedGroupId: 'g-left',
  root: { type: 'split', id: 's-root', direction: 'row', sizes: [0.5, 0.5], children: [group('g-left', ['alpha', 'gamma']), group('g-right', ['beta', 'delta'])] },
};

// Saved before D-448: three side-by-side splits, the third focused.
const threeSplits: SessionPanelLayout = {
  version: 1,
  focusedGroupId: 'g-third',
  root: {
    type: 'split', id: 's-root', direction: 'row', sizes: [0.34, 0.33, 0.33],
    children: [group('g-left', ['alpha']), group('g-mid', ['gamma', 'beta'], 'beta'), group('g-third', ['delta'])],
  },
};

async function openPane(page: Page, layout: SessionPanelLayout, dark: boolean, hostActive = 'alpha') {
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' }));
  await installElectronApiMock(page, {
    platform: 'darwin',
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panelsWith(hostActive),
    initialLayout: layout,
    activeProjectId: project.id,
    initialConfig: { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' },
  });
  await gotoApp(page);
  await page.getByRole('button', { name: /^Expand project Split fixture$/ }).click();
  await page.getByRole('button', { name: 'Split pane', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Alpha', exact: true })).toBeVisible();
  // Room for both strips' tabs in the stills.
  await page.getByRole('button', { name: 'Hide details' }).click();
}

const groups = (page: Page) => page.locator('[data-panel-group-id]');
const groupTabs = (page: Page, index: number) => groups(page).nth(index).locator('.panel-group-tab-bar').getByRole('tab');
/** The panel ids in a group's strip, in order. */
const stripIds = (page: Page, index: number) => groupTabs(page, index).evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-panel-id')));
const shownTab = (page: Page, index: number) => groups(page).nth(index).locator('.panel-group-tab-bar [role="tab"][aria-selected="true"]');

async function still(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`at two splits, Split Right and Split Down are disabled and say why (${theme})`, async ({ page }) => {
    await openPane(page, twoSplits, dark);
    await expect(groups(page)).toHaveCount(2);
    await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
    // The fixture is a Mac (MacIntel, darwin): ⌘ is Meta on every runner.
    await page.keyboard.press('Meta+Shift+P');
    const input = page.getByRole('combobox', { name: 'Search', exact: true });
    await expect(input).toBeFocused();
    await input.fill('>split');
    for (const label of ['Split Right', 'Split Down']) {
      await expect(page.getByRole('option', { name: new RegExp(`^${label}`) })).toHaveAttribute('aria-disabled', 'true');
    }
    await page.getByRole('option', { name: /^Split Right/ }).hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'At most 2 splits' })).toBeVisible();
    await still(page, `1-split-commands-disabled-${theme}`);

    // The shortcut does nothing either: still two splits.
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
    await page.keyboard.press('Meta+Backslash');
    await expect(groups(page)).toHaveCount(2);
  });

  test(`at two splits, a tab dropped on a group's edge joins it as a tab (${theme})`, async ({ page }) => {
    await openPane(page, twoSplits, dark);
    const data = await page.evaluateHandle(() => new DataTransfer());
    await page.getByRole('tab', { name: 'Gamma', exact: true }).dispatchEvent('dragstart', { dataTransfer: data });
    const overlay = groups(page).nth(1).getByTestId('drop-overlay');
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box) throw new Error('drop overlay has no box');
    // The right edge band, where a free split would open a third column, offers the centre.
    const at = { clientX: box.x + box.width - 8, clientY: box.y + box.height / 2 };
    await overlay.dispatchEvent('dragover', { dataTransfer: data, ...at });
    await expect(overlay).toHaveAttribute('data-active-zone', 'center');
    await still(page, `2-edge-drop-offers-tab-${theme}`);
    await overlay.dispatchEvent('drop', { dataTransfer: data, ...at });

    await expect(groups(page)).toHaveCount(2);
    await expect.poll(() => stripIds(page, 0)).toEqual(['alpha']);
    await expect.poll(() => stripIds(page, 1)).toEqual(['beta', 'delta', 'gamma']);
    await expect(shownTab(page, 1)).toHaveAttribute('data-panel-id', 'gamma');
    await still(page, `2-third-split-landed-as-tab-${theme}`);
  });

  test(`a layout saved with three splits opens as two with every tab (${theme})`, async ({ page }) => {
    await openPane(page, threeSplits, dark);
    await expect(groups(page)).toHaveCount(2);
    await expect.poll(() => stripIds(page, 0)).toEqual(['alpha']);
    await expect.poll(() => stripIds(page, 1)).toEqual(['gamma', 'beta', 'delta']);
    // Alpha is separately marked active on the host. The saved focus follows Delta.
    await expect(groups(page).nth(1)).toHaveAttribute('data-group-focused', 'true');
    await expect(groups(page).nth(0)).toHaveAttribute('data-group-focused', 'false');
    await expect(shownTab(page, 1)).toHaveAttribute('data-panel-id', 'delta');
    await still(page, `3-saved-three-splits-open-as-two-${theme}`);
  });
}

// The host's last active tab, matching or stale (another split, or the same one), never undoes the
// focus and shown tab that folding carried over from the focused third split.
for (const [hostActive, why] of [['delta', 'matching'], ['alpha', 'stale, in the other split'], ['beta', 'stale, in the same split']] as const) {
  test(`a folded three-split layout keeps its saved focus with a ${why} host active tab`, async ({ page }) => {
    await openPane(page, threeSplits, false, hostActive);
    await expect(groups(page)).toHaveCount(2);
    await expect(groups(page).nth(1)).toHaveAttribute('data-group-focused', 'true');
    await expect(groups(page).nth(0)).toHaveAttribute('data-group-focused', 'false');
    await expect(shownTab(page, 1)).toHaveAttribute('data-panel-id', 'delta');
    await expect(shownTab(page, 0)).toHaveAttribute('data-panel-id', 'alpha');
  });
}
