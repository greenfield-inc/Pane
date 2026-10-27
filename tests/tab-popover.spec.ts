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
const picker = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Start an agent here' });

test('the New tab picker moves focus through its rows with the arrow keys', async ({ page }, testInfo) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session], initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  const rows = picker(page).getByRole('button');
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(picker(page).getByRole('button', { name: /^Plain terminal/ })).toBeFocused();
  const path = testInfo.outputPath('tab-popover.png');
  await page.screenshot({ path });
  await testInfo.attach('tab-popover.png', { path, contentType: 'image/png' });
});

test('Explorer in the New tab picker creates a missing panel and opens the Files inspector', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();

  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await picker(page).getByRole('button', { name: 'Explorer', exact: true }).click();

  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: /New tab/ })).toHaveCount(0);
});

test('agent presets create JSON-valid terminal state without a resume profile', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [panel], activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  await picker(page).getByRole('button', { name: /^Claude Code/ }).click();

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
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Add tool', exact: true });
  await trigger.click();
  await picker(page).getByRole('button', { name: 'Add custom command…' }).click();
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
  await expect(picker(page)).toHaveCount(0);
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
  await expect(picker(page).getByRole('button', { name: 'Reviewer', exact: true })).toBeVisible();
  await expect(picker(page).getByRole('button', { name: 'Planner', exact: true })).toHaveCount(0);
  const path = testInfo.outputPath('named-custom-profile.png');
  await page.screenshot({ path });
  await testInfo.attach('named-custom-profile.png', { path, contentType: 'image/png' });
  await picker(page).getByRole('button', { name: 'Reviewer', exact: true }).click();
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
  await expect(picker(page).getByRole('button', { name: 'Reviewer', exact: true })).toBeVisible();
  await picker(page).getByRole('button', { name: 'Add custom command…' }).click();
  await command.fill('npm run dev');
  await page.getByRole('button', { name: 'Save & launch' }).click();
  await trigger.click();
  await expect(picker(page).getByRole('button', { name: 'npm run dev', exact: true })).toBeVisible();
});

test('chat promotion sends the selected chat and preserves it when the move is rejected', async ({ page }) => {
  await installElectronApiMock(page, {
    platform: 'darwin', initialProjects: [project], initialSessions: [session],
    initialPanels: [{ ...panel, title: 'Codex chat', state: { ...panel.state, customState: { agentType: 'codex', initialCommand: 'codex --yolo', agentSessionId: 'saved-chat' } } }], activeProjectId: project.id,
  });
  await page.addInitScript(() => {
    const original = window.electronAPI.invoke.bind(window.electronAPI);
    window.electronAPI.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'orchestration-sessions:promote') {
        sessionStorage.setItem('promotion-request', JSON.stringify(args[0]));
        return { success: false, error: 'Wait for the agent to finish before moving this chat' };
      }
      return original(channel, ...args);
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
  await page.getByRole('button', { name: 'Tool menu', exact: true }).click();
  await page.getByRole('button', { name: 'Move chat to Session', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move chat to Session' });
  await expect(dialog.getByRole('textbox', { name: 'Session name' })).toHaveValue('Tool menu');
  await dialog.getByRole('textbox', { name: 'Session name' }).fill('Feature planning');
  await dialog.getByRole('button', { name: 'Move chat', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Wait for the agent');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('promotion-request')!))).toEqual({ panelId: panel.id, name: 'Feature planning' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Move chat to Session', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await window.electronAPI.panels.getSessionPanels('tab-popover-session')).data?.map(item => item.id))).toContain(panel.id);
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
  await page.getByRole('button', { name: /^Expand project Popover$/ }).click();
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
