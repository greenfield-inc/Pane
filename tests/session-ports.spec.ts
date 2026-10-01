import { expect, test, type Page } from '@playwright/test';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';
import { dropRemoteConnection, emitRemoteDaemonEvent, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// The Ports chip row: a cloud Session's published ports (tailnet HTTPS links)
// and detected listeners, read from `runpane:ports:list` on the connected
// daemon. One Node-side fake daemon backs both the desktop (electronAPI mock)
// and the web client (Remote PWA over the mocked HTTP+SSE host).

const HOST = 'rp-zd56pin5.example.ts.net';

interface FakePort extends JsonObject { name: string; port: number; httpsPort: number; url: string; source: string }

function createFakePortsDaemon(host = HOST, names: [string, string] = ['taste', 'pages']) {
  const url = (httpsPort: number) => `https://${host}:${httpsPort}/`;
  const published: FakePort[] = [
    { name: names[0], port: 8787, httpsPort: 8787, url: url(8787), source: 'manifest' },
    { name: names[1], port: 8788, httpsPort: 8788, url: url(8788), source: 'user' },
  ];
  // A plain tcp serve entry already holds tailnet :9000 (like an app on :8787).
  const tcpServed = new Set([9000]);
  let suggested: JsonObject[] = [
    { port: 5173, address: '127.0.0.1', process: 'vite', pid: 4242 },
    { port: 9000, address: '0.0.0.0', process: 'node' },
  ];
  const calls: Array<{ channel: string; args: JsonValue[] }> = [];
  let listFailures: string[] = [];

  // The daemon's PortsListResult shape (runpane:ports:list).
  const list = (): JsonObject => ({
    ok: true, available: true, host, scheme: 'https', autoOpen: false,
    ports: published.map(item => ({ ...item, scheme: 'https', path: '/', status: 'serving', createdAt: '2026-09-30T23:00:00Z' })),
    suggested: suggested.map(item => ({ ...item, detectedAt: '2026-09-30T23:00:00Z' })),
  });

  return {
    calls,
    list,
    /** The next list reads fail with these messages, in order. */
    failNextLists(...messages: string[]) {
      listFailures = messages;
    },
    /** Adds a published port behind the UI's back, as `runpane port open` in the Session would. */
    publishOutOfBand(name: string, port: number): JsonObject {
      published.push({ name, port, httpsPort: port, url: url(port), source: 'user' });
      suggested = suggested.filter(item => item.port !== port);
      return list();
    },
    handle(channel: string, args: JsonValue[]): JsonValue | undefined {
      if (!channel.startsWith('runpane:ports:')) return undefined;
      calls.push({ channel, args });
      // SAFETY: the UI sends one request object for open/close.
      const request = (args[0] ?? {}) as { port?: number; yes?: boolean; target?: number | string };
      if (channel === 'runpane:ports:list') {
        const failure = listFailures.shift();
        if (failure) throw new Error(failure);
        return list();
      }
      if (channel === 'runpane:ports:open') {
        const port = Number(request.port);
        if (tcpServed.has(port) && request.yes !== true) {
          throw new Error(`ERR_PORTS_CONFLICT: tailnet port ${port} is held by another Serve entry (tcp ${port})`);
        }
        tcpServed.delete(port);
        const entry: FakePort = { name: `port-${port}`, port, httpsPort: port, url: url(port), source: 'user' };
        published.push(entry);
        suggested = suggested.filter(item => item.port !== port);
        return { port: entry };
      }
      if (channel === 'runpane:ports:close') {
        const index = published.findIndex(item => item.name === request.target || item.port === request.target);
        if (index < 0) throw new Error(`no published port ${String(request.target)}`);
        const [closed] = published.splice(index, 1);
        return { closed };
      }
      throw new Error(`No Pane daemon command registered for channel "${channel}"`);
    },
  };
}

type FakePortsDaemon = ReturnType<typeof createFakePortsDaemon>;

const now = new Date(0).toISOString();
const project = { id: 7, name: 'my-app', path: '/home/user/my-app', active: true, created_at: now, updated_at: now };
const session = {
  id: 'ports-session',
  name: 'taste preview',
  worktreePath: '/home/user/my-app/worktrees/taste',
  prompt: '',
  status: 'stopped',
  createdAt: now,
  lastActivity: now,
  output: [],
  jsonMessages: [],
  isRunning: false,
  permissionMode: 'ignore',
  projectId: project.id,
  displayOrder: 0,
  isFavorite: false,
  toolType: 'none',
  archived: false,
  gitStatus: { state: 'clean', ahead: 0, behind: 0, hasUncommittedChanges: false, hasUntrackedFiles: false, filesChanged: 0 },
};
const panels = [{
  id: 'ports-terminal',
  sessionId: session.id,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: true, hasBeenViewed: true, customState: { isInitialized: false } },
  metadata: { createdAt: now, lastActiveAt: now, position: 0 },
}];

async function installDesktopPorts(page: Page, daemon: Pick<FakePortsDaemon, 'handle'>) {
  await page.exposeFunction('__portsInvoke', (channel: string, args: JsonValue[]) => daemon.handle(channel, args) ?? null);
  await page.addInitScript(() => {
    const api = window.electronAPI;
    const baseInvoke = api.invoke;
    const listeners = new Set<(payload: JsonValue) => void>();
    api.invoke = (channel: string, ...args: JsonValue[]) => (
      channel.startsWith('runpane:ports:') ? window.__portsInvoke(channel, args) : baseInvoke(channel, ...args)
    );
    // The mock's events object answers every other subscription; inherit from it.
    const events = Object.create(api.events);
    events.onSessionPortsChanged = (listener: (payload: JsonValue) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    api.events = events;
    window.__portsEmitChanged = payload => { for (const listener of listeners) listener(payload); };
  });
}

declare global {
  interface Window {
    /** Installed by `installDesktopPorts`: the Node-side fake daemon. */
    __portsInvoke: (channel: string, args: JsonValue[]) => Promise<JsonValue>;
    /** Installed by `installDesktopPorts`: delivers `runpane:ports:changed`. */
    __portsEmitChanged: (payload: JsonValue) => void;
    /** Counts ports invokes in the older-daemon test. */
    __portsListCalls: number;
  }
}

async function openDesktopSession(page: Page, daemon: Pick<FakePortsDaemon, 'handle'>) {
  await installElectronApiMock(page, {
    platform: 'linux',
    initialProjects: [project],
    initialSessions: [session],
    initialPanels: panels,
    activeProjectId: project.id,
  });
  await installDesktopPorts(page, daemon);
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: /^Expand repository my-app$/ }).click();
  await page.getByRole('button', { name: 'taste preview', exact: true }).click();
}

test.describe('Session ports chip row', () => {
  test('desktop: published ports open in the default browser, suggestions publish, live changes and close', async ({ page }, testInfo) => {
    const daemon = createFakePortsDaemon();
    await openDesktopSession(page, daemon);

    const row = page.getByRole('region', { name: 'Session ports' });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('session-port-chip')).toHaveCount(2);
    await expect(row.getByTestId('session-port-suggestion')).toHaveCount(2);
    await expect(row.getByText(':5173 vite')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('desktop-ports-row.png') });
    await row.screenshot({ path: testInfo.outputPath('desktop-ports-row-closeup.png') });

    // Name -> URL in the default browser (shell.openExternal through preload).
    await row.getByRole('button', { name: `Open taste (https://${HOST}:8787/)` }).click();
    await expect.poll(() => page.evaluate(() => window.__paneTestElectronMock.getOpenedExternalUrls()))
      .toEqual([`https://${HOST}:8787/`]);

    // A dimmed suggestion publishes with one click.
    await row.getByTestId('session-port-suggestion').filter({ hasText: ':5173 vite' })
      .getByRole('button', { name: 'Open on tailnet' }).click();
    await expect(row.getByRole('button', { name: `Open port-5173 (https://${HOST}:5173/)` })).toBeVisible();
    await expect(row.getByTestId('session-port-suggestion')).toHaveCount(1);
    expect(daemon.calls.find(call => call.channel === 'runpane:ports:open')?.args).toEqual([{ port: 5173 }]);

    // A tailnet port held by a tcp entry needs an explicit Replace (sent as yes: true).
    await row.getByTestId('session-port-suggestion').filter({ hasText: ':9000 node' })
      .getByRole('button', { name: 'Open on tailnet' }).click();
    await expect(row.getByText('Tailnet port :9000 is already served. Replace it?')).toBeVisible();
    await row.screenshot({ path: testInfo.outputPath('desktop-ports-replace-confirm.png') });
    await row.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(row.getByRole('button', { name: `Open port-9000 (https://${HOST}:9000/)` })).toBeVisible();
    expect(daemon.calls.filter(call => call.channel === 'runpane:ports:open').map(call => call.args[0]))
      .toEqual([{ port: 5173 }, { port: 9000 }, { port: 9000, yes: true }]);

    // Live update: the daemon pushes runpane:ports:changed after an out-of-band `runpane port open`.
    const pushed = daemon.publishOutOfBand('storybook', 6006);
    await page.evaluate(payload => window.__portsEmitChanged(payload), pushed);
    await expect(row.getByRole('button', { name: `Open storybook (https://${HOST}:6006/)` })).toBeVisible();

    // Close asks first, then unpublishes.
    await row.getByRole('button', { name: 'Close pages' }).click();
    await expect(row.getByText('Stop publishing pages (:8788)?')).toBeVisible();
    await row.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(row.getByRole('button', { name: /^Open pages / })).toHaveCount(0);
    expect(daemon.calls.find(call => call.channel === 'runpane:ports:close')?.args).toEqual([{ target: 'pages' }]);
    await page.screenshot({ path: testInfo.outputPath('desktop-ports-after.png') });
  });

  test('desktop: switching hosts mid-confirm drops the old host\'s chips and confirmation; nothing reaches either host', async ({ page }, testInfo) => {
    const first = createFakePortsDaemon();
    const second = createFakePortsDaemon('rp-b.tail03bf19.ts.net', ['docs', 'storybook']);
    // The desktop invokes whichever daemon it is connected to.
    let connected = first;
    await openDesktopSession(page, { handle: (channel, args) => connected.handle(channel, args) });

    const row = page.getByRole('region', { name: 'Session ports' });
    await row.getByRole('button', { name: 'Close pages' }).click();
    await expect(row.getByText('Stop publishing pages (:8788)?')).toBeVisible();

    connected = second;
    await page.evaluate(async () => {
      await window.electronAPI.remoteDaemon.upsertConnectionProfile({
        id: 'second', label: 'Second host', baseUrl: 'https://rp-b.example.ts.net', token: 'synthetic', transport: 'http+sse',
      });
      await window.electronAPI.remoteDaemon.updateClientState({ mode: 'remote', activeProfileId: 'second' });
    });

    await expect(row.getByRole('button', { name: 'Open docs (https://rp-b.tail03bf19.ts.net:8787/)' })).toBeVisible();
    await expect(row.getByRole('group', { name: 'Confirm' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^Open pages / })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('desktop-ports-host-switched.png') });

    // A late change event carrying the old host's list is not shown as the new host's.
    await page.evaluate(payload => window.__portsEmitChanged(payload), first.list());
    await expect.poll(() => second.calls.filter(call => call.channel === 'runpane:ports:list').length).toBeGreaterThan(1);
    await expect(row.getByRole('button', { name: /^Open taste / })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /^Open docs / })).toBeVisible();

    expect([...first.calls, ...second.calls].filter(call => call.channel !== 'runpane:ports:list')).toEqual([]);
  });

  test('desktop: a failed first read says why and offers Retry; a refused copy says so', async ({ page }) => {
    const daemon = createFakePortsDaemon();
    daemon.failNextLists('tailscale: not running');
    await openDesktopSession(page, daemon);

    const row = page.getByRole('region', { name: 'Session ports' });
    await expect(row.getByRole('alert')).toContainText(/Couldn't load ports: .*tailscale: not running/);
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(row.getByTestId('session-port-chip')).toHaveCount(2);
    await expect(row.getByRole('alert')).toHaveCount(0);

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('Write permission denied.')) },
      });
    });
    await row.getByRole('button', { name: 'Copy taste URL' }).click();
    await expect(row.getByRole('alert')).toHaveText('Copy failed: Write permission denied.');
  });

  test('desktop: the row stays hidden on a daemon without ports channels', async ({ page }) => {
    await installElectronApiMock(page, { platform: 'linux', initialProjects: [project], initialSessions: [session], initialPanels: panels, activeProjectId: project.id });
    await page.addInitScript(() => {
      const baseInvoke = window.electronAPI.invoke;
      window.__portsListCalls = 0;
      window.electronAPI.invoke = (channel: string, ...args: JsonValue[]) => {
        if (!channel.startsWith('runpane:ports:')) return baseInvoke(channel, ...args);
        window.__portsListCalls += 1;
        return Promise.reject(new Error(`No Pane daemon command registered for channel "${channel}"`));
      };
    });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /^Expand repository my-app$/ }).click();
    await page.getByRole('button', { name: 'taste preview', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__portsListCalls)).toBeGreaterThan(0);
    await expect(page.getByRole('region', { name: 'Session ports' })).toHaveCount(0);
  });

  test('web client: chips open a new tab, update live over SSE and on reconnect', async ({ page, context }, testInfo) => {
    const daemon = createFakePortsDaemon();
    await openConnectedRemotePwa(page, { handleInvoke: (channel, args) => daemon.handle(channel, args) });

    const row = page.getByRole('region', { name: 'Session ports' });
    await expect(row.getByTestId('session-port-chip')).toHaveCount(2);
    await expect(row.getByTestId('session-port-suggestion')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('web-ports-row.png') });

    // Name -> URL in a new tab; the PWA keeps its own tab and connection.
    await context.route(`https://${HOST}:8787/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>taste</title>ok' }));
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      row.getByRole('button', { name: `Open taste (https://${HOST}:8787/)` }).click(),
    ]);
    await expect.poll(() => popup.url()).toBe(`https://${HOST}:8787/`);
    await popup.close();
    await expect(page).toHaveURL(/remote\.html/);

    // Live: runpane:ports:changed arrives on the event stream.
    await emitRemoteDaemonEvent(page, 'runpane:ports:changed', [daemon.publishOutOfBand('storybook', 6006)]);
    await expect(row.getByRole('button', { name: `Open storybook (https://${HOST}:6006/)` })).toBeVisible();

    // Suggestion -> published through runpane:ports:open over HTTP.
    await row.getByTestId('session-port-suggestion').filter({ hasText: ':5173 vite' })
      .getByRole('button', { name: 'Open on tailnet' }).click();
    await expect(row.getByRole('button', { name: `Open port-5173 (https://${HOST}:5173/)` })).toBeVisible();

    // Reconnect: a change made while the stream was down shows up once it is back.
    await dropRemoteConnection(page);
    await expect(page.getByText(/reconnecting/i).first()).toBeVisible();
    daemon.publishOutOfBand('docs', 4000);
    await restoreRemoteConnection(page);
    await expect(row.getByRole('button', { name: `Open docs (https://${HOST}:4000/)` })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('web-ports-after.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('web-ports-phone.png') });
  });
});
