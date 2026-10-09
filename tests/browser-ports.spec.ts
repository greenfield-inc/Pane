import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type { ListeningPortsSnapshot } from '../shared/types/listeningPorts';
import type {} from './fixtures/browser-ports';

const snapshot = (...ports: number[]): ListeningPortsSnapshot => ({
  host: 'devbox',
  ports: ports.map(port => ({ port, pid: port, process: 'node', group: 'other', kind: 'web' })),
});

async function openBrowserPanel(page: Page, url = ''): Promise<void> {
  const { outputFiles } = await build({
    entryPoints: [path.resolve('tests/fixtures/browser-ports.tsx')],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
  });
  // A real origin: the panel's stores read localStorage, which about:blank denies.
  await page.route('https://pane.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height: 100vh"></div>' }));
  await page.goto(`https://pane.test/#${new URLSearchParams({ url })}`);
  await page.addScriptTag({ content: outputFiles[0].text });
}

const answerPortsList = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.answerPortsList(value), ports);
const answerConnectionState = (page: Page, mode: 'local' | 'remote') => page.evaluate(value => window.portsTest.answerConnectionState(value), mode);
const emitPorts = (page: Page, ports: ListeningPortsSnapshot) => page.evaluate(value => window.portsTest.emitPorts(value), ports);

test('ports open only once this computer is known to be the host', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));

  await expect(page.getByText('5173')).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);

  await answerConnectionState(page, 'local');
  await expect(page.getByTitle('Open localhost:5173')).toBeVisible();
});

test('ports stay closed on a remote desktop', async ({ page }) => {
  await openBrowserPanel(page);
  await answerPortsList(page, snapshot(5173));
  await answerConnectionState(page, 'remote');

  await expect(page.getByText("These ports are on devbox, so this computer can't open them.")).toBeVisible();
  await expect(page.getByTitle('Open localhost:5173')).toHaveCount(0);
});

test('a late list reply does not replace a newer port change', async ({ page }) => {
  await openBrowserPanel(page);
  await answerConnectionState(page, 'local');
  await emitPorts(page, snapshot(5174));
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();

  await answerPortsList(page, snapshot(5173));
  // Give the late reply time to render if it were going to.
  await page.waitForTimeout(200);
  await expect(page.getByTitle('Open localhost:5174')).toBeVisible();
  await expect(page.getByText('5173')).toHaveCount(0);
});

test('the Ports menu works from the keyboard', async ({ page }) => {
  await openBrowserPanel(page, 'http://localhost:5173');
  await answerConnectionState(page, 'local');
  await answerPortsList(page, snapshot(5173, 5174));
  const trigger = page.getByRole('button', { name: /Ports/ });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('Open localhost:5173')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTitle('Open localhost:5174')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTitle('Open localhost:5174')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
