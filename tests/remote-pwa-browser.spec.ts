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

test('a phone browser tab asks the host for a port\'s phone address when it has none yet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Browser', url: 'http://localhost:3000/' }],
    activePanelIndex: 2,
    ports: {
      host: 'MacBook Pro',
      ports: [{ port: 3000, pid: 1, process: 'next-server', group: 'pane-terminal', kind: 'web' }],
      phone: { state: 'on', filesUrl: 'http://phone-pages.test:44300' },
    },
  });

  const asked = await page.waitForRequest(request => request.postData()?.includes('"ports:phone-address"') ?? false);

  expect(JSON.parse(asked.postData() ?? '{}').args).toEqual([3000]);
  await expect(page.getByText('Pane is giving localhost:3000 a phone address…')).toBeVisible();
});

test('a phone browser tab goes back to its saved address when the host refuses the new one', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page, {
    browserPanels: [{ title: 'Browser', url: '' }],
    activePanelIndex: 2,
    ports: {
      host: 'MacBook Pro',
      ports: [{ port: 5173, pid: 1, process: 'node', group: 'pane-terminal', kind: 'web', phoneUrl: PHONE_URL }],
      phone: { state: 'on', filesUrl: 'http://phone-pages.test:44300' },
    },
  });
  await expect(page.getByRole('heading', { name: 'Ports on MacBook Pro' })).toBeVisible();
  let refuse = true;
  await page.route('http://anim-pane.test/**', async route => {
    if (!refuse || !route.request().postData()?.includes('"panels:update"')) return route.fallback();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'database is locked' } }) });
  });

  await page.getByTitle('Open localhost:5173').click();

  await expect(page.getByText('database is locked')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ports on MacBook Pro' })).toBeVisible();

  refuse = false;
  const saved = page.waitForRequest(request => request.postData()?.includes('"panels:update"') ?? false);
  await page.getByTitle('Open localhost:5173').click();
  expect((await saved).postData()).toContain('"currentUrl":"http://localhost:5173"');
});
