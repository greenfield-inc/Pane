import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

// D-71 option 2: the device tab's states and the chat card, with a fake device (tests/fixtures/device-tab.tsx).
// DEVICE_SHOTS=<folder> also saves each view in light and dark, for the PR.
const fixture = path.resolve('tests/fixtures/device-tab.tsx');
const shots = process.env.DEVICE_SHOTS;

async function open(page: Page, query: string) {
  await page.route('**/device-tab.html*', route => route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;</script><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${fixture}"></script></body></html>` }));
  await page.goto(`/device-tab.html?${query}`);
}

async function shoot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
}

test('every state covers the screen inside the same phone, with the words for that state', async ({ page }) => {
  await page.setViewportSize({ width: 1640, height: 1200 });
  await open(page, 'view=states');
  await expect(page.getByTestId('state-Live').getByTestId('device-screen')).toBeVisible();
  await expect(page.getByTestId('state-Installing')).toContainText('Installing device tools');
  await expect(page.getByTestId('state-Booting')).toContainText('Booting iPhone 17 Pro');
  await expect(page.getByTestId('state-Off after idle')).toContainText('Shut down after 10 minutes idle');
  await expect(page.getByTestId('state-In use by another Pane')).toContainText('In use by onboarding-copy');
  await expect(page.getByTestId('state-Runs on a linked Mac')).toContainText("Runs on Studio MacBook Pro. This PC has no Xcode.");
  await expect(page.getByTestId('state-No Mac linked')).toContainText('iOS needs a Mac');
  await expect(page.getByTestId('state-Linked Mac offline')).toContainText("Studio MacBook Pro is offline");
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await open(page, 'view=states&theme=dark');
    await expect(page.getByTestId('state-Live').getByTestId('device-screen')).toBeVisible();
    await shoot(page, `device-tab-states-${theme}`);
  }
});

test('a tap on the screen reaches the device as a touch, and Take over and Boot reach the host', async ({ page }) => {
  await page.setViewportSize({ width: 1640, height: 1200 });
  await open(page, 'view=states');
  const screen = page.getByTestId('state-Live').getByTestId('device-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('No screen');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
  await expect.poll(() => page.evaluate(() => window.qaInputs.map(input => input.kind === 'touch' ? input.phase : input.kind))).toEqual(['begin', 'end']);
  const tap = await page.evaluate(() => window.qaInputs[0]);
  expect(tap.kind === 'touch' && tap.y > 0.85 && tap.y < 0.95).toBe(true);
  await page.getByTestId('state-In use by another Pane').getByRole('button', { name: 'Take over' }).click();
  await page.getByTestId('state-Off after idle').getByRole('button', { name: 'Boot' }).click();
  await expect.poll(() => page.evaluate(() => window.qaPower)).toEqual(['take-over', 'boot']);
});

test('a chat shows the device it opened as a live card that opens the device tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const theme of ['light', 'dark']) {
    await open(page, `view=pane&theme=${theme}`);
    const conversation = page.getByRole('region', { name: 'Conversation messages' });
    await expect(conversation.getByText('Opened', { exact: true })).toBeVisible();
    await expect(conversation.getByText('iPhone 17 Pro · iOS 27 · This Mac')).toBeVisible();
    await expect(page.getByTestId('chat-device-card')).toContainText('Live');
    await expect(page.getByTestId('chat-device-card').locator('img')).toBeVisible();
    await shoot(page, `chat-card-live-${theme}`);
  }
  await page.getByTestId('chat-device-card').click();
  await expect.poll(() => page.evaluate(() => window.qaPower)).toContain('open:device');
  for (const theme of ['light', 'dark']) {
    await open(page, `view=pane&theme=${theme}&mac=1`);
    await expect(page.getByTestId('device-screen')).toBeVisible();
    await shoot(page, `device-tab-mac-${theme}`);
  }
});
