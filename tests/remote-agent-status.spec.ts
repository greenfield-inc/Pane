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

  // "N working" is the host's count, sent with the Session's activity.
  await emitRemoteEvent(page, 'panel:agentStatus', status('anim-remote-0', 'anim-panel-0', 'working'));
  await emitRemoteEvent(page, 'orchestration-sessions:activity', { sessionId: host.sessions[0].id, state: 'working', workingPanes: 1 });
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

// Session activity on the phone (cover sheet J12, J14, J15): the host decides it, the phone shows it.
const sessionIcon = (page: Page, name: string) => page.getByRole('dialog', { name: 'Remote panes' })
  .getByRole('group', { name: 'Sessions' }).getByRole('button', { name: new RegExp(`Open Session ${name}`) }).getByTestId('session-activity-icon');

test('the Session row spins while the host says it works, and the ring comes back when it stops (J14)', async ({ page }) => {
  const host = await connect(page, { orchestrationSessionNames: ['Release prep', 'Infra'] });
  const [release, infra] = host.sessions;
  host.sessionActivity = [{ sessionId: release.id, state: 'working', workingPanes: 0 }];
  await dropRemoteConnection(page);
  await restoreRemoteConnection(page);
  await openDrawer(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'working');
  await expect(sessionIcon(page, 'Infra')).toHaveAttribute('data-state', 'idle');
  // Option 1 at phone width: the spinner and the empty ring sit in the same 12 px box.
  const working = await sessionIcon(page, 'Release prep').boundingBox();
  const idle = await sessionIcon(page, 'Infra').boundingBox();
  expect([working?.width, working?.height]).toEqual([12, 12]);
  expect([idle?.width, idle?.height]).toEqual([12, 12]);
  await page.screenshot({ path: test.info().outputPath('j14-phone-working.png') });

  await emitRemoteEvent(page, 'orchestration-sessions:activity', { sessionId: release.id, state: 'idle', workingPanes: 0 });
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'idle');
  await emitRemoteEvent(page, 'orchestration-sessions:activity', { sessionId: infra.id, state: 'working', workingPanes: 0 });
  await expect(sessionIcon(page, 'Infra')).toHaveAttribute('data-state', 'working');
});

test('a turn that ended while the phone was offline reads idle once it reconnects (J12)', async ({ page }) => {
  const host = await connect(page, { orchestrationSessionNames: ['Release prep'], sessionActivity: [] });
  await emitRemoteEvent(page, 'orchestration-sessions:activity', { sessionId: host.sessions[0].id, state: 'working', workingPanes: 0 });
  await openDrawer(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'working');

  await dropRemoteConnection(page);
  host.sessionActivity = [{ sessionId: host.sessions[0].id, state: 'idle', workingPanes: 0 }];
  await restoreRemoteConnection(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'idle', { timeout: 2_000 });
});

test('a Session reads idle while the phone is offline, not its last state, and working again on reconnect (review F-2)', async ({ page }) => {
  const host = await connect(page, { orchestrationSessionNames: ['Release prep'], sessionActivity: [] });
  host.sessionActivity = [{ sessionId: host.sessions[0].id, state: 'working', workingPanes: 1 }];
  await emitRemoteEvent(page, 'orchestration-sessions:activity', host.sessionActivity[0]);
  await openDrawer(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'working');

  await dropRemoteConnection(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'idle', { timeout: 2_000 });
  await page.screenshot({ path: test.info().outputPath('f2-phone-offline-idle.png') });
  await restoreRemoteConnection(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'working', { timeout: 2_000 });
});

test('a host too old to send Session activity shows idle rings and no error (J15)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await connect(page, { orchestrationSessionNames: ['Release prep'], sessionActivity: null, agentStatuses: [status('anim-remote-0', 'anim-panel-0', 'working')] });
  await openDrawer(page);
  await expect(sessionIcon(page, 'Release prep')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});
