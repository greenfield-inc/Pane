import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';

type MockBridge = {
  emitPanelCreated(panel: JsonObject): void;
  releaseSshPanelReads(): void;
  releaseSshOpens(error?: string): void;
  holdNextExpandedRead(): void;
  releaseExpandedReads(): void;
  emitRemoteDaemonResyncRequested(event: { hostChanged: boolean }): void;
  getConfigReadCount(): number;
};

/** Runs one step against the mock's event and request bridge. */
async function mock(page: Page, step: 'configReads' | 'releaseSshOpens' | 'releaseSshOpensWithError' | 'switchHostHoldingFirstRead' | 'switchHost' | 'releaseExpandedReads'): Promise<number> {
  return page.evaluate(name => {
    // SAFETY: installElectronApiMock installs this bridge before navigation.
    const bridge = (window as typeof window & { __paneTestElectronMock: MockBridge }).__paneTestElectronMock;
    if (name === 'releaseSshOpens') bridge.releaseSshOpens();
    if (name === 'releaseSshOpensWithError') bridge.releaseSshOpens('old-error');
    if (name === 'switchHostHoldingFirstRead') bridge.holdNextExpandedRead();
    if (name === 'switchHostHoldingFirstRead' || name === 'switchHost') bridge.emitRemoteDaemonResyncRequested({ hostChanged: true });
    if (name === 'releaseExpandedReads') bridge.releaseExpandedReads();
    return bridge.getConfigReadCount();
  }, step);
}

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

  test.describe('an open answered after a machine switch', () => {
    test('opens the SSH view when no switch happened', async ({ page }) => {
      await installElectronApiMock(page, { sshHosts: ['mini'], holdSshOpens: true });
      await page.goto('/', { waitUntil: 'domcontentloaded' });

      await page.getByTestId('ssh-host-row').filter({ hasText: 'mini' }).click();
      await mock(page, 'releaseSshOpens');

      await expect(sshTabs(page)).toHaveCount(1);
    });

    for (const outcome of ['success', 'failure'] as const) {
      test(`leaves the view alone when a ${outcome} arrives after switching away and back`, async ({ page }) => {
        await installElectronApiMock(page, { sshHosts: ['mini'], holdSshOpens: true });
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('ssh-host-row')).toHaveCount(1);

        await page.getByTestId('ssh-host-row').filter({ hasText: 'mini' }).click();
        // Switch to B, whose first read never answers in time, then back to A.
        await mock(page, 'switchHostHoldingFirstRead');
        const readsBefore = await mock(page, 'switchHost');
        // A's resync has reached its config read, past the reads that retire older work.
        await expect.poll(() => mock(page, 'configReads'), { timeout: 5000 }).toBeGreaterThan(readsBefore);
        await mock(page, outcome === 'success' ? 'releaseSshOpens' : 'releaseSshOpensWithError');
        // Give the outgoing answer every chance to land.
        await page.waitForTimeout(500);

        await expect(page.getByTestId('ssh-view')).toHaveCount(0);
        await expect(page.getByText('old-error')).toHaveCount(0);
        await mock(page, 'releaseExpandedReads');
      });
    }
  });
});
