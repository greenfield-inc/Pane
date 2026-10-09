import { expect, test, type Page } from '@playwright/test';
import { connectAnotherRemoteClient, dropRemoteConnection, emitRemoteHostEvent, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// Each phone or browser keeps its own Pane and tab. It brings a tab forward
// only when the host asks for the Pane it is showing, and it remembers its
// place across reloads.

const P = 'anim-remote-0';
const S = '__orchestration_session_mock-0__';
const Q = 'anim-remote-1';
const paneButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });
const shownPane = (page: Page) => page.locator('[aria-current="page"]');
const selectedTab = (page: Page) => page.getByRole('tab', { selected: true });

/** A reload reconnects to the saved host on its own. */
async function reconnected(page: Page) {
  await page.getByRole('tablist', { name: 'Remote tool panels' }).waitFor({ state: 'attached' });
}

test('follows a host activation only on the Pane it shows', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'] });
  await expect(shownPane(page)).toHaveText(/^Pane P/);
  await expect(selectedTab(page)).toHaveText('claude');

  // An agent opens a page in P: this phone is on P, so it shows it.
  host.activePanelIds[P] = 'anim-panel-1';
  await emitRemoteHostEvent(page, 'panel:activeChanged', { sessionId: P, panelId: 'anim-panel-1', placement: 'split' });
  await expect(selectedTab(page)).toHaveText('shell');

  // This phone remembers claude in Q; then an agent brings shell forward in Q.
  await paneButton(page, 'Pane Q').click();
  await page.getByRole('tab', { name: 'claude', exact: true }).click();
  await paneButton(page, 'Pane P').click();
  host.activePanelIds[Q] = `${Q}-panel-1`;
  await emitRemoteHostEvent(page, 'panel:activeChanged', { sessionId: Q, panelId: `${Q}-panel-1` });
  await expect(shownPane(page)).toHaveText(/^Pane P/);
  await expect(selectedTab(page)).toHaveText('shell');

  // Opening Q later shows this phone's own tab there.
  await paneButton(page, 'Pane Q').click();
  await expect(shownPane(page)).toHaveText(/^Pane Q/);
  await expect(selectedTab(page)).toHaveText('claude');
});

test('remembers its Pane and tab across a reload and a dropped connection', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'] });
  await paneButton(page, 'Pane Q').click();
  await page.getByRole('tab', { name: 'shell', exact: true }).click();
  // Another client then picks claude in Q, so the host's last-used tab differs.
  host.activePanelIds[Q] = `${Q}-panel-0`;

  await page.reload();
  await reconnected(page);
  await expect(shownPane(page)).toHaveText(/^Pane Q/);
  await expect(selectedTab(page)).toHaveText('shell');

  await dropRemoteConnection(page);
  // The status bar is busy while the phone reconnects.
  await expect(page.locator('[aria-busy="true"]')).toBeAttached();
  // A change made while this phone was away shows that the reconnect resync has run.
  host.panes[1].name = 'Pane Q renamed';
  await restoreRemoteConnection(page);
  await expect(shownPane(page)).toHaveText(/^Pane Q renamed/);
  await expect(selectedTab(page)).toHaveText('shell');
});

test('two browser tabs of one profile stay independent and a reload restores the last one used', async ({ page, context }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'] });
  const second = await context.newPage();
  await connectAnotherRemoteClient(second, host);

  await page.getByRole('tab', { name: 'shell', exact: true }).click();
  await paneButton(second, 'Pane Q').click();
  await second.getByRole('tab', { name: 'shell', exact: true }).click();
  host.activePanelIds[Q] = `${Q}-panel-0`;
  await expect(shownPane(page)).toHaveText(/^Pane P/);
  await expect(selectedTab(page)).toHaveText('shell');

  await page.reload();
  await reconnected(page);
  await expect(shownPane(page)).toHaveText(/^Pane Q/);
  await expect(selectedTab(page)).toHaveText('shell');
});

test('falls back to the first Pane when the remembered Pane is gone', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'] });
  await paneButton(page, 'Pane Q').click();
  await expect(shownPane(page)).toHaveText(/^Pane Q/);
  host.archivedPanes.push(...host.panes.filter(pane => pane.id === Q));
  host.panes = host.panes.filter(pane => pane.id !== Q);

  await page.reload();
  await reconnected(page);
  await expect(shownPane(page)).toHaveText(/^Pane P/);
});

test('works without remembering when browser storage is blocked', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Private windows and blocked site data throw on every storage call this app makes for its view.
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith('pane.remotePwa.view')) throw new DOMException('blocked', 'SecurityError');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('pane.remotePwa.view')) throw new DOMException('blocked', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'] });
  await paneButton(page, 'Pane Q').click();
  await page.getByRole('tab', { name: 'shell', exact: true }).click();
  await expect(selectedTab(page)).toHaveText('shell');

  await page.reload();
  await reconnected(page);
  await expect(shownPane(page)).toHaveText(/^Pane P/);
  expect(errors).toEqual([]);
});

test('reopens the Session it had open after a reload', async ({ page }) => {
  await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'], orchestrationSessionNames: ['Release prep'] });
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');

  await page.reload();
  await reconnected(page);
  await expect(page.getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(shownPane(page)).toHaveCount(0);
});

test('moves to a neighbouring tab when another client closes the one it shows, and remembers it', async ({ page }) => {
  await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'], panelTitles: ['claude', 'shell', 'logs'] });
  await page.getByRole('tab', { name: 'shell', exact: true }).click();

  await emitRemoteHostEvent(page, 'panel:deleted', { sessionId: P, panelId: 'anim-panel-1' });
  await expect(selectedTab(page)).toHaveText('logs');

  // A background tab opened on any Pane afterwards moves nobody.
  for (const sessionId of [Q, P]) {
    await emitRemoteHostEvent(page, 'panel:created', {
      id: `${sessionId}-background`, sessionId, type: 'terminal', title: 'background',
      state: { isActive: false }, metadata: { createdAt: '', lastActiveAt: '', position: 9 },
    });
  }
  await expect(page.getByRole('tab', { name: 'background', exact: true })).toBeVisible();
  await expect(selectedTab(page)).toHaveText('logs');

  await page.reload();
  await reconnected(page);
  await expect(selectedTab(page)).toHaveText('logs');
});

test('reopens a remembered Session even when a Pane loads first during startup', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'], orchestrationSessionNames: ['Release prep'] });
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  await expect(selectedTab(page)).toHaveText('Claude');

  // The Session list answers last, after the Panes have loaded.
  let release = () => {};
  host.held['orchestration-sessions:list'] = new Promise<void>(resolve => { release = resolve; });
  await page.reload();
  await reconnected(page);
  await page.waitForTimeout(1000);
  release();
  delete host.held['orchestration-sessions:list'];

  await expect(selectedTab(page)).toHaveText('Claude');
  await expect(shownPane(page)).toHaveCount(0);
});

test('keeps the tool tab it chose in a Session across reopening and reload', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P', 'Pane Q'], orchestrationSessionNames: ['Release prep'] });
  host.sessionTools[S] = [{ id: `${S}tool-a`, title: 'Tool A' }, { id: `${S}tool-b`, title: 'Tool B' }];
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  await page.getByRole('tab', { name: 'Tool A', exact: true }).click();

  await paneButton(page, 'Pane P').click();
  await expect(shownPane(page)).toHaveText(/^Pane P/);
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  await expect(selectedTab(page)).toHaveText('Tool A');

  await page.reload();
  await reconnected(page);
  await expect(selectedTab(page)).toHaveText('Tool A');
});

test('moves to the next visible Session tab when another client closes the one it shows', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { sessionNames: ['Pane P'], orchestrationSessionNames: ['Release prep'] });
  host.sessionTools[S] = [{ id: `${S}tool-a`, title: 'Tool A' }, { id: `${S}tool-b`, title: 'Tool B' }];
  await page.getByRole('button', { name: 'Open Session Release prep' }).click();
  // The host keeps Codex's chat between Tool A and Tool B; the strip hides it.
  await expect(page.getByRole('tab')).toHaveText(['Claude', 'Tool A', 'Tool B']);
  await page.getByRole('tab', { name: 'Tool A', exact: true }).click();

  await emitRemoteHostEvent(page, 'panel:deleted', { sessionId: `${S}terminal__`, panelId: `${S}tool-a` });
  await expect(selectedTab(page)).toHaveText('Tool B');

  await page.reload();
  await reconnected(page);
  await expect(selectedTab(page)).toHaveText('Tool B');
});
