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

  test('inside the window, Escape leaves a card waiting and the next card opens', async ({ page }) => {
    await page.route('**/machine-health-cards.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
    await page.goto('/machine-health-cards.html?dialog=1');
    await expect(page.getByRole('dialog', { name: 'Disk almost full' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Memory is tight' })).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.qaAnswers)).toEqual(['Not now']);
  });

  test('screenshots of every card, light and dark', async ({ page }) => {
    test.skip(!shots, 'Set MACHINE_HEALTH_SHOTS to a folder to capture screenshots.');
    for (const kind of ['memory', 'disk', 'leak', 'finished', 'leftovers', 'memory&remote=1']) {
      for (const theme of ['light', 'dark']) {
        await open(page, `kind=${kind}&theme=${theme}`);
        await page.locator('#root > div > div').screenshot({ path: `${shots}/card-${kind.replace('&remote=1', '-remote')}-${theme}.png` });
      }
    }
  });
});
