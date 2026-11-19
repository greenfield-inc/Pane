import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

// Out of CI (NOT_IN_CI in scripts/ci-test-inventory.mjs) until #1559 is fixed: a
// request made while the workspace restores is refused and never sent again. Moved
// unchanged from remote-pwa-browser.spec.ts (D-40), so the rest of that file runs in CI.

test('a phone browser tab asks the host for a port\'s phone address when it has none yet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The PWA reconnects on load, so it can ask before the connect helper returns.
  const asking = page.waitForRequest(request => request.postData()?.includes('"ports:phone-address"') ?? false);
  await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Browser', url: 'http://localhost:3000/' }],
    activePanelIndex: 2,
    ports: {
      host: 'MacBook Pro',
      ports: [{ port: 3000, pid: 1, process: 'next-server', group: 'pane-terminal', kind: 'web' }],
      phone: { state: 'on', filesUrl: 'http://phone-pages.test:44300' },
    },
  });

  const asked = await asking;

  expect(JSON.parse(asked.postData() ?? '{}').args).toEqual([3000]);
  await expect(page.getByText('Pane is giving localhost:3000 a phone address…')).toBeVisible();
});
