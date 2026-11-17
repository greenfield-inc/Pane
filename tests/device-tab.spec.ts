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

test('a turned device fits its frame uncropped, and a tap lands where it is clicked', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane&shape=landscape');
  const screen = page.getByTestId('device-screen');
  await expect.poll(async () => { const box = await screen.boundingBox(); return box ? box.width / box.height : 0; }).toBeGreaterThan(2);
  const box = await screen.boundingBox();
  if (!box) throw new Error('No screen');
  // The Pay button's centre in the frame: x 0.825, y 0.85.
  await page.mouse.click(box.x + box.width * 0.825, box.y + box.height * 0.85);
  await expect.poll(() => page.evaluate(() => window.qaInputs.length)).toBe(2);
  const tap = await page.evaluate(() => window.qaInputs[0]);
  expect(tap.kind === 'touch' && Math.abs(tap.x - 0.825) < 0.02 && Math.abs(tap.y - 0.85) < 0.02).toBe(true);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await open(page, 'view=pane&shape=landscape&theme=dark');
    await expect.poll(async () => { const next = await page.getByTestId('device-screen').boundingBox(); return next ? next.width / next.height : 0; }).toBeGreaterThan(2);
    await page.waitForTimeout(300);
    await shoot(page, `device-tab-landscape-${theme}`);
  }
});

test('turning the device mid-session reshapes the phone to landscape', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane');
  const screen = page.getByTestId('device-screen');
  await expect.poll(async () => { const box = await screen.boundingBox(); return box ? box.height / box.width : 0; }).toBeGreaterThan(2);
  await page.evaluate(() => window.qaRotate());
  await expect.poll(async () => { const box = await screen.boundingBox(); return box ? box.width / box.height : 0; }).toBeGreaterThan(2);
  await expect(page.getByTestId('device-turn-mask')).toHaveClass(/opacity-0/);
});

test('Screenshot to chat adds the image to the chat composer, unsent, and offers Copy, Save and Mark up', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane');
  await page.getByRole('button', { name: 'Screenshot to chat' }).click();
  await expect(page.getByTestId('device-capture-card')).toContainText('Added to chat');
  expect(await page.evaluate(() => window.qaAttached)).toEqual([expect.stringMatching(/^chat:iPhone 17 Pro .*\.png$/)]);
  await shoot(page, 'device-tab-screenshot-light');
  await page.getByTestId('device-capture-card').getByRole('button', { name: 'Mark up' }).click();
  const canvas = page.getByTestId('device-markup-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('No canvas');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await shoot(page, 'device-tab-markup-light');
  await page.getByTestId('device-markup').getByRole('button', { name: 'Send to chat' }).click();
  await expect.poll(() => page.evaluate(() => window.qaAttached.length)).toBe(2);
});

test('for a terminal agent, Screenshot to chat types the PNG path at its prompt without sending', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane&agent=terminal');
  await page.getByRole('button', { name: 'Screenshot to chat' }).click();
  await expect(page.getByTestId('device-capture-card')).toContainText("prompt");
  expect(await page.evaluate(() => window.qaStaged)).toEqual(['agent:/tmp/pane/devices/screenshots/pane-1.png ']);
});

test('the rail turns the device, folds a foldable, and records with a running time', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane&fold=1');
  await expect(page.getByRole('button', { name: 'Half open' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Rotate' }).click();
  await page.getByRole('button', { name: 'Closed' }).click();
  await expect.poll(() => page.evaluate(() => window.qaInputs)).toEqual([{ kind: 'rotate', orientation: 'landscape_left' }, { kind: 'fold', posture: 'closed' }]);
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByTestId('device-recording')).toHaveText('0:00');
  await expect(page.getByTestId('device-recording')).toHaveText('0:01', { timeout: 3000 });
  await shoot(page, 'device-tab-foldable-recording-light');
  await page.getByRole('button', { name: /Stop recording/ }).click();
  await expect(page.getByText(/Recording saved/)).toContainText('pane-1.mp4');
});

test('a phone with no fold shows no fold buttons', async ({ page }) => {
  await open(page, 'view=pane');
  await expect(page.getByRole('button', { name: 'Rotate' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Half open' })).toHaveCount(0);
});

test('Logs shows the app log, filters it, and sends the matching lines to chat', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await open(page, 'view=pane');
  await page.getByRole('button', { name: 'Logs' }).click();
  await expect(page.getByTestId('device-log-line')).toHaveCount(3);
  await page.getByTestId('device-logs-filter').fill('cache');
  await expect(page.getByTestId('device-log-line')).toHaveCount(1);
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await open(page, 'view=pane&theme=dark&fold=1&driver=agent');
      await page.getByRole('button', { name: 'Logs' }).click();
      await expect(page.getByTestId('device-log-line')).toHaveCount(3);
    }
    await shoot(page, `device-tab-logs-${theme}`);
  }
  await page.getByTestId('device-logs').getByRole('button', { name: 'To chat' }).click();
  await expect.poll(() => page.evaluate(() => window.qaAttached)).toEqual([expect.stringMatching(/^chat:.*log.*\.txt$/)]);
});

test('while the agent drives, the chip names it and Take over hands the device to the person', async ({ page }) => {
  await open(page, 'view=pane&driver=agent');
  await expect(page.getByTestId('device-driver')).toContainText('is driving');
  await page.getByTestId('device-driver').getByRole('button', { name: 'Take over' }).click();
  await open(page, 'view=pane&driver=person');
  await expect(page.getByTestId('device-driver')).toContainText("You're driving");
  await page.getByTestId('device-driver').getByRole('button', { name: /Hand to/ }).click();
  await expect.poll(() => page.evaluate(() => window.qaPower)).toEqual(['driver:agent']);
});

test('at phone width the rail lies under the phone as a bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['light', 'dark']) {
    await open(page, `view=phone&driver=person${theme === 'dark' ? '&theme=dark' : ''}`);
    const rail = await page.getByTestId('device-rail').boundingBox();
    const screen = await page.getByTestId('device-screen').boundingBox();
    if (!rail || !screen) throw new Error('No rail or screen');
    expect(rail.width).toBeGreaterThan(rail.height);
    expect(rail.y).toBeGreaterThan(screen.y + screen.height);
    await shoot(page, `device-tab-phone-${theme}`);
  }
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
