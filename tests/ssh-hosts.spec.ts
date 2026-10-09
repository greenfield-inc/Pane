import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type MockBridge = { emitPanelCreated(panel: JsonObject): void; releaseSshPanelReads(): void };

const sshTabs = (page: Page) => page.getByTestId('ssh-view').getByRole('tab');

test.describe('SSH view', () => {
  test('keeps a tab opened while the saved tab list is still loading', async ({ page }) => {
    await installElectronApiMock(page, { sshHosts: ['mini', 'web-1'], holdSshPanelReads: true });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByTestId('ssh-host-row').filter({ hasText: 'mini' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Opening SSH' })).toBeVisible();
    await page.evaluate(() => {
      // SAFETY: installElectronApiMock installs this bridge before navigation.
      const mock = (window as typeof window & { __paneTestElectronMock: MockBridge }).__paneTestElectronMock;
      mock.emitPanelCreated({
        id: 'late-web-1', sessionId: '__ssh_hosts_session__', type: 'terminal', title: 'web-1',
        state: { isActive: false, customState: { initialCommand: 'ssh web-1', sshHost: 'web-1' } },
        metadata: { createdAt: '2026-10-09T00:00:00.000Z', lastActiveAt: '2026-10-09T00:00:00.000Z', position: 1 },
      });
      mock.releaseSshPanelReads();
    });

    await expect(sshTabs(page)).toHaveCount(2);
    await expect(page.getByTestId('ssh-view').getByRole('tab', { name: /web-1/ })).toBeVisible();
  });

  test('offers a retry when the SSH Session cannot load', async ({ page }) => {
    await installElectronApiMock(page, { sshHosts: ['mini'], sshSessionReadFailures: 1 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByTestId('ssh-host-row').filter({ hasText: 'mini' }).click();
    const alert = page.getByTestId('ssh-view').getByRole('alert');
    await expect(alert).toContainText('Could not load the SSH view.');

    await alert.getByRole('button', { name: 'Retry' }).click();

    await expect(alert).toHaveCount(0);
    await expect(page.getByTestId('ssh-view').getByRole('tabpanel')).toHaveCount(1);
  });

  test('reaches the new-terminal button of a host row from the keyboard', async ({ page }) => {
    await installElectronApiMock(page, { sshHosts: ['mini'] });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByTestId('ssh-host-row').filter({ hasText: 'mini' }).focus();
    await page.keyboard.press('Tab');

    const plus = page.getByRole('button', { name: 'New terminal on mini' });
    await expect(plus).toBeFocused();
    await expect(plus).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(sshTabs(page)).toHaveCount(1);
  });
});
