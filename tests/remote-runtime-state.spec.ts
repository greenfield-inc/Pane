import { expect, test } from '@playwright/test';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import type { RemotePaneConnectionState } from '../shared/types/remoteDaemon';

declare global {
  interface Window {
    __releaseRemoteSnapshot: () => void;
  }
}

for (const channel of ['connection', 'host'] as const) {
  test(`keeps the pushed ${channel} state when slow initial health discovery finishes`, async ({ page }, testInfo) => {
    await installElectronApiMock(page);
    await page.addInitScript(() => {
      const readHost = window.electronAPI.remoteDaemon.getHostState;
      const gate = new Promise<void>(resolve => { window.__releaseRemoteSnapshot = resolve; });
      window.electronAPI.remoteDaemon.getHostState = async () => {
        const snapshot = await readHost();
        await gate;
        return snapshot;
      };
    });
    await gotoApp(page);
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remote inactive', exact: true })).toBeVisible();
    await page.evaluate(async channel => {
      if (channel === 'host') {
        await window.electronAPI.remoteDaemon.updateHostConfig({ enabled: true });
      } else {
        await window.electronAPI.remoteDaemon.upsertConnectionProfile({
          id: 'remote-fixture', label: 'Fixture remote', baseUrl: 'http://localhost:19999',
          token: 'synthetic', transport: 'http+sse',
        });
        await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'remote-fixture' });
      }
    }, channel);
    // On a remote, the rail button is the machine switcher; its mark is solid only while connected.
    const label = channel === 'host' ? 'Remote host live' : 'Agents run on Fixture remote. Switch machine';
    const expectPushedState = async () => {
      const button = page.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      if (channel === 'connection') await expect(button.getByTestId('machine-mark')).toHaveAttribute('data-presence', 'solid');
    };
    await expectPushedState();
    await page.evaluate(async () => {
      window.__releaseRemoteSnapshot();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expectPushedState();
    await page.screenshot({ path: testInfo.outputPath(`${channel}-still-current.png`) });
  });
}

const at = new Date(0).toISOString();
const project = { id: 915, name: 'Watched', path: '/tmp/watched', active: true, created_at: at, updated_at: at };
const pane = {
  id: 'watched-pane', name: 'Fix checkout', projectId: project.id,
  worktreePath: `${project.path}/pane`, isMainRepo: false, prompt: '', status: 'stopped',
  createdAt: at, lastActivity: at, output: [], jsonMessages: [], isRunning: false,
  permissionMode: 'ignore', toolType: 'none', archived: false, displayOrder: 0,
};

type HostTestWindow = Window & {
  __paneTestElectronMock: {
    setConnectionState(updates: Partial<RemotePaneConnectionState>): void;
    getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
  };
};

test('a read-only computer is watched: no create, close, git or typing, until it gives full access', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [project], initialSessions: [pane], activeProjectId: project.id,
    initialPanels: [{
      id: 'agent', sessionId: pane.id, type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { initialCommand: 'codex' } }, metadata: { createdAt: at, lastActiveAt: at, position: 0 },
    }],
  });
  await gotoApp(page);
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  const connect = (access: 'read' | undefined) => page.evaluate((level) => (window as HostTestWindow).__paneTestElectronMock.setConnectionState({
    mode: 'remote', status: 'connected', activeProfileId: 'tyler', activeProfileLabel: 'Tyler', access: level,
  }), access);
  // SAFETY: same mock as above.
  const typed = () => page.evaluate(() => (window as HostTestWindow).__paneTestElectronMock.getInvokeCalls('terminal:input').length);
  await connect('read');
  const expand = page.getByRole('button', { name: `Expand project ${project.name}`, exact: true });
  await expect(page.getByRole('button', { name: `Project actions for ${project.name}`, exact: true })).toBeVisible();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: pane.name, exact: true }).click();

  await expect(page.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
  for (const name of ['New project', `New pane in ${project.name}`, 'Add tool', `Archive ${pane.name}`]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByTestId('terminal-activation-mask')).toHaveCount(0);
  await page.locator('.xterm').first().click();
  await page.keyboard.type('rm -rf');
  expect(await typed()).toBe(0);
  if (process.env.PANE_QR_SHOTS) await page.screenshot({ path: `${process.env.PANE_QR_SHOTS}/desktop-read-only.png` });

  await connect(undefined);
  await expect(page.getByRole('button', { name: 'Add tool', exact: true })).toBeVisible();
  await page.locator('.xterm').first().click();
  await page.keyboard.type('ls');
  await expect.poll(typed).toBeGreaterThan(0);
});
