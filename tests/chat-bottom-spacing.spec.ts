import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-365: the bottom of a chat is tight. The Working row sits about a message gap below your latest
// message and a small gap above the status line, and the latest message stays fully above the composer.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');
const shots = process.env.PANE_VERIFY_DIR;

async function open(page: Page, query: string) {
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?${query}`);
  await expect(page.getByRole('toolbar', { name: 'Chat status' })).toBeVisible();
}
const width = () => test.info().project.name === 'phone' ? 360 : 960;
type Box = { top: number; bottom: number };
const box = (page: Page, selector: string) => page.locator(selector).last().evaluate((element): Box => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
});
/** The last thing in the conversation, scrolled to the bottom. */
async function lastRow(page: Page) {
  await page.locator('.chat-viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
  return box(page, '.chat-column > :last-child');
}

test('the Working row sits a small gap above the status line, and your message a message gap above it', async ({ page }) => {
  await open(page, `status=1&working=1&conversation=1&pending=1&long=1&width=${width()}`);
  await lastRow(page);
  const working = await box(page, '.chat-fold-row[data-running=true]');
  const status = await box(page, '.chat-statusline');
  const user = await box(page, '.chat-turn:last-child .chat-user-row');
  expect(status.top - working.bottom, 'Working row to status line').toBeLessThanOrEqual(20);
  expect(working.top - user.bottom, 'your message to the Working row').toBeLessThanOrEqual(24);
});

for (const query of ['working=1', 'working=1&queue=2', 'permission=1', '']) {
  test(`the latest message stays fully above the composer (${query || 'idle'})`, async ({ page }) => {
    await open(page, `status=1&conversation=1&long=1&${query}&width=${width()}`);
    const last = await lastRow(page);
    const viewport = await box(page, '.chat-viewport');
    const footer = await box(page, '.chat-composer-footer');
    expect(last.bottom).toBeLessThanOrEqual(viewport.bottom);
    expect(viewport.bottom).toBeLessThanOrEqual(footer.top + 0.5);
    // Not a large empty band either.
    expect(footer.top - last.bottom, 'last row to the footer').toBeLessThanOrEqual(20);
  });
}

if (shots) for (const theme of ['light', 'dark']) {
  for (const [name, query] of [['working', 'working=1&pending=1'], ['idle', ''], ['queue', 'working=1&queue=2'], ['approval', 'permission=1']] as const) {
    test(`screenshots: the bottom of a chat, ${name} (${theme})`, async ({ page }) => {
      const project = test.info().project.name;
      await open(page, `status=1&conversation=1&long=1&${query}&width=${width()}&theme=${theme}`);
      await lastRow(page);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${shots}/bottom-${name}-${theme}-${project}.png` });
    });
  }
}
