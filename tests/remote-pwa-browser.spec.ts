import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

// A phone browser tab frames a host dev server through the phone address the
// host's Ports list gives it, and reads it back as the host's own address.

const PHONE_URL = 'http://phone-pages.test:44301';

test('a phone opens a host dev server from a new browser tab\'s Ports list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`${PHONE_URL}/**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><h1>Hello from the host</h1>',
  }));
  await openConnectedRemotePwa(page, {
    ports: {
      host: 'MacBook Pro',
      ports: [
        { port: 5173, pid: 1, process: 'node', group: 'pane-terminal', kind: 'web', paneName: 'quick wins', phoneUrl: PHONE_URL },
        { port: 5432, pid: 2, process: 'postgres', group: 'other', kind: 'tcp' },
      ],
      phone: { state: 'on', filesUrl: 'http://phone-pages.test:44300' },
    },
  });

  await page.getByRole('button', { name: 'Add tool' }).click();
  await page.getByRole('menuitem', { name: /Browser/ }).click();
  await expect(page.getByRole('heading', { name: 'Ports on MacBook Pro' })).toBeVisible();
  await expect(page.getByText('desktop only')).toBeVisible();

  const saved = page.waitForRequest(request => request.postData()?.includes('"panels:update"') ?? false);
  await page.getByTitle('Open localhost:5173').click();

  expect((await saved).postData()).toContain('"currentUrl":"http://localhost:5173"');
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('localhost:5173/');
  await expect(page.getByText('on MacBook Pro')).toBeVisible();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Hello from the host' })).toBeVisible();
});
