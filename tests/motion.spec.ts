import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

// Guards the no-motion decision that a screenshot cannot: chrome surfaces —
// palettes, dialogs, menus, the sidebar reveal, button presses — come up and go
// away on the frame the input fires, with or without reduced motion. The only
// animation left in the app is information (spinners, pulses), not movement.

const project = {
  id: 1,
  name: 'dcouple/pane',
  path: '/tmp/pane',
  active: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

const session = {
  id: 'motion-pane',
  name: 'motion fixture',
  prompt: 'motion fixture',
  status: 'stopped',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  worktreePath: '/tmp/pane/wt/a',
  displayOrder: 0,
};

async function openDesktop(page: Page): Promise<void> {
  await installElectronApiMock(page, {
    analyticsConsentShown: true,
    initialProjects: [project],
    initialSessions: [session],
    initialUiState: { expandedProjects: [project.id] },
    activeProjectId: project.id,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('motion', () => {
  test('the command palette opens with no entrance animation', async ({ page }) => {
    await openDesktop(page);

    await page.keyboard.press('ControlOrMeta+Shift+P');
    const input = page.getByPlaceholder('Search commands...');
    await expect(input).toBeVisible();

    // A hundred-times-a-day keyboard surface: any entrance reads as lag, so the
    // panel and its backdrop both have to come up on the frame the key fires.
    const panelAnimation = await page.evaluate(() => {
      const panel = document.querySelector('[aria-modal="true"] .rounded-modal');
      return panel ? getComputedStyle(panel).animationName : null;
    });
    expect(panelAnimation).toBe('none');

    // ...and the selected row is wherever the arrow keys put it, with no
    // cross-fade trailing the keystroke.
    const rowDuration = await page.evaluate(() => {
      const row = document.querySelector('[role="option"]');
      return row ? getComputedStyle(row).transitionDuration : null;
    });
    expect(rowDuration).toBe('0s');
  });

  test('a dialog opens with no entrance animation', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const panel = await page.evaluate(() => {
      const element = document.querySelector('[aria-modal="true"] .rounded-modal');
      if (!element) return null;
      const style = getComputedStyle(element);
      return { name: style.animationName, transition: style.transitionDuration };
    });
    expect(panel?.name).toBe('none');
    expect(panel?.transition).toBe('0s');
  });

  test('the footer Home menu opens above its trigger', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: 'Home menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    const { origin, left, bottom, triggerTop } = await menu.evaluate((element: HTMLElement) => ({
      origin: getComputedStyle(element).transformOrigin,
      left: element.getBoundingClientRect().left,
      bottom: element.getBoundingClientRect().bottom,
      triggerTop: document.querySelector<HTMLButtonElement>('[aria-label="Home menu"]')?.getBoundingClientRect().top ?? 0,
    }));
    const [originX, originY] = origin.split(' ').map(Number.parseFloat);
    expect(originY).toBeGreaterThan(0);
    expect(originX).toBe(0);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(bottom).toBeLessThanOrEqual(triggerTop);
  });

  test('buttons do not scale or ease under the pointer', async ({ page }) => {
    await openDesktop(page);

    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();

    const resting = await cancel.evaluate((element) => ({
      transform: getComputedStyle(element).transform,
      duration: getComputedStyle(element).transitionDuration,
    }));
    expect(resting.transform).toBe('none');
    expect(resting.duration).toBe('0s');

    const box = await cancel.boundingBox();
    if (!box) throw new Error('Cancel button has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await page.waitForTimeout(150);
      expect(await cancel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    } finally {
      await page.mouse.up();
    }
  });

  test('reduced motion changes nothing because nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDesktop(page);

    const reveal = await page.locator('.pane-sidebar-slot').evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    );
    expect(reveal).toBe('0s');

    await page.getByRole('button', { name: 'Home menu' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `New pane in ${project.name}` }).click();
    const cancel = page.getByRole('dialog').getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    const box = await cancel.boundingBox();
    if (!box) throw new Error('Cancel button has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      expect(await cancel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    } finally {
      await page.mouse.up();
    }
  });
});
