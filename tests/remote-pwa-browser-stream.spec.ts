import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

// The web app draws a browser tab as frames from the host's one page and sends input back
// (docs/BROWSER_AGENTS.md, Streaming to other screens).

test('a browser tab streams from the host: frames arrive, a click and typing land, and Take over works', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const host = await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Sign up', url: 'http://localhost:5173/signup' }],
    activePanelIndex: 2,
    browserStream: { driver: { by: 'agent', agent: 'Claude Code' } },
  });
  const stream = page.getByTestId('browser-stream');
  await expect(stream).toBeVisible();
  // The first frame is drawn and the host's address shows.
  await expect(stream.getByText(/Loading the page/)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('http://localhost:5173/signup');
  await expect(page.getByText('on MacBook Pro')).toBeVisible();
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
  await expect.poll(sent).toContain('"kind":"text","text":"h');
  await expect.poll(sent).toContain('"kind":"key","key":"Enter"');
  // The click landed at the middle of the page: 400 of its 800 CSS pixels across.
  expect(sent()).toMatch(/"action":"down","x":400(\.\d+)?,"y":300/);
});

test('a host on an older Pane gets the page\'s own copy, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page, { browserPanels: [{ title: 'Browser', url: '' }], activePanelIndex: 2 });
  await expect(page.getByText('MacBook Pro is on an older Pane. Showing your own copy.')).toBeVisible();
});
