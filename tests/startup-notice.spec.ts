import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test('a mounted renderer reports the previous unclean shutdown once', async ({ page }) => {
  const notices: Array<{ title: string; body: string }> = [];
  await page.exposeFunction('recordStartupNotice', (title: string, body: string) => {
    notices.push({ title, body });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission = 'granted';
        constructor(title: string, options?: NotificationOptions) {
          // SAFETY: The test installs this Playwright binding before navigation.
          const bridge = window as typeof window & { recordStartupNotice(title: string, body: string): Promise<void> };
          void bridge.recordStartupNotice(title, options?.body ?? '');
        }
      },
    });
  });
  await installElectronApiMock(page, { uncleanShutdown: true });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('sidebar').first()).toBeVisible();
  await expect.poll(() => notices).toEqual([{
    title: "Pane didn't shut down cleanly",
    body: 'Your OS may have been overloaded. Check RAM usage if this keeps happening.',
  }]);
});
