import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { SubmitFeedbackRequest } from '../shared/types/feedback';
import { installElectronApiMock } from './electronApiMock';

type FeedbackMock = {
  getFeedbackSubmissions: () => SubmitFeedbackRequest[];
  getOpenedExternalUrls: () => string[];
};

async function bootApp(page: Page, options: Parameters<typeof installElectronApiMock>[1] = {}) {
  await installElectronApiMock(page, options);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
}

function readSubmissions(page: Page) {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (
    window as typeof window & { __paneTestElectronMock: FeedbackMock }
  ).__paneTestElectronMock.getFeedbackSubmissions());
}

function readOpenedUrls(page: Page) {
  // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
  return page.evaluate(() => (
    window as typeof window & { __paneTestElectronMock: FeedbackMock }
  ).__paneTestElectronMock.getOpenedExternalUrls());
}

/**
 * Capture a journey frame into the test's output directory once every running animation
 * has settled, so captures are never translucent mid fade-in.
 */
async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 2_000 },
  ).catch(() => undefined);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function collapseSidebar(page: Page) {
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
}

async function openSettings(page: Page) {
  // The compact rail exposes Settings directly.
  await collapseSidebar(page);

  const settingsButton = page.getByRole('button', { name: 'Settings' }).first();
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  return settingsButton;
}

test.describe('Feedback entry points', () => {
  test('expanded sidebar menu opens feedback and submits the happy path', async ({ page }, testInfo) => {
    await bootApp(page);
    await shot(page, testInfo, '01-expanded-sidebar');

    await page.getByRole('button', { name: 'Home menu' }).click();
    await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dialog).toBeVisible();
    // The header owns the only close control; Modal's own corner button stays off so the
    // two do not stack on top of each other.
    await expect(dialog.getByRole('button', { name: /close/i })).toHaveCount(1);
    await shot(page, testInfo, '02-dialog-default');

    await dialog.locator('input[type="text"]').fill('Terminal flicker on fast pane switch');
    await dialog.locator('textarea').fill('The terminal flickers when I switch panes quickly.');
    await shot(page, testInfo, '03-dialog-filled');

    await dialog.getByRole('button', { name: 'Submit feedback' }).click();
    await expect(dialog.getByText('Feedback submitted')).toBeVisible();
    await expect(dialog.getByText('Screenshots help.')).toBeVisible();
    await shot(page, testInfo, '04-dialog-success');

    const submissions = await readSubmissions(page);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      type: 'bug',
      title: 'Terminal flicker on fast pane switch',
      body: 'The terminal flickers when I switch panes quickly.',
      includeAppDetails: true,
      appDetails: { version: 'test' },
    });

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Home menu' })).toBeFocused();
  });

  test('failure keeps the text and offers the prefilled fallback', async ({ page }, testInfo) => {
    await bootApp(page, { feedbackOutcome: 'failure' });
    await page.getByRole('button', { name: 'Home menu' }).click();
    await page.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.locator('textarea').fill('Pane will not start after the update.');
    await dialog.getByRole('button', { name: 'Submit feedback' }).click();

    await expect(dialog.getByRole('alert')).toContainText('GitHub CLI is not authenticated.');
    await expect(dialog.locator('textarea')).toHaveValue('Pane will not start after the update.');
    await shot(page, testInfo, '06-dialog-fallback');

    await dialog.getByRole('button', { name: 'Open pre-filled issue in browser' }).click();
    const opened = await readOpenedUrls(page);
    expect(opened).toEqual(['https://github.com/greenfield-inc/Pane/issues/new?title=Prefilled']);
    // Handing off to the browser must not surface a second error over the first one.
    await expect(dialog.getByRole('alert')).toContainText('GitHub CLI is not authenticated.');
  });

  test('settings General exposes the feedback entry and opens the same dialog', async ({ page }, testInfo) => {
    await bootApp(page);
    await collapseSidebar(page);
    await shot(page, testInfo, '05-compact-sidebar');

    await openSettings(page);
    const settingsDialog = page.getByTestId('settings-page');
    await settingsDialog.getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: 'General', exact: true }).click();

    const entry = settingsDialog.getByRole('button', { name: 'Send Feedback' });
    await expect(entry).toBeVisible();
    await expect(settingsDialog.getByText('Report a bug, request a feature, or share general feedback.')).toBeVisible();
    await shot(page, testInfo, '07-settings-feedback-entry');

    await entry.click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await expect(dialog).toBeVisible();
    // The settings screen remains beneath the feedback dialog.
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await shot(page, testInfo, '08-settings-dialog-open');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Settings survives the stacked dialog: focus returns to its own button and the
    // shell stays interactive once the overlay layer unmounts.
    await expect(settingsDialog).toBeVisible();
    await expect(entry).toBeFocused();
    await settingsDialog.getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(settingsDialog.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
    await shot(page, testInfo, '09-settings-after-close');
  });
});
