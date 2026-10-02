import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    __releaseRemoteSnapshot: () => void;
  }
}

for (const channel of ['connection', 'host'] as const) {
  test(`keeps the pushed ${channel} state when slow initial health discovery finishes`, async ({ page }, testInfo) => {
    await installElectronApiMock(page);
    await page.addInitScript(() => {
      const readHost = window.electronAPI.remoteDaemon.getHostState;
      const gate = new Promise<void>(resolve => { window.__releaseRemoteSnapshot = resolve; });
      window.electronAPI.remoteDaemon.getHostState = async () => {
        const snapshot = await readHost();
        await gate;
        return snapshot;
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remote inactive', exact: true })).toBeVisible();
    await page.evaluate(async channel => {
      if (channel === 'host') {
        await window.electronAPI.remoteDaemon.updateHostConfig({ enabled: true });
      } else {
        await window.electronAPI.remoteDaemon.upsertConnectionProfile({
          id: 'remote-fixture', label: 'Fixture remote', baseUrl: 'http://localhost:19999',
          token: 'synthetic', transport: 'http+sse',
        });
        await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'remote-fixture' });
      }
    }, channel);
    const label = channel === 'host' ? 'Remote host live' : 'Connected to remote runtime';
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    await page.evaluate(async () => {
      window.__releaseRemoteSnapshot();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${channel}-still-current.png`) });
  });
}
