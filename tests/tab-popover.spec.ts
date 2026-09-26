import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const now = new Date(0).toISOString();
const project = { id: 513, name: 'Popover', path: '/tmp/tab-popover', active: true, created_at: now, updated_at: now };
const session = {
  id: 'tab-popover-session', name: 'Tool menu', worktreePath: '/tmp/tab-popover/tool-menu', prompt: '',
  status: 'stopped', createdAt: now, lastActivity: now, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', projectId: project.id, displayOrder: 0, isFavorite: false, toolType: 'none', archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panel = {
  id: 'popover-terminal', sessionId: session.id, type: 'terminal', title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0, permanent: true },
};
test('add-tool popover supports keyboard navigation and dismissal', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session], initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();

  const trigger = page.getByRole('button', { name: 'Add tool', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  const path = testInfo.outputPath('tab-popover.png');
  await page.screenshot({ path });
  await testInfo.attach('tab-popover.png', { path, contentType: 'image/png' });

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Explorer in the add-tool menu creates a missing panel and opens the Files inspector', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Explorer', exact: false }).click();

  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('inspector arrows move selection and focus through every tab', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [session], activeProjectId: project.id,
    initialPanels: [panel, ...['explorer', 'diff'].map((type, index) => ({
      ...panel, id: `inspector-${type}`, type, title: type,
      metadata: { ...panel.metadata, position: index + 1 },
    }))],
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Expand repository Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Inspector' });
  await tabs.getByRole('tab', { name: 'Details' }).click();
  for (const name of ['Files', 'Changes', 'Details']) {
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name })).toBeFocused();
    await expect(tabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  }
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Changes' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('inspector-keyboard.png') });
});
