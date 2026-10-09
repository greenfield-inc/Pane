import { expect, test, type Page } from '@playwright/test';
import { dropRemoteConnection, emitRemoteEvent, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// The Remote Pane PWA shows the same agent status dots and "needs input" counts
// as the desktop, from the host's status snapshot and its live status events.

const PANE_P = 'scrub Sentry request bodies';
const PANE_Q = 'server-side funnel events';

const status = (sessionId: string, panelId: string, state: string) => ({ sessionId, panelId, state, reason: null });

async function openDrawer(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Remote panes' });
  if (!(await drawer.isVisible())) await page.getByRole('button', { name: 'Open remote panes' }).click();
  return drawer;
}

const paneDot = (page: Page, name: string) =>
  page.getByRole('dialog', { name: 'Remote panes' }).getByRole('button', { name: new RegExp(name) }).getByRole('status');

/** Opens the PWA and waits for its event stream, so pushed events are not sent into nothing. */
async function connect(page: Page, options: Parameters<typeof openConnectedRemotePwa>[1] = {}) {
  const host = await openConnectedRemotePwa(page, options);
  await expect(page.getByRole('tab', { name: /claude/ })).toBeVisible();
  return host;
}

test.use({ viewport: { width: 390, height: 844 } });

test('a Pane that is already blocked shows as blocked as soon as the phone connects', async ({ page }) => {
  await connect(page, { agentStatuses: [status('anim-remote-0', 'anim-panel-0', 'blocked')] });

  await expect(page.getByRole('tab', { name: /claude/ }).getByRole('status')).toHaveAttribute('aria-label', 'Agent blocked');
  await openDrawer(page);
  await expect(paneDot(page, PANE_P)).toHaveAttribute('aria-label', 'Agent blocked');
});

test('live status moves the Pane dot, its tab and the Session summary together', async ({ page }) => {
  const host = await connect(page, { orchestrationSessionNames: ['Release prep'] });
  host.sessions[0].associations = [{ paneId: 'anim-remote-0', panelIds: [], attachedAt: new Date(0).toISOString() }];
  await emitRemoteEvent(page, 'orchestration-sessions:changed', null);
  const drawer = await openDrawer(page);
  const sessionRow = drawer.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: /Open Session Release prep/ });
  await expect(sessionRow).toContainText('1');

  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-0', 'anim-panel-0', 'working'));
  await expect(sessionRow).toContainText('1 working');
  await expect(paneDot(page, PANE_P).first()).toHaveAttribute('aria-label', 'Agent working');

  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-0', 'anim-panel-0', 'blocked'));
  await expect(sessionRow).toContainText('1 needs input');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: /claude/ }).getByRole('status')).toHaveAttribute('aria-label', 'Agent blocked');
  await openDrawer(page);

  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-0', 'anim-panel-0', 'working'));
  await expect(sessionRow).toContainText('1 working');

  // The phone is on this Pane when the agent finishes, so it reads as idle, not done.
  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-0', 'anim-panel-0', 'idle'));
  await expect(paneDot(page, PANE_P).first()).toHaveAttribute('aria-label', 'Agent idle');
});

test('a Pane that finishes while the phone is elsewhere reads as done until the phone opens it', async ({ page }) => {
  await connect(page);
  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-1', 'q-panel', 'working'));
  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-1', 'q-panel', 'idle'));

  await openDrawer(page);
  await expect(paneDot(page, PANE_Q)).toHaveAttribute('aria-label', 'Agent done');
  await page.getByRole('dialog', { name: 'Remote panes' }).getByRole('button', { name: new RegExp(PANE_Q) }).click();
  await openDrawer(page);
  await expect(paneDot(page, PANE_Q)).toHaveAttribute('aria-label', 'Agent idle');
});

test('a status change missed while the phone was offline shows once it reconnects', async ({ page }) => {
  const host = await connect(page, { agentStatuses: [status('anim-remote-0', 'anim-panel-0', 'blocked')] });
  const tabDot = page.getByRole('tab', { name: /claude/ }).getByRole('status');
  await expect(tabDot).toHaveAttribute('aria-label', 'Agent blocked');

  await dropRemoteConnection(page);
  host.agentStatuses = [status('anim-remote-0', 'anim-panel-0', 'idle')];
  await restoreRemoteConnection(page);

  await expect(tabDot).toHaveAttribute('aria-label', 'Agent idle');
});
