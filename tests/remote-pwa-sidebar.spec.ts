import { expect, test, type Page } from '@playwright/test';
import { dropRemoteConnection, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// The Remote Pane PWA sidebar mirrors the desktop one: Pinned, Sessions,
// Repositories and Archived sections over the connected host's state.

const paneRow = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });

test('a phone creates a Session from the drawer and lands in its agent chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page);

  await page.getByRole('button', { name: 'Open remote panes' }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  const sheet = page.getByRole('dialog', { name: 'Create Session' });
  // The host reports which agents it can run and which one is its default.
  await expect(sheet.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await expect(sheet.getByRole('radio', { name: 'Cursor' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Create Session' }).click();

  await expect(sheet).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Open remote panes' }).click();
  await expect(page.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: 'Open Session New chat' })).toBeVisible();
});

test('Start pinned puts a new Session in Pinned and is remembered on this device', async ({ page }) => {
  await openConnectedRemotePwa(page);
  const sheet = page.getByRole('dialog', { name: 'Create Session' });
  await page.getByRole('button', { name: 'New Session' }).click();
  await expect(sheet.getByRole('checkbox', { name: 'Start pinned' })).not.toBeChecked();
  await sheet.getByLabel('Session name (optional)').fill('Pinned at birth');
  await sheet.getByText('Start pinned', { exact: true }).click();
  await sheet.getByRole('button', { name: 'Create Session' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('group', { name: 'Pinned' }).getByRole('button', { name: 'Open Session Pinned at birth' })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'New Session' }).click();
  await expect(sheet.getByRole('checkbox', { name: 'Start pinned' })).toBeChecked();
});

test('New Pane without a repository starts in the default repository and keeps the picker', async ({ page }) => {
  await openConnectedRemotePwa(page);
  await page.getByRole('button', { name: 'New Pane', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New Pane' });
  await expect(sheet.getByRole('combobox', { name: 'Repository' })).toHaveValue('1');
  await expect(sheet.getByRole('combobox', { name: 'Repository' })).toBeEnabled();
});

test('a pane opens on the tab that is active on the host', async ({ page }) => {
  await openConnectedRemotePwa(page, { activePanelIndex: 1 });
  await expect(page.getByRole('tab', { name: 'shell', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('pinned Sessions and pinned panes share the Pinned section', async ({ page }) => {
  await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });
  const pinned = page.getByRole('group', { name: 'Pinned' });

  await page.getByRole('button', { name: 'Pin Session Release prep' }).click();
  await expect(pinned.getByRole('button', { name: 'Open Session Release prep' })).toBeVisible();
  await page.getByRole('group', { name: 'Repositories' }).getByRole('button', { name: 'Pin pane' }).first().click();
  // Pinned panes keep their own name and show the repository beside it, as on desktop.
  await expect(pinned.getByRole('button', { name: /^scrub Sentry request bodies/ })).toContainText('pane');
  await pinned.getByRole('button', { name: 'Open Session Release prep' }).click();
  await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a phone opens a Session by tapping its icon, not only its name', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });

  await page.getByRole('button', { name: 'Open remote panes' }).click();
  const row = page.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: 'Open Session Release prep' });
  const box = await row.locator('xpath=..').boundingBox();
  if (!box) throw new Error('Session row has no box');
  // The leading chat icon of a Session without Panes, at the row's left edge.
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('archived Sessions and panes are restored from the Archived section', async ({ page }) => {
  page.on('dialog', dialog => void dialog.accept());
  await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });

  await page.getByRole('button', { name: 'Archive Session Release prep' }).click();
  await expect(page.getByRole('button', { name: 'Open Session Release prep' })).toHaveCount(0);
  await page.getByRole('group', { name: 'Repositories' }).getByRole('button', { name: 'Archive pane' }).first().click();
  await expect(paneRow(page, 'scrub Sentry request bodies')).toHaveCount(0);

  await page.getByRole('button', { name: /^Archived/ }).click();
  await page.getByRole('button', { name: 'Restore Session Release prep' }).click();
  await expect(page.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: 'Open Session Release prep' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore scrub Sentry request bodies' }).click();

  await expect(page.getByRole('group', { name: 'Repositories' }).getByRole('button', { name: /^scrub Sentry request bodies/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Archived' })).toContainText('Nothing archived');
});

test('collapsed sections stay collapsed on this device after a reload', async ({ page }) => {
  await openConnectedRemotePwa(page);
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await expect(paneRow(page, 'scrub Sentry request bodies')).toBeHidden();

  await page.reload();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Repositories', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(paneRow(page, 'scrub Sentry request bodies')).toBeHidden();
});

test('changes made on the host while the connection was down appear when it returns', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });
  await expect(paneRow(page, 'server-side funnel events')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Session Release prep' })).toBeVisible();

  await dropRemoteConnection(page);
  // Events from these changes never reach the PWA: its stream is down.
  host.panes = host.panes.filter(pane => pane.name !== 'server-side funnel events');
  host.sessions[0].archived = true;
  await restoreRemoteConnection(page);

  await expect(paneRow(page, 'server-side funnel events')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Session Release prep' })).toHaveCount(0);
});

test('Back past a Session still opening keeps the Pane it lands on', async ({ page }) => {
  await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });
  const paneTab = page.getByRole('tab', { name: 'shell', exact: true });
  const sessionTab = page.getByRole('tab', { name: 'Claude', exact: true });
  // SAFETY: the PWA writes its history entries as `{ paneRemote: { view } }`.
  const historyView = () => page.evaluate(() => (window.history.state as { paneRemote?: { view: string | null } } | null)?.paneRemote?.view);
  const back = () => page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true });
    window.history.back();
  }));

  // History: Pane A, Session S, Pane A.
  await expect(paneTab).toBeVisible();
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  await expect(sessionTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('group', { name: 'Repositories' }).getByRole('button', { name: /^scrub Sentry request bodies/ }).click();
  await expect(paneTab).toBeVisible();
  await expect.poll(historyView).toBe('pane:anim-remote-0');

  // Hold Session S's next open until both Backs have landed.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://anim-pane.test/**', async (route) => {
    if (route.request().postData()?.includes('"orchestration-sessions:get"')) await held;
    await route.fallback();
  });
  const sessionOpened = page.waitForResponse(response => response.request().postData()?.includes('"orchestration-sessions:get"') ?? false);

  await back();
  await back();
  release();
  await sessionOpened;
  await page.waitForTimeout(300);

  await expect(paneTab).toBeVisible();
  await expect(sessionTab).toHaveCount(0);
  expect(await historyView()).toBe('pane:anim-remote-0');
});

test('a Session shows its recorded blockers on its row and above its chat', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Release prep'] });
  host.sessions[0].blockers = ['Waiting on the signing certificate'];
  await page.getByRole('button', { name: 'Refresh remote sessions' }).click();

  const row = page.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: 'Open Session Release prep' });
  await expect(row).toContainText('Blocked');
  await row.click();
  await expect(page.getByRole('region', { name: 'Blockers' })).toContainText('Waiting on the signing certificate');
});
