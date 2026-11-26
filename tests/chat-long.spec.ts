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

/** Offsets of `text` from the viewport's top on every frame for `ms`, while `act` runs. */
async function sampleDuring(page: Page, text: string, ms: number, act: () => Promise<void>) {
  const sampling = page.evaluate(async ({ text: wanted, ms: span }) => {
    const seen: Array<number | null> = [];
    const started = performance.now();
    while (performance.now() - started < span) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const element = document.querySelector<HTMLElement>('[aria-label="Conversation messages"]')!;
      const message = [...element.querySelectorAll<HTMLElement>('[data-pane-part="chat-message"]')].find(node => node.textContent?.startsWith(wanted));
      seen.push(message ? Math.round(message.getBoundingClientRect().top - element.getBoundingClientRect().top) : null);
    }
    return seen;
  }, { text, ms });
  await act();
  return sampling;
}

for (const [name, query, label] of [
  ['', 'turns=300&window=200', /^Earlier messages \(300\)/],
  // 650 + a page of 100 is over the viewer's 700, so the newest end trims and Newer messages appears.
  [' while the newest end trims', 'turns=400&window=650', /^Earlier messages \(50\)/],
] as const) {
  test(`Earlier messages pages in above the reader and keeps their place${name}`, async ({ page }) => {
    await open(page, query);
    await expect(page.getByText('Reply 399:', { exact: false }).or(reply(page, 299))).toBeInViewport();
    const earlier = page.getByRole('button', { name: /^Earlier messages/ });
    await expect(async () => {
      await viewport(page).evaluate(element => { element.scrollTop = 0; });
      await expect(earlier).toBeInViewport({ timeout: 200 });
    }).toPass();
    await page.waitForTimeout(100);
    const before = await place(page);
    expect(before?.text).toBeTruthy();
    const offsets = await sampleDuring(page, before!.text!, 800, async () => {
      await earlier.click();
      await expect(page.getByRole('button', { name: label })).toBeAttached();
    });
    // Every frame through the prepend (and the trim) shows the reader's message where it was.
    for (const offset of offsets.filter(value => value !== null)) expect(Math.abs(offset! - before!.offset)).toBeLessThanOrEqual(2);
    expect(offsets.at(-1)).not.toBeNull();
  });
}

test('a chat left on a page of older messages comes back at its live end, following it', async ({ page }) => {
  await open(page, 'turns=400&window=650');
  const earlier = page.getByRole('button', { name: /^Earlier messages/ });
  await expect(async () => {
    await viewport(page).evaluate(element => { element.scrollTop = 0; });
    await expect(earlier).toBeInViewport({ timeout: 200 });
  }).toPass();
  await earlier.click();
  await expect(page.getByRole('button', { name: 'Newer messages' })).toBeAttached();
  // The viewer drops an older page when the chat closes, so its place there can't come back.
  await page.evaluate(() => window.qaSwitchAway());
  await expect(page.getByText('Reply 399:', { exact: false })).toBeInViewport();
  await page.evaluate(() => window.qaStream('A new reply after coming back.', true));
  await expect(page.getByText('A new reply after coming back.')).toBeInViewport();
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

test('a link in a reply keeps focus when the reply writes its next block', async ({ page }) => {
  await open(page, 'turns=3&working=1');
  await page.evaluate(() => window.qaStream('\n\nSee [the guide](https://example.com/guide) for the rest.'));
  const link = page.getByRole('link', { name: 'the guide' });
  await link.focus();
  // Marked on the element itself, so a remount (a new element) would lose it.
  await link.evaluate(element => element.setAttribute('data-qa-same', ''));
  // The link's block is no longer the one being written, so it becomes cacheable.
  await page.evaluate(() => window.qaStream('\n\nA new paragraph after the link.'));
  await expect(page.getByText('A new paragraph after the link.')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-qa-same') ?? false)).toBe(true);
});

test('an opened turn stays open, and a focused control stays rendered, when the turn leaves the window', async ({ page }) => {
  await open(page, 'turns=300');
  await expect(reply(page, 299)).toBeInViewport();
  // Turn 295 read a file, so its activity folds into one row.
  const turn = page.locator('.chat-turn-row[data-turn-key="turn:user:t295"]');
  const fold = turn.locator('button.chat-fold');
  await fold.scrollIntoViewIfNeeded();
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(fold).toBeFocused();
  // Scrolled far away (not by the keyboard), the focused row stays rendered and focused.
  await viewport(page).evaluate(element => { element.scrollTop = 0; });
  await expect(reply(page, 0)).toBeInViewport();
  await expect(fold).toBeFocused();
  // Once focus leaves it, it unmounts with the window, and comes back open.
  await page.getByRole('textbox', { name: /^Message/ }).focus();
  await expect(turn).toHaveCount(0);
  await viewport(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(async () => {
    if (!await turn.count()) await viewport(page).evaluate(element => { element.scrollTop -= 300; });
    await expect(fold).toHaveAttribute('aria-expanded', 'true', { timeout: 200 });
  }).toPass();
});

