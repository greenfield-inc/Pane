import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

test('malformed panel events leave the terminal usable and valid updates still apply', async ({ page }, testInfo) => {
  await openConnectedRemotePwa(page);
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  await page.evaluate(() => window.__paneRemoteEmit?.('panel:updated', [{ id: 'anim-panel-0', sessionId: 'anim-remote-0', type: 'terminal', title: 'Broken panel' }]));
  await expect(page.getByText(/The remote host sent invalid panel data\./)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('invalid-event-warning.png') });
  await page.evaluate(() => window.__paneRemoteEmit?.('panel:updated', [{
    id: 'anim-panel-0', sessionId: 'anim-remote-0', type: 'terminal', title: 'Renamed shell', state: { isActive: true },
    metadata: { createdAt: '2026-01-01', lastActiveAt: '2026-01-01', position: 0 },
  }]));
  await expect(page.getByRole('tab', { name: 'Renamed shell', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Terminal input', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('invalid-event-contained.png') });
});
