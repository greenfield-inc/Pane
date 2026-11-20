import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa, setRemoteBrowserDriver } from './remotePwaMock';

// The web app shows a browser tab as its own copy, and while an agent acts on it, as frames from
// the host's page with input sent back (docs/BROWSER_AGENTS.md, On another screen).
const AGENT = { by: 'agent' as const, agent: 'Claude Code' };

test('a tab an agent acts on streams from the host: frames arrive, a click and typing land, and Take over works', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const host = await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Sign up', url: 'https://example.com/signup', driver: AGENT }],
    activePanelIndex: 2,
    browserStream: { driver: { by: 'agent', agent: 'Claude Code' } },
  });
  const stream = page.getByTestId('browser-stream');
  await expect(stream).toBeVisible();
  // The first frame is drawn and the host's address shows.
  await expect(stream.getByText(/Loading the page/)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.com/signup');
  await expect(page.getByTestId('browser-live-chip')).toContainText('Live from MacBook Pro');
  await expect.poll(() => host.browserStream?.calls.some(call => call.channel === 'browser:watch')).toBe(true);

  await expect(page.getByTestId('browser-driver-chip')).toContainText('Claude Code is driving');
  await page.getByTestId('browser-driver-chip').getByRole('button', { name: 'Take over' }).click();
  await expect.poll(() => host.browserStream?.calls.find(call => call.channel === 'browser:driver')?.args.slice(0, 2)).toEqual([expect.any(String), 'person']);
  await expect(page.getByTestId('browser-driver-chip')).toContainText("You're driving");

  const box = await stream.boundingBox();
  if (!box) throw new Error('The stream has no box.');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  const sent = () => JSON.stringify(host.browserStream?.calls.filter(call => call.channel === 'browser:input').map(call => call.args[2]));
  await expect.poll(sent).toContain('"kind":"mouse","action":"down"');
  // On a desktop-width screen each printable key goes as a key press, so the page sees keydown.
  await expect.poll(sent).toContain('"kind":"key","key":"h"');
  await expect.poll(sent).toContain('"kind":"key","key":"Enter"');
  // The click landed at the middle of the page: 400 of its 800 CSS pixels across.
  expect(sent()).toMatch(/"action":"down","x":400(\.\d+)?,"y":300/);
});

test('a web page no agent acts on shows the own copy', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const host = await openConnectedRemotePwa(page, { browserPanels: [{ title: 'Docs', url: 'https://example.com/docs' }], activePanelIndex: 2, browserStream: {} });
  // The own copy has the Ports list; the stream has none.
  await expect(page.getByRole('button', { name: 'Ports' })).toBeVisible();
  await expect(page.getByTestId('browser-stream')).toHaveCount(0);
  expect(host.browserStream?.calls.some(call => call.channel === 'browser:watch')).toBe(false);
});

test('a host dev server stays the own copy while an agent acts on it', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openConnectedRemotePwa(page, { browserPanels: [{ title: 'App', url: 'http://localhost:5173/', driver: AGENT }], activePanelIndex: 2, browserStream: {} });
  await expect(page.getByRole('button', { name: 'Ports' })).toBeVisible();
  await expect(page.getByTestId('browser-stream')).toHaveCount(0);
});

test('Back to my copy leaves the stream for the own copy', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Sign up', url: 'https://example.com/signup', driver: AGENT }],
    activePanelIndex: 2,
    browserStream: {},
  });
  await expect(page.getByTestId('browser-stream')).toBeVisible();
  await page.getByRole('button', { name: 'Back to my copy' }).click();
  await expect(page.getByTestId('browser-stream')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ports' })).toBeVisible();
});

test('a host on an older Pane gets the page\'s own copy, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page, { browserPanels: [{ title: 'Browser', url: 'https://example.com/', driver: AGENT }], activePanelIndex: 2 });
  await expect(page.getByText('MacBook Pro is on an older Pane. Showing your own copy.')).toBeVisible();
});

test('a tap on a phone takes control first, then clicks where it lands', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const host = await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Sign up', url: 'https://example.com/signup', driver: AGENT }],
    activePanelIndex: 2,
    browserStream: {},
  });
  const stream = page.getByTestId('browser-stream');
  await expect(stream.getByText(/Loading the page/)).toHaveCount(0);
  const box = await stream.boundingBox();
  if (!box) throw new Error('The stream has no box.');
  const inputs = () => host.browserStream?.calls.filter(call => call.channel === 'browser:input').map(call => call.args[2]) ?? [];
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  // The first tap only takes control: an empty batch, no click.
  await expect.poll(() => JSON.stringify(inputs())).toBe('[[]]');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  // Then a tap is a mouse press and release at the page point under the finger.
  await expect.poll(() => JSON.stringify(inputs().flat())).toMatch(/"kind":"mouse","action":"down","x":400(\.\d+)?,"y":300.*"kind":"mouse","action":"up"/);
  await context.close();
});

test('the stream goes back to the own copy 30 s after the agent stops, and the agent\'s next action streams again', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.clock.install();
  await openConnectedRemotePwa(page, { browserPanels: [{ title: 'Sign up', url: 'https://example.com/signup', driver: AGENT }], activePanelIndex: 2, browserStream: {} });
  await expect(page.getByTestId('browser-stream')).toBeVisible();
  await setRemoteBrowserDriver(page, undefined);
  await page.clock.fastForward(29_000);
  await expect(page.getByTestId('browser-stream')).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(page.getByTestId('browser-stream')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ports' })).toBeVisible();
  await setRemoteBrowserDriver(page, AGENT);
  await expect(page.getByTestId('browser-stream')).toBeVisible();
});

test('after a Take over the person\'s typing keeps the stream; 30 s after their last key it goes back, and Hand to works from the copy', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.clock.install();
  const host = await openConnectedRemotePwa(page, { browserPanels: [{ title: 'Log in', url: 'https://example.com/login', driver: AGENT }], activePanelIndex: 2, browserStream: { driver: AGENT } });
  const stream = page.getByTestId('browser-stream');
  await expect(stream.getByText(/Loading the page/)).toHaveCount(0);
  await page.getByTestId('browser-driver-chip').getByRole('button', { name: 'Take over' }).click();
  await setRemoteBrowserDriver(page, { by: 'person', agentWaiting: 'Claude Code' });
  const box = await stream.boundingBox();
  if (!box) throw new Error('The stream has no box.');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // A minute of typing a login, 20 s between keys: the stream stays.
  for (let index = 0; index < 3; index += 1) {
    await page.clock.fastForward(20_000);
    // Jumping the clock times out the frame read in flight; input waits until the host answers again.
    await expect(stream).toHaveAttribute('data-stream-stop', 'none');
    await page.keyboard.press('a');
    await expect(stream).toBeVisible();
  }
  await page.clock.fastForward(29_000);
  await expect(stream).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(stream).toHaveCount(0);
  // The own copy still lets the person hand the tab back.
  const handBack = page.getByTestId('browser-hand-back');
  await expect(handBack).toContainText("You're driving · Claude Code is waiting");
  await handBack.getByRole('button', { name: 'Hand to Claude Code' }).click();
  await expect.poll(() => host.browserStream?.calls.filter(call => call.channel === 'browser:driver').map(call => call.args[1])).toEqual(['person', 'agent']);
});
