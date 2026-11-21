import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// Machine health cards (Notify cards Pane raises itself): each kind's body, and what its buttons send.
const fixture = path.resolve('tests/fixtures/machine-health-cards.tsx');
const shots = process.env.MACHINE_HEALTH_SHOTS;

async function open(page: Page, query: string) {
  await page.route('**/machine-health-cards.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`/machine-health-cards.html?${query}`);
}

test.describe('Machine health cards', () => {
  test('memory: Pause idle Panes answers the card; Ask an agent stays on this screen', async ({ page }) => {
    await open(page, 'kind=memory');
    await expect(page.getByText('Using the most memory')).toBeVisible();
    await expect(page.getByText('Stops agents and terminals in 14 Panes. Opening a Pane resumes it. Frees about 2.2 GB.')).toBeVisible();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: /Ask an agent/ }).click();
    await page.getByRole('button', { name: 'Not now' }).click();
    expect(await page.evaluate(() => [window.qaAnswers, window.qaAsked])).toEqual([['Pause idle Panes', 'Not now'], 1]);
  });

  test('a linked machine card names the machine and says the agent works there', async ({ page }) => {
    await open(page, 'kind=memory&remote=1');
    await expect(page.getByRole('heading', { name: 'build-box: memory is tight' })).toBeVisible();
    await expect(page.getByText('Using the most memory on build-box')).toBeVisible();
    await expect(page.getByText('Opens a Session with this list; the agent works on build-box.')).toBeVisible();
  });

  test('disk: every item Clean up deletes is listed, with what it frees', async ({ page }) => {
    await open(page, 'kind=disk');
    for (const label of ['u-2.4.212', 'sessions.db.pre-panel-buffers.bak', 'qa1344.noindex', 'qa1351.noindex', 'u-2.4.208']) await expect(page.getByText(label, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clean up · 25 GB' }).click();
    expect(await page.evaluate(() => window.qaAnswers)).toEqual(['Clean up']);
  });

  test('leak: Restart it, Stop it and Ignore for this process each answer the card', async ({ page }) => {
    await open(page, 'kind=leak');
    for (const name of ['Stop it', 'Ignore for this process', 'Restart it']) await page.getByRole('button', { name, exact: true }).click();
    expect(await page.evaluate(() => window.qaAnswers)).toEqual(['Stop it', 'Ignore for this process', 'Restart it']);
  });

  test('finished: every Pane is listed, protected ones with the reason they are skipped', async ({ page }) => {
    await open(page, 'kind=finished');
    await expect(page.getByText('It is pinned.')).toBeVisible();
    await expect(page.getByText('glassly-port', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Archive 6 Panes · 17 GB' }).click();
    expect(await page.evaluate(() => window.qaAnswers)).toEqual(['Archive 6 Panes']);
  });

  test('leftovers: each process shows what it is, and Stop them or Keep them answers the card', async ({ page }) => {
    await open(page, 'kind=leftovers');
    await expect(page.getByText('postgres -D /Users/me/pg/data -p 5433')).toBeVisible();
    await expect(page.getByText('pid 6031')).toBeVisible();
    await page.getByRole('button', { name: 'Keep them' }).click();
    await page.getByRole('button', { name: 'Stop them' }).click();
    expect(await page.evaluate(() => window.qaAnswers)).toEqual(['Keep them', 'Stop them']);
  });

  test('inside the window, warnings show as bottom-left popups that hide on their own and never take focus', async ({ page }) => {
    await open(page, 'popup=warning');
    await page.getByLabel('Composer').focus();
    const popups = page.getByTestId('health-popup');
    await expect(popups).toHaveCount(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Disk almost full' })).toHaveAttribute('data-level', 'warning');
    const box = await page.getByTestId('health-popups').boundingBox();
    expect(box && box.x < 40 && box.y + box.height > 900 - 40).toBe(true);
    await expect(page.getByLabel('Composer')).toBeFocused();
    // Hovering the stack holds every popup in it; leaving lets them hide after Notify's update time.
    await page.getByRole('status', { name: 'Memory is tight' }).hover();
    await page.waitForTimeout(3000);
    await expect(popups).toHaveCount(2);
    await page.mouse.move(700, 100);
    await expect(popups).toHaveCount(0, { timeout: 4000 });
    expect(await page.evaluate(() => window.qaCommands)).toEqual([]);
  });

  test('a critical card is a red popup that stays until dismissed or resolved', async ({ page }) => {
    await open(page, 'popup=critical');
    const critical = page.getByRole('alert', { name: 'Disk is almost full' });
    await expect(critical).toHaveAttribute('data-level', 'critical');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The warning hides on its own; the critical card is still there after it.
    await expect(page.getByRole('status', { name: 'Memory is tight' })).toHaveCount(0, { timeout: 4000 });
    await page.waitForTimeout(500);
    await expect(critical).toBeVisible();
    await critical.getByRole('button', { name: 'Dismiss' }).click();
    expect(await page.evaluate(() => window.qaCommands)).toEqual([{ type: 'dismiss', id: 'd1' }]);
    await page.evaluate(() => window.qaResolve('d1'));
    await expect(critical).toHaveCount(0);
  });

  test('Open Resources on a popup opens the Resources view', async ({ page }) => {
    await open(page, 'popup=critical');
    await page.getByRole('alert', { name: 'Disk is almost full' }).getByRole('button', { name: 'Open Resources' }).click();
    await expect.poll(() => page.evaluate(() => window.qaView())).toBe('resources');
  });

  test('screenshots of every card, light and dark', async ({ page }) => {
    test.skip(!shots, 'Set MACHINE_HEALTH_SHOTS to a folder to capture screenshots.');
    for (const kind of ['memory', 'disk', 'leak', 'finished', 'leftovers', 'memory&remote=1']) {
      for (const theme of ['light', 'dark']) {
        await open(page, `kind=${kind}&theme=${theme}`);
        await page.locator('#root > div > div').screenshot({ path: `${shots}/card-${kind.replace('&remote=1', '-remote')}-${theme}.png` });
      }
    }
    for (const level of ['warning', 'critical']) {
      for (const theme of ['light', 'dark']) {
        await open(page, `popup=${level}&theme=${theme}`);
        await page.getByTestId('health-popup').first().waitFor();
        await page.getByTestId('health-popups').hover();
        await page.screenshot({ path: `${shots}/popup-${level}-${theme}.png`, clip: { x: 0, y: 500, width: 460, height: 400 } });
      }
    }
  });
});
