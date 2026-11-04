import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-120: in a narrow column (Autopilot's, a chat tab's, the PWA's) the composer row never
// overflows: + and send stay inside the box, and the model label truncates instead.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('button', { name: /Model and options/ })).toBeVisible();
}

async function box(page: Page, name: string | RegExp) {
  const found = await page.getByRole('button', { name }).boundingBox();
  if (!found) throw new Error(`${name} is not on screen`);
  return found;
}

for (const width of [300, 360, 440, 520, 640]) for (const labels of ['default', 'opus', 'long']) {
  test(`the composer row stays inside a ${width}px column (${labels} labels)`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, `width=${width}&labels=${labels}`);
    const composer = await page.locator('.chat-composer').boundingBox();
    if (!composer) throw new Error('No composer');
    for (const name of ['Send message', 'Attach image', /Model and options/]) {
      const control = await box(page, name);
      expect(control.x, `${name} starts inside`).toBeGreaterThanOrEqual(composer.x);
      expect(control.x + control.width, `${name} ends inside`).toBeLessThanOrEqual(composer.x + composer.width);
      expect(control.y + control.height, `${name} is on the composer's row`).toBeLessThanOrEqual(composer.y + composer.height);
    }
    const send = await box(page, 'Send message');
    expect(send.width, 'send never shrinks').toBeGreaterThanOrEqual(28);
    // One row: attach, model menu and send share a line.
    const attach = await box(page, 'Attach image');
    expect(Math.abs((attach.y + attach.height / 2) - (send.y + send.height / 2))).toBeLessThan(4);
  });
}

test('the model button drops "(recommended)" and a Default effort, keeping the full name in its menu', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'width=640&labels=default');
  const trigger = page.getByRole('button', { name: /Model and options/ });
  await expect(trigger).toHaveAccessibleName('Model and options: Default');
  await trigger.click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('default');
  await expect(page.getByRole('combobox', { name: 'Model' }).locator('option:checked')).toHaveText('Default (recommended)');
});

test('a long model name truncates with an ellipsis instead of growing the row', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'width=640&labels=long');
  const clipped = await page.locator('.chat-model .chat-chip-label, .chat-phone-model-name').first().evaluate(label => label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis');
  expect(clipped).toBe(true);
});

test('a wide column keeps "Opus 5.5 · Medium"', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'width=640&labels=opus');
  await expect(page.getByRole('button', { name: /Model and options/ })).toHaveAccessibleName('Model and options: Opus 5.5 · Medium');
});
