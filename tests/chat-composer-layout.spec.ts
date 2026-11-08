import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-120: in a narrow column (Autopilot's, a chat tab's, the PWA's) the composer row never
// overflows: + and send stay inside the box, and the model label truncates instead.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');

async function open(page: Page, query: string, ready = 'Send message') {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('button', { name: ready })).toBeVisible();
}

async function box(page: Page, name: string | RegExp) {
  const found = await page.getByRole('button', { name }).boundingBox();
  if (!found) throw new Error(`${name} is not on screen`);
  return found;
}

/** The visible controls on the composer's row, as boxes. */
async function rowControls(page: Page) {
  return page.locator('.chat-composer-actions').evaluate(row => [...row.querySelectorAll('button, [role=img]')].flatMap(element => {
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height && getComputedStyle(element).visibility !== 'hidden'
      ? [{ name: element.getAttribute('aria-label') ?? element.textContent ?? '', x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : [];
  }));
}

for (const width of [300, 360, 440, 520, 640]) for (const labels of ['default', 'opus', 'long']) {
  test(`the composer row stays inside a ${width}px column (${labels} labels)`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, `width=${width}&labels=${labels}`);
    const composer = await page.locator('.chat-composer').boundingBox();
    if (!composer) throw new Error('No composer');
    for (const name of ['Send message', 'Attach image']) {
      const control = await box(page, name);
      expect(control.x, `${name} starts inside`).toBeGreaterThanOrEqual(composer.x);
      expect(control.x + control.width, `${name} ends inside`).toBeLessThanOrEqual(composer.x + composer.width);
      expect(control.y + control.height, `${name} is on the composer's row`).toBeLessThanOrEqual(composer.y + composer.height);
    }
    // Model and mode sit in the status bar above the composer (D-254), inside the column.
    const column = await page.getByTestId('column').boundingBox();
    if (!column) throw new Error('No column');
    for (const name of [/Model and options/, /Customize|Choose what the status bar shows/]) {
      const control = await box(page, name);
      expect(control.x + control.width, `${name} ends inside the column`).toBeLessThanOrEqual(column.x + column.width);
      expect(control.y + control.height, `${name} is above the composer`).toBeLessThanOrEqual(composer.y);
    }
    const send = await box(page, 'Send message');
    expect(send.width, 'send never shrinks').toBeGreaterThanOrEqual(28);
    // One row: attach and send share a line.
    const attach = await box(page, 'Attach image');
    expect(Math.abs((attach.y + attach.height / 2) - (send.y + send.height / 2))).toBeLessThan(4);
  });
}

// QA of D-120: a window can be dragged down to ~100px. The row then keeps send and drops the rest,
// instead of overlapping controls.
// A working agent adds Queue and Stop to the row (F-18).
for (const working of [false, true]) for (const width of [120, 150, 170, 200, 240, 260, 280, 300, 360]) {
  test(`no two controls overlap in a ${width}px column${working ? ' while the agent works' : ''}, and ${working ? 'Stop' : 'send'} is always there`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await open(page, `width=${width}&labels=long${working ? '&working=1' : ''}`, working ? 'Stop agent turn' : 'Send message');
    const composer = await page.locator('.chat-composer').boundingBox();
    if (!composer) throw new Error('No composer');
    const controls = await rowControls(page);
    expect(controls.map(control => control.name)).toContain(working ? 'Stop agent turn' : 'Send message');
    for (const control of controls) {
      expect(control.x, `${control.name} starts inside`).toBeGreaterThanOrEqual(composer.x);
      expect(control.x + control.width, `${control.name} ends inside`).toBeLessThanOrEqual(composer.x + composer.width + 0.5);
      expect(control.width, `${control.name} is not squeezed`).toBeGreaterThanOrEqual(20);
    }
    for (const [index, a] of controls.entries()) for (const b of controls.slice(index + 1)) {
      expect(a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5, `${a.name} and ${b.name} do not overlap`).toBe(true);
    }
  });
}

test('Codex Full access stays marked: amber in the bar, or on the composer row when the bar hides the mode (F-17)', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'width=390&labels=opus&mode=agent-full-access');
  await expect(page.getByRole('button', { name: /Mode: Full access/ })).toHaveAttribute('data-tone', 'warning');
  await expect(page.getByRole('img', { name: 'Permissions: Full access' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose what the status bar shows' }).click();
  await page.getByRole('checkbox', { name: 'Permission mode' }).uncheck();
  await expect(page.getByRole('img', { name: 'Permissions: Full access' })).toBeVisible();
});

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
  const clipped = await page.locator('.chat-status-item .chat-chip-label, .chat-status-item .chat-phone-model-name').first().evaluate(label => label.scrollWidth > label.clientWidth && getComputedStyle(label).textOverflow === 'ellipsis');
  expect(clipped).toBe(true);
});

test('a wide column keeps "Opus 5.5 · Medium"', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await open(page, 'width=640&labels=opus');
  await expect(page.getByRole('button', { name: /Model and options/ })).toHaveAccessibleName('Model and options: Opus 5.5 · Medium');
});
