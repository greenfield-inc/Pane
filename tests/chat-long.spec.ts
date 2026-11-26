import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// T-87 Phase 2: a long chat renders only the turns near the screen. Everything a reader does
// with the whole conversation still works: copy, paging, following the live end, and
// coming back to a chat where it was left. Find in a long chat is in find-in-tab.spec.ts.
const fixture = path.resolve('tests/fixtures/chat-tab-composer.tsx');

async function open(page: Page, query: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/chat-tab-composer.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/chat-tab-composer.html?labels=opus&width=${test.info().project.name === 'phone' ? 360 : 720}&${query}`);
}

const viewport = (page: Page) => page.getByRole('region', { name: 'Conversation messages' });
const rows = (page: Page) => page.locator('.chat-turn-row');
const reply = (page: Page, turn: number) => page.getByText(`Reply ${turn}:`, { exact: false });

/** The first reply whose top is on screen, and its offset from the viewport's top. */
const place = (page: Page) => viewport(page).evaluate(element => {
  const top = element.getBoundingClientRect().top;
  const shown = [...element.querySelectorAll<HTMLElement>('[data-pane-part="chat-message"]')].find(message => message.getBoundingClientRect().top >= top);
  return shown ? { text: shown.textContent?.slice(0, 24), offset: Math.round(shown.getBoundingClientRect().top - top) } : null;
});

/** Scrolls up by `pixels` in steps, letting the window render each step. */
async function scrollUp(page: Page, pixels: number) {
  for (let left = pixels; left > 0; left -= 400) {
    await viewport(page).evaluate((element, step) => { element.scrollTop -= step; }, Math.min(400, left));
    await page.waitForTimeout(30);
  }
}

test('a long chat opens at its newest turn and renders only the turns near the screen', async ({ page }) => {
  await open(page, 'turns=300');
  await expect(reply(page, 299)).toBeInViewport();
  expect(await rows(page).count()).toBeLessThan(40);
  await expect(reply(page, 0)).toHaveCount(0);
  // Scrolling to the top renders the oldest turns, and lets go of the newest.
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(reply(page, 0)).toBeInViewport();
  await expect(reply(page, 299)).toHaveCount(0);
  expect(await rows(page).count()).toBeLessThan(40);
});

test('copy conversation copies every turn, not only the rendered ones', async ({ page }) => {
  await open(page, 'turns=300&window=200');
  await expect(reply(page, 299)).toBeInViewport();
  const copy = page.getByRole('button', { name: 'Copy conversation' });
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'copied');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  for (const turn of [0, 150, 299]) expect(text).toContain(`Reply ${turn}:`);
});

test('Earlier messages pages in above the reader and keeps their place', async ({ page }) => {
  await open(page, 'turns=300&window=200');
  await expect(reply(page, 299)).toBeInViewport();
  const earlier = page.getByRole('button', { name: /^Earlier messages/ });
  while (!await earlier.isVisible()) await scrollUp(page, 2000);
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(100);
  const before = await place(page);
  expect(before).not.toBeNull();
  await earlier.click();
  await expect(page.getByRole('button', { name: /^Earlier messages \(300\)/ })).toBeAttached();
  await page.waitForTimeout(200);
  const after = await place(page);
  expect(after?.text).toBe(before?.text);
  expect(Math.abs((after?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThanOrEqual(2);
});

test('a reply streaming at the live end stays in view', async ({ page }) => {
  await open(page, 'turns=300');
  await expect(reply(page, 299)).toBeInViewport();
  await page.evaluate(() => window.qaStream('Streaming the newest reply.', true));
  for (let chunk = 0; chunk < 20; chunk++) {
    await page.evaluate(n => window.qaStream(`\n\nParagraph ${n} of the stream, long enough to add a line or two to the reply as it writes.`), chunk);
    await page.waitForTimeout(40);
  }
  await expect(page.getByText('Paragraph 19 of the stream')).toBeInViewport();
  const gap = await viewport(page).evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
  expect(gap).toBeLessThanOrEqual(2);
});

test('a chat comes back where it was left, from its first frame', async ({ page }) => {
  await open(page, 'turns=300');
  await expect(reply(page, 299)).toBeInViewport();
  await scrollUp(page, 6000);
  await page.waitForTimeout(100);
  const before = await place(page);
  expect(before).not.toBeNull();
  // Every frame from the remount until it settles shows the same reply at the same place.
  const frames = await page.evaluate(async () => {
    const seen: Array<{ text?: string; offset: number } | null> = [];
    void window.qaSwitchAway();
    const started = performance.now();
    while (performance.now() - started < 800) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const element = document.querySelector<HTMLElement>('[aria-label="Conversation messages"]');
      if (!element) continue;
      const top = element.getBoundingClientRect().top;
      const shown = [...element.querySelectorAll<HTMLElement>('[data-pane-part="chat-message"]')].find(message => message.getBoundingClientRect().top >= top);
      seen.push(shown ? { text: shown.textContent?.slice(0, 24), offset: Math.round(shown.getBoundingClientRect().top - top) } : null);
    }
    return seen;
  });
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame?.text).toBe(before?.text);
    expect(Math.abs((frame?.offset ?? 0) - (before?.offset ?? 0))).toBeLessThanOrEqual(2);
  }
  // And a chat left at its live end comes back there.
  await viewport(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.qaSwitchAway());
  await expect(reply(page, 299)).toBeInViewport();
});
