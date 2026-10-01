import type { Page } from '@playwright/test';
import type { JsonValue } from '../shared/validation/boundaryDecoder';

// Test harness for the Remote Pane PWA — the browser-served surface at
// `/remote.html`, which talks to a remote Pane daemon over HTTP+SSE rather than
// to Electron. Nothing here touches `window.electronAPI`; see
// `tests/electronApiMock.ts` for the desktop equivalent.

export interface RemotePwaMockOptions {
  /** Panes the mock host reports, in sidebar order. */
  sessionNames?: string[];
  /** Terminal panels the selected pane reports, in tab order. */
  panelTitles?: string[];
  /** Host-defined terminal shortcuts offered in the mobile input bar. */
  shortcuts?: Array<{ id: string; key: string; label: string; text: string }>;
  /**
   * Answers extra invoke channels (return `undefined` to fall through to the
   * built-in fixtures). Throwing answers `{ ok: false }` with the message.
   */
  handleInvoke?: (channel: string, args: JsonValue[]) => JsonValue | undefined;
}

const PROFILE = {
  id: 'anim-host',
  label: 'MacBook Pro',
  baseUrl: 'http://anim-pane.test/remote/browser',
  token: 'anim-token-12345678',
  transport: 'http+sse',
} as const;

// Enough scrollback that the terminal reads as a working shell in the clips and
// the scroll joystick has something to move over.
const TERMINAL_SCROLLBACK = [
  '\x1b[32m➜\x1b[0m  \x1b[36mpane\x1b[0m git:(\x1b[31manimations-for-the-pane-web-app\x1b[0m) pnpm lint\r\n',
  '\r\n',
  '> pane@2.4.66 lint /Users/dev/pane\r\n',
  '> node scripts/lint.mjs\r\n',
  '\r\n',
  '  \x1b[32m✓\x1b[0m oxlint      \x1b[90m412 files\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m eslint      \x1b[90m88 files\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m knip        \x1b[90mno unused exports\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m boundaries  \x1b[90mconformant\x1b[0m\r\n',
  '\r\n',
  '\x1b[32m➜\x1b[0m  \x1b[36mpane\x1b[0m git:(\x1b[31manimations-for-the-pane-web-app\x1b[0m) ',
].map((data) => ({
  sessionId: 'anim-remote-0',
  type: 'stdout' as const,
  data,
  timestamp: new Date(0).toISOString(),
}));

const baseSession = {
  prompt: 'evidence fixture',
  status: 'running',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: true,
  permissionMode: 'ignore',
  projectId: 1,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

function buildFixtures(options: RemotePwaMockOptions) {
  const sessionNames = options.sessionNames ?? [
    'scrub Sentry request bodies',
    'server-side funnel events',
    'sms opt-in consent at signup',
  ];
  const panelTitles = options.panelTitles ?? ['claude', 'shell'];

  const sessions = sessionNames.map((name, index) => ({
    ...baseSession,
    id: `anim-remote-${index}`,
    name,
    worktreePath: `/Users/dev/pane/worktrees/${index}`,
    displayOrder: index,
  }));

  const project = {
    id: 1,
    name: 'dcouple/pane',
    path: '/Users/dev/pane',
    active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    sessions,
  };

  const panels = panelTitles.map((title, index) => ({
    id: `anim-panel-${index}`,
    sessionId: sessions[0].id,
    type: 'terminal',
    title,
    state: { isActive: index === 0, hasBeenViewed: index === 0 },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: index,
    },
  }));

  const affordances = {
    terminalShortcuts: options.shortcuts ?? [
      { id: 's1', key: 'r', label: 'Run the test suite', text: 'pnpm test', enabled: true },
      { id: 's2', key: 'l', label: 'Lint and typecheck', text: 'pnpm lint && pnpm typecheck', enabled: true },
      { id: 's3', key: 'g', label: 'Status', text: 'git status --short', enabled: true },
    ],
    customCommands: [
      { name: 'Codex', command: 'codex' },
    ],
    voiceTranscription: {
      availableModes: [],
      defaultMode: 'streaming',
      configured: {
        cleanup: false, recorded: false, streaming: false,
        fal: false, deepgram: false, openRouter: false,
      },
      modes: {
        streaming: { label: 'Live', priceLabel: '', latencyLabel: '', recommended: true },
        recorded: { label: 'Batch', priceLabel: '', latencyLabel: '', recommended: false },
      },
    },
  };

  return { project, panels, affordances };
}

/**
 * Stands up a fake remote Pane host and drives the PWA to its connected state.
 * The saved profile is seeded into localStorage so the connection screen offers
 * a one-click Connect rather than needing a pasted code.
 */
export async function openConnectedRemotePwa(
  page: Page,
  options: RemotePwaMockOptions = {},
): Promise<void> {
  const { project, panels, affordances } = buildFixtures(options);

  await page.addInitScript((profile) => {
    window.localStorage.setItem('pane.remotePwa.savedProfiles', JSON.stringify([profile]));

    // The PWA opens an EventSource for host push events. Nothing here depends on
    // server-sent traffic, so it only has to connect and stay quiet — but it does
    // have to be able to *drop*, because losing the host is the defining event of
    // using Pane from a phone and the status bar's motion is about saying so.
    class MockEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(readonly url: string) {
        // Handed to the registrar rather than aliased into a local, so the
        // newest stream is reachable without keeping a `self` around.
        register(this);
        // While the host is held down, the client's retries connect to nothing —
        // which is what keeps `reconnecting` on screen for as long as a caller
        // needs rather than for one backoff interval.
        if (!held) {
          window.setTimeout(() => this.onopen?.(new Event('open')), 0);
        }
      }
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
      addEventListener(name: string, listener: (event: MessageEvent) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      removeEventListener(): void {}
      close(): void {}
      dispatch(name: string, data: string): void {
        for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }));
      }
    }

    let live: MockEventSource | undefined;
    let held = false;
    const register = (source: MockEventSource) => { live = source; };

    Object.defineProperty(window, 'EventSource', { configurable: true, value: MockEventSource });

    // Drops the stream the way a phone leaving wifi does, and keeps it down. The
    // client's own backoff walks the status to `reconnecting` and keeps retrying
    // into the void until the host is brought back.
    Object.defineProperty(window, '__paneRemoteDropConnection', {
      configurable: true,
      value: () => {
        held = true;
        live?.onerror?.(new Event('error'));
      },
    });

    // Lets the next retry through, and opens the one already waiting so the
    // recovery does not have to sit out another backoff interval.
    // Pushes one host event down the live stream, as the daemon's SSE does.
    Object.defineProperty(window, '__paneRemoteEmitDaemonEvent', {
      configurable: true,
      value: (channel: string, args: unknown[]) => {
        live?.dispatch('daemon-event', JSON.stringify({ channel, args, timestamp: new Date().toISOString() }));
      },
    });

    Object.defineProperty(window, '__paneRemoteRestoreConnection', {
      configurable: true,
      value: () => {
        held = false;
        live?.onopen?.(new Event('open'));
      },
    });
  }, PROFILE);

  await installRemoteHostRoute(page, { project, panels, affordances }, options.handleInvoke);

  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

/**
 * Drops the host's event stream, the way a phone leaving wifi does, and holds it
 * down. The client's own backoff walks the status to `reconnecting` and stays
 * there — deliberately, because a host that came straight back would leave the
 * reconnecting state on screen for a single backoff interval, which is not long
 * enough to assert against or to record.
 *
 * Pair with `restoreRemoteConnection` to complete the round trip.
 */
export async function dropRemoteConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const drop = window.__paneRemoteDropConnection;
    if (!drop) throw new Error('Remote PWA mock is not installed on this page.');
    drop();
  });
}

/** Delivers a daemon event (for example `runpane:ports:changed`) over the mocked stream. */
export async function emitRemoteDaemonEvent(page: Page, channel: string, args: JsonValue[]): Promise<void> {
  await page.evaluate(({ channel, args }) => {
    const emit = window.__paneRemoteEmitDaemonEvent;
    if (!emit) throw new Error('Remote PWA mock is not installed on this page.');
    emit(channel, args);
  }, { channel, args });
}

/** Brings the held host back, settling the status to `connected`. */
export async function restoreRemoteConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const restore = window.__paneRemoteRestoreConnection;
    if (!restore) throw new Error('Remote PWA mock is not installed on this page.');
    restore();
  });
}

declare global {
  interface Window {
    /** Installed by `openConnectedRemotePwa`; see `dropRemoteConnection`. */
    __paneRemoteDropConnection?: () => void;
    /** Installed by `openConnectedRemotePwa`; see `restoreRemoteConnection`. */
    __paneRemoteRestoreConnection?: () => void;
    /** Installed by `openConnectedRemotePwa`; see `emitRemoteDaemonEvent`. */
    __paneRemoteEmitDaemonEvent?: (channel: string, args: unknown[]) => void;
  }
}

/** Serves the daemon's invoke endpoint for the channels the PWA calls. */
async function installRemoteHostRoute(
  page: Page,
  fixtures: ReturnType<typeof buildFixtures>,
  handleInvoke?: RemotePwaMockOptions['handleInvoke'],
): Promise<void> {
  await page.route('http://anim-pane.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    // SAFETY: the test route receives the remote invoke envelope emitted by this fixture.
    const body = JSON.parse(request.postData() ?? '{}') as { channel?: string; args?: JsonValue[] };
    let result: JsonValue = null;

    if (handleInvoke && body.channel) {
      let handled: JsonValue | undefined;
      try {
        handled = handleInvoke(body.channel, body.args ?? []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message } }) });
        return;
      }
      if (handled !== undefined) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: handled }) });
        return;
      }
    }

    switch (body.channel) {
      case 'sessions:get-all-with-projects':
        result = [fixtures.project];
        break;
      case 'panels:list':
        result = fixtures.panels;
        break;
      case 'panels:getActive':
        result = fixtures.panels[0];
        break;
      case 'remote:pwa-affordances':
        result = fixtures.affordances;
        break;
      case 'projects:list-branches':
        result = [
          { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
          { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
          { name: 'animations-for-the-pane-web-app', isCurrent: true, hasWorktree: true, isRemote: false },
        ];
        break;
      case 'projects:detect-branch':
        result = 'main';
        break;
      case 'panels:checkInitialized':
        result = true;
        break;
      case 'panels:get-output':
        result = TERMINAL_SCROLLBACK;
        break;
      case 'runpane:ports:list':
        // A host off a cloud Session: the Ports row stays hidden.
        result = { ok: true, available: false, scheme: 'https', autoOpen: false, ports: [], suggested: [], manifests: [] };
        break;
      default:
        // Panel mutations and terminal writes acknowledge without doing work;
        // no clip depends on the host acting on them.
        result = null;
        break;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result }),
    });
  });
}
