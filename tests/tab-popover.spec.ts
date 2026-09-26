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

test('agent presets create JSON-valid terminal state without a resume profile', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand repository Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Claude Code/ }).click();

  await expect.poll(() => page.evaluate(async () => {
    const result = await window.electronAPI.panels.getSessionPanels('tab-popover-session');
    const created = result.data?.find(entry => entry.title === 'Claude Code');
    if (!created) return null;
    return {
      command: created.state.customState?.initialCommand,
      hasResumeKey: Object.hasOwn(created.state.customState ?? {}, 'customResume'),
    };
  })).toEqual({ command: 'claude --dangerously-skip-permissions', hasResumeKey: false });
});

test('custom profiles keep their names and commands when renamed and launched', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand repository Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Add tool', exact: true });
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Add custom command…' }).click();
  const name = page.getByRole('textbox', { name: 'Name (optional)' });
  await expect(name).toBeFocused();
  await name.fill('Planner');
  await name.press('Tab');
  const command = page.getByRole('textbox', { name: 'Command to run' });
  await expect(command).toBeFocused();
  await command.fill('agent-farm run planner');
  await page.getByRole('checkbox', { name: 'Enable custom command resume' }).check();
  await page.getByRole('textbox', { name: 'Resume template', exact: true }).fill('{command} -- --resume {sessionId}');
  await command.press('Enter');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.electronAPI.panels.getSessionPanels('tab-popover-session');
    return result.data?.map(entry => entry.title);
  })).toContain('Planner');

  await trigger.click();
  await page.getByRole('button', { name: 'Rename Planner shortcut' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Reviewer');
  await expect(command).toHaveValue('agent-farm run planner');
  await expect(page.getByRole('checkbox', { name: 'Enable custom command resume' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Resume template', exact: true })).toHaveValue('{command} -- --resume {sessionId}');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Reviewer/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Planner/ })).toHaveCount(0);
  const path = testInfo.outputPath('named-custom-profile.png');
  await page.screenshot({ path });
  await testInfo.attach('named-custom-profile.png', { path, contentType: 'image/png' });
  await page.getByRole('menuitem', { name: /^Reviewer/ }).click();
  await expect.poll(() => page.evaluate(async () => {
    const result = await window.electronAPI.panels.getSessionPanels('tab-popover-session');
    return result.data?.map(entry => entry.title);
  })).toEqual(['Terminal', 'Planner', 'Reviewer']);
  expect(await page.evaluate(async () => {
    const result = await window.electronAPI.panels.getSessionPanels('tab-popover-session');
    return result.data?.filter(entry => entry.title !== 'Terminal').map(entry => entry.state.customState?.customResume);
  })).toEqual(Array(2).fill({ mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} -- --resume {sessionId}' }));

  await trigger.click();
  await page.getByRole('button', { name: 'Rename Reviewer shortcut' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Discarded');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Escape');
  await expect(page.getByRole('menuitem', { name: /^Reviewer/ })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Add custom command…' }).click();
  await command.fill('npm run dev');
  await page.getByRole('button', { name: 'Save & launch' }).click();
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: /^npm run dev/ })).toBeVisible();
});
