import { expect, test, type Locator } from '@playwright/test';
import { dropRemoteConnection, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// Guards the no-motion decision in the Remote Pane PWA. Sheets, drawers, scrims,
// popovers, key presses and the joystick all land on the frame the input fires,
// with or without reduced motion. The only animation that survives is the one
// that carries information — the status ring while a host is being reached.

const PHONE = { width: 390, height: 844 };
const BROWSER_WINDOW = { width: 1100, height: 800 };

const readMotion = (element: Locator) => element.evaluate((node) => {
  const style = getComputedStyle(node);
  return {
    animation: style.animationName,
    transition: style.transitionDuration,
    transform: style.transform,
  };
});

test.describe('remote pwa motion', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('the create sheet and its scrim appear without animating', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: 'Open remote panes' }).tap();
    await page.getByRole('button', { name: /New pane in/ }).tap();

    const sheet = page.locator('.pane-sheet');
    await expect(sheet).toBeVisible();
    expect((await readMotion(sheet)).animation).toBe('none');

    const scrim = page.locator('.pane-scrim');
    await expect(scrim).toBeVisible();
    expect((await readMotion(scrim)).animation).toBe('none');
  });

  test('the pane drawer appears without animating', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: 'Open remote panes' }).tap();

    const drawer = page.locator('.pane-drawer');
    await expect(drawer).toBeVisible();
    expect((await readMotion(drawer)).animation).toBe('none');
  });

  test('popovers appear without animating', async ({ page }) => {
    await openConnectedRemotePwa(page);

    await page.getByRole('button', { name: 'Add tool' }).tap();
    const menu = page.getByRole('menu', { name: 'Add tool' });
    await expect(menu).toBeVisible();
    expect((await readMotion(menu)).animation).toBe('none');

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Shortcuts' }).tap();
    const sheet = page.locator('.animate-dropdown-enter-up');
    await expect(sheet).toBeVisible();
    expect((await readMotion(sheet)).animation).toBe('none');
  });

  test('the terminal control keys do not scale or ease under a press', async ({ page }) => {
    await openConnectedRemotePwa(page);

    const enter = page.getByRole('button', { name: 'Enter', exact: true });
    await expect(enter).toBeVisible();
    const box = await enter.boundingBox();
    if (!box) throw new Error('Enter key has no box');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await page.waitForTimeout(150);
      const pressed = await readMotion(enter);
      expect(pressed.transition).toBe('0s');
      expect(pressed.transform).toBe('none');
    } finally {
      await page.mouse.up();
    }
  });

  test('the panel tab does not cross-fade the switch', async ({ page }) => {
    await openConnectedRemotePwa(page);

    // The selected tab is the receipt for the switch, so it has to be right on
    // the frame it was tapped.
    const tab = page.getByRole('tab', { name: 'shell' });
    await expect(tab).toBeVisible();
    expect((await readMotion(tab)).transition).toBe('0s');
  });

  test('the joystick never eases, dragged or released', async ({ page }) => {
    await openConnectedRemotePwa(page);

    const track = page.locator('input[aria-label="Terminal scroll direction and speed"]');
    const thumb = page.locator('.pane-joystick-return');
    await expect(thumb).toBeVisible();

    const box = await track.boundingBox();
    if (!box) throw new Error('joystick has no box');
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;

    await page.mouse.move(centreX, centreY);
    await page.mouse.down();
    await page.mouse.move(centreX, centreY - 40);
    await page.waitForTimeout(50);
    expect((await readMotion(thumb)).transition).toBe('0s');

    await page.mouse.up();
    await page.waitForTimeout(50);
    expect((await readMotion(thumb)).transition).toBe('0s');
  });

  test('the status dot reaches only while it is actually reaching', async ({ page }) => {
    await openConnectedRemotePwa(page);
    // The header title is the open Pane; the host name leads the subtitle.
    await expect(page.getByText(/^MacBook Pro · /)).toBeVisible();

    // Connected is a settled state and stays still.
    await expect(page.locator('.pane-status-reaching')).toHaveCount(0);

    await dropRemoteConnection(page);

    // This is information, not decoration, so it is the one animation kept.
    const ring = page.locator('.pane-status-reaching');
    await expect(ring).toBeVisible();
    const motion = await ring.evaluate((element) => {
      const style = getComputedStyle(element);
      return { name: style.animationName, iterations: style.animationIterationCount };
    });
    expect(motion.name).toBe('pane-status-reaching');
    expect(motion.iterations).toBe('infinite');

    // And it stops once the host is found again, rather than becoming ambient.
    await restoreRemoteConnection(page);
    await expect(ring).toHaveCount(0);
  });

  test('reduced motion changes nothing because nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openConnectedRemotePwa(page);

    await page.getByRole('button', { name: 'Open remote panes' }).tap();
    const drawer = page.locator('.pane-drawer');
    await expect(drawer).toBeVisible();
    expect((await readMotion(drawer)).animation).toBe('none');
  });
});

test.describe('remote pwa motion in a browser window', () => {
  test.use({ viewport: BROWSER_WINDOW });

  test('the create sheet is a centred dialog above sm and does not animate', async ({ page }) => {
    await openConnectedRemotePwa(page);
    await page.getByRole('button', { name: /New pane in/ }).click();

    const sheet = page.locator('.pane-sheet');
    await expect(sheet).toBeVisible();
    expect((await readMotion(sheet)).animation).toBe('none');
  });
});
