import { describe, expect, it, vi } from 'vitest';
import type { CloudLocalStartScript, CloudSandboxesSnapshot } from '../../../shared/types/cloudSandboxes';
import type { LocalStartScriptResult } from './cloudLocalStartScript';
import type { CloudProgressListener, CloudSandboxInfo } from '../../../packages/runpane/src/cloud/api';
import {
  CloudSandboxManager,
  CloudSandboxesUnavailableError,
  createLocalStartEnvReader,
  comparePaneVersions,
  getCloudErrorMessage,
  getStartupScriptView,
  resolvePaneReleaseDeb,
  type CloudSandboxLibrary,
} from './cloudSandboxes';

function summary(overrides: Partial<CloudSandboxInfo> = {}): CloudSandboxInfo {
  return {
    hostname: 'rp-alpha',
    label: 'alpha',
    profileId: 'profile-alpha',
    sessionId: 'session-alpha',
    sandboxId: 'sbx-alpha',
    state: 'running',
    providerState: 'running',
    baseUrl: 'https://rp-alpha.tail1234.ts.net',
    transport: 'https',
    size: 'default',
    createdAt: '2026-10-01T09:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const STARTUP_OK = { exitCode: 0, startedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:00:01Z', sha256: 'ab'.repeat(32), timedOut: false };

/** The user's startup script file on this computer, in memory. */
function createStartupScriptFile(initial = '') {
  let script = initial;
  return {
    read: vi.fn(async () => script),
    write: vi.fn(async (next: string) => {
      script = next;
    }),
  };
}

/** The user's local start script on this computer, in memory. */
function createLocalStartScriptFile(script = '') {
  let saved: CloudLocalStartScript = { shell: 'sh', script };
  return {
    read: vi.fn(async () => saved),
    write: vi.fn(async (next: CloudLocalStartScript) => {
      saved = next;
    }),
  };
}

const CONFIGURED = { boat: { configured: true, org: { id: 'team_test', name: 'test' } }, tailscale: { configured: true }, claude: { configured: false }, github: { configured: false }, ready: true };

function createLibrary(overrides: Partial<CloudSandboxLibrary> = {}): CloudSandboxLibrary {
  return {
    getCredentialsStatus: vi.fn(async () => CONFIGURED),
    setup: vi.fn(async () => ({ ...CONFIGURED, claude: { configured: true } })),
    create: vi.fn(async () => summary()),
    list: vi.fn(async () => []),
    stop: vi.fn(async () => summary({ state: 'stopped', startedAt: undefined })),
    start: vi.fn(async () => summary()),
    update: vi.fn(async () => summary()),
    remove: vi.fn(async () => undefined),
    syncAgentDefaults: vi.fn(async (host: string) => summary({ hostname: host })),
    status: vi.fn(async (host: string) => summary({ hostname: host })),
    runStartupScript: vi.fn(async () => STARTUP_OK),
    readStartupLog: vi.fn(async () => 'MARKER\n'),
    ...overrides,
  };
}

function createManager(library: CloudSandboxLibrary | Error, options: {
  appVersion?: string;
  readDaemonVersion?: (profileId: string) => Promise<string | undefined>;
  readDefaultClaudeModel?: () => Promise<string | null>;
  pollIntervalMs?: number;
  startupScriptFile?: ReturnType<typeof createStartupScriptFile>;
  localStartScriptFile?: ReturnType<typeof createLocalStartScriptFile>;
} = {}) {
  const localStartScriptFile = options.localStartScriptFile ?? createLocalStartScriptFile();
  const startupScriptFile = options.startupScriptFile ?? createStartupScriptFile();
  const snapshots: CloudSandboxesSnapshot[] = [];
  const resolvePaneDeb = vi.fn(async (version: string) => ({
    debUrl: `https://example.test/Pane-${version}-linux-amd64.deb`,
    sha256: 'a'.repeat(64),
  }));
  const manager = new CloudSandboxManager({
    loadLibrary: () => library instanceof Error ? Promise.reject(library) : Promise.resolve(library),
    onChange: (snapshot) => snapshots.push(snapshot),
    appVersion: options.appVersion ?? '2.4.146',
    readDaemonVersion: options.readDaemonVersion ?? (async () => '2.4.146'),
    resolvePaneDeb,
    readDefaultClaudeModel: options.readDefaultClaudeModel ?? (async () => null),
    pollIntervalMs: options.pollIntervalMs ?? 10,
    startupScriptFile,
    localStartScriptFile,
  });
  return { manager, snapshots, resolvePaneDeb, startupScriptFile, localStartScriptFile };
}

describe('CloudSandboxManager', () => {
  it('reports the library as unavailable without offering actions', async () => {
    const { manager } = createManager(new CloudSandboxesUnavailableError());

    const snapshot = await manager.refresh();

    expect(snapshot).toMatchObject({ available: false, sandboxes: [], loadError: undefined });
    await expect(manager.create({ name: 'alpha', size: 'default' })).rejects.toThrow('not available');
  });

  it('lists sandboxes with credential status and only booleans for credentials', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', label: 'beta', state: 'stopped' })]) });
    const { manager } = createManager(library);

    const snapshot = await manager.refresh();

    expect(snapshot.available).toBe(true);
    expect(snapshot.credentials).toEqual({ boat: true, tailscale: true, claude: false, github: false, boatOrg: 'test' });
    expect(snapshot.sandboxes.map((row) => [row.id, row.state, row.startedAt])).toEqual([
      ['rp-alpha', 'running', '2026-10-01T10:00:00.000Z'],
      ['rp-beta', 'stopped', undefined],
    ]);
  });

  it('keeps the last rows and shows the error when listing fails', async () => {
    const list = vi.fn<CloudSandboxLibrary['list']>().mockResolvedValueOnce([summary()]).mockRejectedValueOnce(new Error('boat.dev is unreachable'));
    const { manager } = createManager(createLibrary({ list }));
    await manager.refresh();

    const snapshot = await manager.refresh();

    expect(snapshot.loadError).toBe('boat.dev is unreachable');
    expect(snapshot.sandboxes).toHaveLength(1);
  });

  it('streams provisioning steps on a creating row, then lists the new sandbox', async () => {
    let report: CloudProgressListener | undefined;
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const library = createLibrary({
      create: vi.fn((_options, onProgress) => {
        report = onProgress;
        return new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; });
      }),
    });
    const { manager, snapshots } = createManager(library);

    const created = manager.create({ name: 'alpha', size: 'small' });
    await vi.waitFor(() => expect(report).toBeDefined());
    expect(library.create).toHaveBeenCalledWith({ label: 'alpha', size: 'small' }, expect.any(Function));
    report?.({ step: 'sandbox', message: 'Creating the boat sandbox' });
    report?.({ step: 'tailnet', message: 'Joining your tailnet' });
    report?.({ step: 'install', message: 'Installing Pane' });

    expect(snapshots.at(-1)?.sandboxes).toEqual([expect.objectContaining({
      id: 'create:alpha',
      state: 'creating',
      size: 'small',
      steps: [
        { step: 'sandbox', state: 'done', message: 'Creating the boat sandbox' },
        { step: 'tailnet', state: 'done', message: 'Joining your tailnet' },
        { step: 'install', state: 'start', message: 'Installing Pane' },
      ],
    })]);
    report?.({ step: 'done', message: 'Ready' });
    expect(snapshots.at(-1)?.sandboxes[0]?.steps?.every((step) => step.state === 'done')).toBe(true);

    finish?.(summary({ size: 'small' }));
    const snapshot = await created;
    expect(snapshot.sandboxes.map((row) => [row.id, row.state])).toEqual([['rp-alpha', 'running']]);
  });

  it('keeps a failed create on its row and retries the same request', async () => {
    const create = vi.fn<CloudSandboxLibrary['create']>()
      .mockRejectedValueOnce(new Error('tailnet: the auth key was refused'))
      .mockResolvedValueOnce(summary());
    const { manager } = createManager(createLibrary({ create }));

    const failed = await manager.create({ name: 'alpha', size: 'default' });
    expect(failed.sandboxes).toEqual([expect.objectContaining({
      id: 'create:alpha',
      state: 'error',
      error: 'tailnet: the auth key was refused',
      failedAction: 'create',
    })]);

    const retried = await manager.retry('create:alpha');

    expect(create).toHaveBeenLastCalledWith({ label: 'alpha', size: 'default' }, expect.anything());
    expect(retried.sandboxes.map((row) => row.id)).toEqual(['rp-alpha']);
  });

  it('drops a failed create row on dismiss', async () => {
    const { manager } = createManager(createLibrary({ create: vi.fn(async () => { throw new Error('quota'); }) }));
    await manager.create({ name: 'alpha', size: 'default' });

    expect(manager.dismiss('create:alpha').sandboxes).toEqual([]);
  });

  it('refuses a second sandbox with an existing name', async () => {
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary()]) }));
    await manager.refresh();

    await expect(manager.create({ name: 'alpha', size: 'default' })).rejects.toThrow('already exists');
  });

  it('marks a row pending while it stops, then shows the stopped state', async () => {
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn(() => new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; })),
    });
    const { manager, snapshots } = createManager(library);
    await manager.refresh();

    const stopped = manager.stop('rp-alpha');
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]?.pending).toBe('stopping'));
    await expect(manager.start('rp-alpha')).rejects.toThrow('busy');

    finish?.(summary({ state: 'stopped' }));
    const snapshot = await stopped;
    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'stopped', pending: undefined, startedAt: undefined });
  });

  it('keeps a failed start on its row and retries it', async () => {
    const start = vi.fn<CloudSandboxLibrary['start']>()
      .mockRejectedValueOnce(new Error('boat resume timed out'))
      .mockResolvedValueOnce(summary());
    // The provider still has it stopped after the failed resume.
    const status = vi.fn<CloudSandboxLibrary['status']>().mockResolvedValue(summary({ state: 'stopped' }));
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' })]), start, status }));
    await manager.refresh();

    const failed = await manager.start('rp-alpha');
    expect(failed.sandboxes[0]).toMatchObject({ state: 'stopped', error: 'boat resume timed out', failedAction: 'start' });

    const retried = await manager.retry('rp-alpha');
    expect(start).toHaveBeenCalledTimes(2);
    expect(retried.sandboxes[0]).toMatchObject({ state: 'running', error: undefined });
  });

  it('removes a row once the library removed the sandbox', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library);
    await manager.refresh();

    const snapshot = await manager.remove('rp-alpha');

    expect(library.remove).toHaveBeenCalledWith('rp-alpha', expect.any(Function));
    expect(snapshot.sandboxes).toEqual([]);
  });

  it('keeps the row with the reason when the library could not confirm the sandbox is gone', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unfinished = "Remove didn't finish: boat still lists rp-alpha's sandbox bx_alpha (idle) 3 minutes after accepting the delete. Try Remove again.";
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      remove: vi.fn(async (_host: string, onProgress?: (progress: { step: string; message: string }) => void) => {
        onProgress?.({ step: 'removing', message: 'Waiting for boat to finish removing alpha...' });
        throw new Error(unfinished);
      }),
    });
    const { manager } = createManager(library);
    await manager.refresh();

    const snapshot = await manager.remove('rp-alpha');

    expect(snapshot.sandboxes).toHaveLength(1);
    expect(snapshot.sandboxes[0]).toMatchObject({ id: 'rp-alpha', error: unfinished, failedAction: 'remove' });
    expect(info).toHaveBeenCalledWith('[cloud] remove rp-alpha: Waiting for boat to finish removing alpha...');
    expect(warn).toHaveBeenCalledWith(`[cloud] remove rp-alpha failed: ${unfinished}`);
  });

  it('offers Update Pane when the daemon reports another version and installs this app\'s', async () => {
    const readDaemonVersion = vi.fn<(profileId: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('2.4.140')
      .mockResolvedValue('2.4.146');
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager, snapshots, resolvePaneDeb } = createManager(library, { readDaemonVersion });
    await manager.refresh();
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({
      daemonVersion: '2.4.140',
      updateAvailable: true,
    }));
    expect(readDaemonVersion).toHaveBeenCalledWith('profile-alpha');

    await manager.update('rp-alpha');

    expect(resolvePaneDeb).toHaveBeenCalledWith('2.4.146');
    expect(library.update).toHaveBeenCalledWith('rp-alpha', {
      debUrl: 'https://example.test/Pane-2.4.146-linux-amd64.deb',
      sha256: 'a'.repeat(64),
    }, expect.any(Function));
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({
      daemonVersion: '2.4.146',
      updateAvailable: false,
    }));
  });

  it('does not read versions from stopped sandboxes or treat an unreachable daemon as an error', async () => {
    const readDaemonVersion = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const library = createLibrary({ list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', profileId: 'profile-beta', state: 'stopped' })]) });
    const { manager } = createManager(library, { readDaemonVersion });

    await manager.refresh();
    await vi.waitFor(() => expect(readDaemonVersion).toHaveBeenCalledTimes(1));

    expect(readDaemonVersion).toHaveBeenCalledWith('profile-alpha');
    expect(manager.getSnapshot().sandboxes.every((row) => !row.error && !row.updateAvailable)).toBe(true);
  });
});

describe('CloudSandboxManager library mapping', () => {
  it('saves credentials through setup and keeps only set/not-set and the wallet name', async () => {
    const library = createLibrary();
    const { manager } = createManager(library);

    const snapshot = await manager.updateCredentials({
      boatApiKey: 'synthetic-key',
      boatOrg: 'test',
      tailscale: { clientId: 'synthetic-id', clientSecret: 'synthetic-secret' },
    });

    expect(library.setup).toHaveBeenCalledWith({
      boatApiKey: 'synthetic-key',
      boatOrg: 'test',
      tailscaleClientId: 'synthetic-id',
      tailscaleClientSecret: 'synthetic-secret',
      claudeToken: undefined,
    });
    expect(snapshot.credentials).toEqual({ boat: true, tailscale: true, claude: true, github: false, boatOrg: 'test' });
    expect(JSON.stringify(snapshot)).not.toContain('synthetic');
  });

  it('shows a sandbox the provider no longer has as an error that can be removed', async () => {
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary({ state: 'gone', providerState: 'gone' })]) }));

    const snapshot = await manager.refresh();

    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'error', error: 'boat.dev no longer has this sandbox.' });
  });

  it.each([
    ['a prerelease .deb matching the prerelease app', '2.4.147~rc.1', '2.4.147-rc.1', false],
    ['the same release', '2.4.147', '2.4.147', false],
    ['an older daemon', '2.4.140', '2.4.147', true],
    ['a newer daemon', '2.4.150', '2.4.147', true],
    ['an older prerelease of the app\'s release', '2.4.147~rc.1', '2.4.147', true],
  ])('offers Update Pane by version, not by text: %s', async (_case, daemonVersion, appVersion, expected) => {
    const library = createLibrary({ list: vi.fn(async () => [summary({ daemonVersion })]) });
    const snapshots: CloudSandboxesSnapshot[] = [];
    const manager = new CloudSandboxManager({
      loadLibrary: async () => library,
      onChange: (snapshot) => snapshots.push(snapshot),
      appVersion,
      readDaemonVersion: async () => undefined,
      resolvePaneDeb: vi.fn(),
      readDefaultClaudeModel: async () => null,
    });

    const snapshot = await manager.refresh();

    expect(snapshot.sandboxes[0]).toMatchObject({ daemonVersion, updateAvailable: expected });
  });

  it('falls back to the version the library installed when the daemon cannot be asked', async () => {
    const { manager } = createManager(
      createLibrary({ list: vi.fn(async () => [summary({ daemonVersion: '2.4.140' })]) }),
      { readDaemonVersion: async () => undefined },
    );

    const snapshot = await manager.refresh();

    expect(snapshot.sandboxes[0]).toMatchObject({ daemonVersion: '2.4.140', updateAvailable: true });
  });
});

describe('CloudSandboxManager default Claude model', () => {
  const beta = () => summary({ hostname: 'rp-beta', label: 'beta', profileId: 'profile-beta' });

  it('gives each running sandbox the default once, and again only after the default changes', async () => {
    let model: string | null = 'claude-opus-5-5';
    const library = createLibrary({
      list: vi.fn(async () => [summary(), beta(), summary({ hostname: 'rp-stopped', label: 'stopped', profileId: 'profile-stopped', state: 'stopped' })]),
    });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => model });

    await manager.refresh();
    await vi.waitFor(() => expect(library.syncAgentDefaults).toHaveBeenCalledTimes(2));
    expect(vi.mocked(library.syncAgentDefaults).mock.calls.map(([host]) => host).sort()).toEqual(['rp-alpha', 'rp-beta']);

    await manager.syncDefaultClaudeModel();
    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(2);

    model = 'claude-sonnet-5-5';
    await manager.syncDefaultClaudeModel();
    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(4);
  });

  it('never reads the default (which can run the user\'s claude) without a running sandbox', async () => {
    const readDefaultClaudeModel = vi.fn(async () => 'opus');
    const empty = createManager(createLibrary(), { readDefaultClaudeModel });
    await empty.manager.refresh();
    await empty.manager.syncDefaultClaudeModel();

    const stoppedOnly = createManager(
      createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' })]) }),
      { readDefaultClaudeModel },
    );
    await stoppedOnly.manager.refresh();
    await stoppedOnly.manager.syncDefaultClaudeModel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readDefaultClaudeModel).not.toHaveBeenCalled();
  });

  it('reads the default once a sandbox is running', async () => {
    const readDefaultClaudeModel = vi.fn(async () => 'opus');
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary()]) }), { readDefaultClaudeModel });

    await manager.refresh();

    await vi.waitFor(() => expect(readDefaultClaudeModel).toHaveBeenCalled());
  });

  it('treats an unknown default (failed detection) as no change, and syncs once the default is known', async () => {
    let model: string | null = null;
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => model });

    await manager.refresh();
    await manager.syncDefaultClaudeModel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(library.syncAgentDefaults).not.toHaveBeenCalled();

    model = 'claude-opus-5-5';
    await manager.syncDefaultClaudeModel();
    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1);
  });

  it('keeps the last synced default through a failed detection', async () => {
    let model: string | null = 'claude-opus-5-5';
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => model });
    await manager.refresh();
    await vi.waitFor(() => expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1));

    model = null;
    await manager.syncDefaultClaudeModel();
    model = 'claude-opus-5-5';
    await manager.syncDefaultClaudeModel();
    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1);

    model = 'claude-sonnet-5-5';
    await manager.syncDefaultClaudeModel();
    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(2);
  });

  it('keeps the last synced default through a start while the default is unknown', async () => {
    let model: string | null = 'claude-opus-5-5';
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => model });
    await manager.refresh();
    await vi.waitFor(() => expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1));

    model = null;
    await manager.start('rp-alpha');
    model = 'claude-opus-5-5';
    await manager.syncDefaultClaudeModel();

    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1);
  });

  it('does not sync again after create or start, which give the sandbox the default themselves', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' })]) });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => 'opus' });
    await manager.refresh();

    await manager.start('rp-alpha');
    await manager.create({ name: 'beta', size: 'default' });
    await manager.syncDefaultClaudeModel();

    expect(library.syncAgentDefaults).not.toHaveBeenCalled();
  });

  it('tries a failed sync again on the next check', async () => {
    const syncAgentDefaults = vi.fn<CloudSandboxLibrary['syncAgentDefaults']>()
      .mockRejectedValueOnce(new Error('exec failed'))
      .mockResolvedValue(summary());
    const library = createLibrary({ list: vi.fn(async () => [summary()]), syncAgentDefaults });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => 'opus' });
    await manager.refresh();
    await vi.waitFor(() => expect(syncAgentDefaults).toHaveBeenCalledTimes(1));

    await manager.syncDefaultClaudeModel();
    await manager.syncDefaultClaudeModel();

    expect(syncAgentDefaults).toHaveBeenCalledTimes(2);
  });

  it('syncs the host the desktop connected to even when it already has the default, loading the list first', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary(), beta()]) });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => 'opus' });

    await manager.syncDefaultClaudeModel({ profileId: 'profile-beta' });
    await vi.waitFor(() => expect(library.syncAgentDefaults).toHaveBeenCalledTimes(2));
    vi.mocked(library.syncAgentDefaults).mockClear();

    await manager.syncDefaultClaudeModel({ profileId: 'profile-beta' });

    expect(library.syncAgentDefaults).toHaveBeenCalledTimes(1);
    expect(library.syncAgentDefaults).toHaveBeenCalledWith('rp-beta');
  });
});

describe('CloudSandboxManager after a slow or failed host action (D4)', () => {
  const stopTimeout = () => new Error('Sandbox bx_1 did not reach stopped within 120 s (still archiving).');

  it('shows Stopping, with no error, when a Stop fails while the provider is still saving the sandbox', async () => {
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn(async () => { throw stopTimeout(); }),
      status: vi.fn(async () => summary({ state: 'stopping', providerState: 'archiving', startedAt: undefined })),
    });
    const { manager } = createManager(library, { pollIntervalMs: 60_000 });
    await manager.refresh();

    const snapshot = await manager.stop('rp-alpha');

    expect(library.status).toHaveBeenCalledWith('rp-alpha');
    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'stopping', pending: undefined, error: undefined, failedAction: undefined });
  });

  it('keeps reading a stopping sandbox until it is stopped', async () => {
    const status = vi.fn<CloudSandboxLibrary['status']>()
      .mockResolvedValueOnce(summary({ state: 'stopping', providerState: 'archiving' }))
      .mockResolvedValueOnce(summary({ state: 'stopping', providerState: 'archiving' }))
      .mockResolvedValue(summary({ state: 'stopped', providerState: 'archived', startedAt: undefined }));
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn(async () => { throw stopTimeout(); }),
      status,
    });
    const { manager, snapshots } = createManager(library);
    await manager.refresh();

    await manager.stop('rp-alpha');
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]?.state).toBe('stopped'));
    const callsWhenStopped = status.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(callsWhenStopped).toBeGreaterThanOrEqual(3);
    expect(status).toHaveBeenCalledTimes(callsWhenStopped);
    expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({ state: 'stopped', error: undefined });
  });

  it('also follows a sandbox the list reports as stopping', async () => {
    const status = vi.fn<CloudSandboxLibrary['status']>().mockResolvedValue(summary({ state: 'stopped' }));
    const library = createLibrary({ list: vi.fn(async () => [summary({ state: 'stopping' })]), status });
    const { manager, snapshots } = createManager(library);

    await manager.refresh();

    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]?.state).toBe('stopped'));
  });

  it('shows the provider\'s real state plus the error when a failed action left the sandbox running', async () => {
    const library = createLibrary({
      list: vi.fn(async () => [summary({ startedAt: '2026-10-01T10:00:00.000Z' })]),
      stop: vi.fn(async () => { throw new Error('boat refused the stop: busy'); }),
      // The re-read is real: it brings a different start time than the row had.
      status: vi.fn(async () => summary({ startedAt: '2026-10-02T09:00:00.000Z' })),
    });
    const { manager } = createManager(library, { pollIntervalMs: 60_000 });
    await manager.refresh();

    const snapshot = await manager.stop('rp-alpha');

    expect(snapshot.sandboxes[0]).toMatchObject({
      state: 'running',
      startedAt: '2026-10-02T09:00:00.000Z',
      error: 'boat refused the stop: busy',
      failedAction: 'stop',
    });
  });

  it('keeps the error of a failed Start even when the sandbox runs (its daemon may not answer)', async () => {
    const library = createLibrary({
      list: vi.fn(async () => [summary({ state: 'stopped' })]),
      start: vi.fn(async () => { throw new Error('Pane did not answer within 90 s'); }),
      status: vi.fn(async () => summary()),
    });
    const { manager } = createManager(library, { pollIntervalMs: 60_000 });
    await manager.refresh();

    const snapshot = await manager.start('rp-alpha');

    expect(snapshot.sandboxes[0]).toMatchObject({ state: 'running', error: 'Pane did not answer within 90 s', failedAction: 'start' });
  });

  it('never shows the pre-Stop Running row when the provider cannot be read either, and keeps asking', async () => {
    const status = vi.fn<CloudSandboxLibrary['status']>()
      .mockRejectedValueOnce(new Error('boat.dev is unreachable'))
      .mockRejectedValueOnce(new Error('boat.dev is unreachable'))
      .mockResolvedValue(summary({ state: 'stopping', providerState: 'archiving' }));
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn(async () => { throw stopTimeout(); }),
      status,
    });
    const { manager, snapshots } = createManager(library);
    await manager.refresh();

    const snapshot = await manager.stop('rp-alpha');

    expect(snapshot.sandboxes[0]).toMatchObject({ stateUnknown: true, failedAction: 'stop' });
    expect(snapshot.sandboxes[0]?.error).toContain('did not reach stopped');
    // Once the provider answers, the row is what it says: still saving, so Stopping and no error.
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({ state: 'stopping', stateUnknown: undefined, error: undefined }));
  });

  it('shows the library\'s progress, such as "Saving the sandbox…", while a Stop is in flight', async () => {
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const library = createLibrary({
      list: vi.fn(async () => [summary()]),
      stop: vi.fn((_host: string, onProgress?: CloudProgressListener) => {
        onProgress?.({ step: 'stopping', message: 'Saving the sandbox…' });
        return new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; });
      }),
    });
    const { manager, snapshots } = createManager(library, { pollIntervalMs: 60_000 });
    await manager.refresh();

    const stopped = manager.stop('rp-alpha');
    await vi.waitFor(() => expect(snapshots.at(-1)?.sandboxes[0]).toMatchObject({ pending: 'stopping', progress: 'Saving the sandbox…' }));
    finish?.(summary({ state: 'stopped' }));

    expect((await stopped).sandboxes[0]).toMatchObject({ state: 'stopped', pending: undefined, progress: undefined });
  });
});

describe('comparePaneVersions', () => {
  it('orders releases by number', () => {
    expect(comparePaneVersions('2.4.147', '2.4.147')).toBe(0);
    expect(comparePaneVersions('2.4.146', '2.4.147')).toBe(-1);
    expect(comparePaneVersions('2.10.0', '2.9.9')).toBe(1);
  });

  it('treats the .deb\'s ~ prerelease and the app\'s - prerelease as the same version', () => {
    expect(comparePaneVersions('2.4.147~rc.1', '2.4.147-rc.1')).toBe(0);
    expect(comparePaneVersions('2.4.147~nightly.20261001', '2.4.147-nightly.20261001')).toBe(0);
  });

  it('ignores a leading v, a Debian epoch and build metadata', () => {
    expect(comparePaneVersions('v2.4.147', '2.4.147')).toBe(0);
    expect(comparePaneVersions('1:2.4.147~rc.1', '2.4.147-rc.1+g9fd43ee6')).toBe(0);
  });

  it('ranks a prerelease below its release and orders prereleases by semver', () => {
    expect(comparePaneVersions('2.4.147~rc.1', '2.4.147')).toBe(-1);
    expect(comparePaneVersions('2.4.147', '2.4.147-rc.1')).toBe(1);
    expect(comparePaneVersions('2.4.147-rc.2', '2.4.147~rc.10')).toBe(-1);
    expect(comparePaneVersions('2.4.147-rc', '2.4.147-rc.1')).toBe(-1);
    expect(comparePaneVersions('2.4.147-1', '2.4.147-alpha')).toBe(-1);
  });

  it('compares unparseable versions as text', () => {
    expect(comparePaneVersions('dev', 'dev')).toBe(0);
    expect(comparePaneVersions('dev', '2.4.147')).not.toBe(0);
  });
});

describe('getCloudErrorMessage', () => {
  it('redacts token-shaped strings that reach an error message', () => {
    // Built at runtime so the repository's secret scanners never see a key-shaped literal.
    const key = ['tskey', 'auth', 'k'.repeat(20)].join('-');
    const opaque = 'Z'.repeat(40);

    const message = getCloudErrorMessage(new Error(`join failed with ${key} and ${opaque}`), 'fallback');

    expect(message).toBe('join failed with [redacted] and [redacted]');
  });

  it('keeps hostnames and sandbox ids readable', () => {
    expect(getCloudErrorMessage(new Error('rp-alpha (sbx-0a1b2c3d-4e5f) is stopped'), 'fallback'))
      .toBe('rp-alpha (sbx-0a1b2c3d-4e5f) is stopped');
  });
});

describe('resolvePaneReleaseDeb', () => {
  it('reads the amd64 .deb checksum from the release SHA256SUMS', async () => {
    const hash = 'B'.repeat(64);
    const fetchText = vi.fn(async () => [
      `${'c'.repeat(64)}  Pane-2.4.146-linux-arm64.deb`,
      `${hash} *Pane-2.4.146-linux-amd64.deb`,
    ].join('\n'));

    await expect(resolvePaneReleaseDeb('2.4.146', fetchText)).resolves.toEqual({
      debUrl: 'https://github.com/greenfield-inc/Pane/releases/download/v2.4.146/Pane-2.4.146-linux-amd64.deb',
      sha256: 'b'.repeat(64),
    });
    expect(fetchText).toHaveBeenCalledWith('https://github.com/greenfield-inc/Pane/releases/download/v2.4.146/SHA256SUMS.txt');
  });

  it('refuses a release without a checksum for the .deb', async () => {
    await expect(resolvePaneReleaseDeb('2.4.146', async () => 'nothing here'))
      .rejects.toThrow('no published checksum');
  });
});

describe('CloudSandboxManager startup script', () => {
  const rowOf = (snapshot: CloudSandboxesSnapshot, id = 'rp-alpha') => snapshot.sandboxes.find((row) => row.id === id);

  it('shows the status of the run on create, and a failed run on the row', async () => {
    const failed = { ...STARTUP_OK, exitCode: 2 };
    const { manager } = createManager(createLibrary({ create: vi.fn(async () => summary({ startupScript: failed })) }));

    const snapshot = await manager.create({ name: 'alpha', size: 'default' });

    expect(rowOf(snapshot)?.startupScript).toEqual({ state: 'failed', exitCode: 2 });
  });

  it('after a start, runs the script again only if the boot run used an older one, showing it as running meanwhile', async () => {
    let finish: ((status: typeof STARTUP_OK) => void) | undefined;
    const runStartupScript = vi.fn(() => new Promise<typeof STARTUP_OK>((resolve) => { finish = resolve; }));
    const library = createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' })]), runStartupScript });
    const { manager } = createManager(library);
    await manager.refresh();

    const started = await manager.start('rp-alpha');

    expect(rowOf(started)?.startupScript).toEqual({ state: 'running' });
    await vi.waitFor(() => expect(runStartupScript).toHaveBeenCalledWith('rp-alpha', { onlyIfChanged: true }));
    expect(rowOf(started)?.pending).toBeUndefined();
    finish?.({ ...STARTUP_OK, timedOut: true, exitCode: 124 });
    await vi.waitFor(() => expect(rowOf(manager.getSnapshot())?.startupScript).toEqual({ state: 'failed', exitCode: 124, timedOut: true }));
  });

  it('saves an edit to the local file only, then pushes and runs it on running sandboxes that are not busy', async () => {
    const runStartupScript = vi.fn(async () => STARTUP_OK);
    const library = createLibrary({
      list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', label: 'beta', state: 'stopped' })]),
      runStartupScript,
    });
    const { manager, startupScriptFile } = createManager(library);
    await manager.refresh();

    await manager.saveStartupScript('echo MARKER\n');

    expect(startupScriptFile.write).toHaveBeenCalledWith('echo MARKER\n');
    await expect(manager.getStartupScript()).resolves.toBe('echo MARKER\n');
    await vi.waitFor(() => expect(rowOf(manager.getSnapshot())?.startupScript).toEqual({ state: 'succeeded', exitCode: 0 }));
    expect(runStartupScript).toHaveBeenCalledTimes(1);
    expect(runStartupScript).toHaveBeenCalledWith('rp-alpha', { onlyIfChanged: false });
    expect(rowOf(manager.getSnapshot(), 'rp-beta')?.startupScript).toBeUndefined();
    expect(library.setup).not.toHaveBeenCalled();
  });

  it('shows why a run could not start, and keeps only the latest run\'s result', async () => {
    const results: Array<(status: typeof STARTUP_OK | Error) => void> = [];
    const runStartupScript = vi.fn(() => new Promise<typeof STARTUP_OK>((resolve, reject) => {
      results.push((value) => (value instanceof Error ? reject(value) : resolve(value)));
    }));
    const { manager } = createManager(createLibrary({ list: vi.fn(async () => [summary()]), runStartupScript }));
    await manager.refresh();

    await manager.saveStartupScript('echo one\n');
    await manager.saveStartupScript('echo two\n');
    await vi.waitFor(() => expect(results).toHaveLength(2));
    results[1](new Error('cloud bootstrap step "startup-install" failed: no space left'));
    await vi.waitFor(() => expect(rowOf(manager.getSnapshot())?.startupScript?.state).toBe('error'));
    results[0]({ ...STARTUP_OK, exitCode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rowOf(manager.getSnapshot())?.startupScript).toEqual({
      state: 'error', error: 'cloud bootstrap step "startup-install" failed: no space left',
    });
  });

  it('reads the log of a listed sandbox and forgets the status when it stops', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary()]) });
    const { manager } = createManager(library);
    await manager.refresh();
    await manager.saveStartupScript('exit 1\n');
    await vi.waitFor(() => expect(rowOf(manager.getSnapshot())?.startupScript?.state).toBe('succeeded'));

    await expect(manager.readStartupLog('rp-alpha')).resolves.toBe('MARKER\n');
    await expect(manager.readStartupLog('rp-nope')).rejects.toThrow('Unknown cloud sandbox');

    const stopped = await manager.stop('rp-alpha');
    expect(rowOf(stopped)?.startupScript).toBeUndefined();
  });
});

describe('getStartupScriptView', () => {
  it.each([
    ['no run', null, undefined],
    ['running', { ...STARTUP_OK, exitCode: null, finishedAt: null }, { state: 'running' }],
    ['exit 0', STARTUP_OK, { state: 'succeeded', exitCode: 0 }],
    ['exit 3', { ...STARTUP_OK, exitCode: 3 }, { state: 'failed', exitCode: 3 }],
    ['timed out', { ...STARTUP_OK, exitCode: 124, timedOut: true }, { state: 'failed', exitCode: 124, timedOut: true }],
  ])('%s', (_name, status, view) => {
    expect(getStartupScriptView(status)).toEqual(view);
  });
});

describe('CloudSandboxManager GitHub token', () => {
  const rowOf = (snapshot: CloudSandboxesSnapshot) => snapshot.sandboxes.find((row) => row.id === 'rp-alpha');
  const TOKEN = 'FAKE-GH-TOKEN-main-SECRET';

  it('saves the token through setup and shows only whether it is set', async () => {
    const setup = vi.fn(async () => ({ ...CONFIGURED, github: { configured: true } }));
    const { manager } = createManager(createLibrary({ setup }));

    const snapshot = await manager.updateCredentials({ githubToken: TOKEN });

    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ githubToken: TOKEN }));
    expect(snapshot.credentials.github).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
  });

  it('shows the GitHub sign-in from create and start on the row; no token shows nothing', async () => {
    const create = vi.fn(async () => summary({ github: { state: 'signed-in', user: 'octo-cat' } }));
    const start = vi.fn(async () => summary({ github: { state: 'invalid' } }));
    const { manager } = createManager(createLibrary({ create, start }));

    expect(rowOf(await manager.create({ name: 'alpha', size: 'default' }))?.github).toEqual({ state: 'signed-in', user: 'octo-cat' });
    expect(rowOf(await manager.start('rp-alpha'))?.github).toEqual({ state: 'invalid' });

    start.mockResolvedValueOnce(summary({ github: { state: 'error', message: "Couldn't apply the GitHub token on the sandbox." } }));
    expect(rowOf(await manager.start('rp-alpha'))?.github).toEqual({ state: 'error', message: "Couldn't apply the GitHub token on the sandbox." });

    start.mockResolvedValueOnce(summary({ github: { state: 'none' } }));
    expect(rowOf(await manager.start('rp-alpha'))?.github).toBeUndefined();
  });
});

describe('CloudSandboxManager create row', () => {
  it('shows a sandbox being created once, as its progress, even when a refresh already lists it', async () => {
    let finish: ((value: CloudSandboxInfo) => void) | undefined;
    const list = vi.fn<CloudSandboxLibrary['list']>(async () => []);
    const library = createLibrary({
      list,
      create: vi.fn(() => new Promise<CloudSandboxInfo>((resolve) => { finish = resolve; })),
    });
    const { manager } = createManager(library);
    const created = manager.create({ name: 'alpha', size: 'default' });
    await vi.waitFor(() => expect(finish).toBeDefined());

    // The library saved the host part-way through the create (before the startup script ran), so a refresh lists it.
    list.mockResolvedValue([summary()]);
    const during = await manager.refresh();

    expect(during.sandboxes.map((row) => [row.id, row.state])).toEqual([['create:alpha', 'creating']]);
    finish?.(summary());
    const after = await created;
    expect(after.sandboxes.map((row) => [row.id, row.state])).toEqual([['rp-alpha', 'running']]);
  });
});

const LOCAL_SECRET = 'FAKE-LOCAL-ENV-main-SECRET';

function runnerResult(overrides: Partial<LocalStartScriptResult> = {}): LocalStartScriptResult {
  return {
    ok: true, env: new Map([['DOPPLER_TOKEN', LOCAL_SECRET]]), keys: ['DOPPLER_TOKEN'], reservedKeys: [], skippedLines: 0,
    exitCode: 0, timedOut: false, failureSummary: null, ...overrides,
  };
}

describe('createLocalStartEnvReader', () => {
  const format = (env: Map<string, string>) => [...env].map(([name, value]) => `export ${name}='${value}'\n`).join('');

  it.each([
    ['ok', runnerResult({ reservedKeys: ['PATH'] }), { status: { state: 'ok', keys: 1, reserved: ['PATH'] }, envFile: `export DOPPLER_TOKEN='${LOCAL_SECRET}'\n` }],
    ['no variables printed: the sandbox loses the old ones', runnerResult({ env: new Map(), keys: [] }), { status: { state: 'ok', keys: 0, reserved: [] }, envFile: '' }],
    ['timed out: keep the old ones', runnerResult({ ok: false, timedOut: true, exitCode: null, failureSummary: 'Local start script timed out after 60 s (0 keys read).' }),
      { status: { state: 'timeout', seconds: 60 }, envFile: null }],
    ['exit 2: keep the old ones', runnerResult({ ok: false, exitCode: 2, failureSummary: 'Local start script exited with code 2 (1 key read).' }),
      { status: { state: 'failed', exitCode: 2 }, envFile: null }],
    ['could not start', runnerResult({ ok: false, exitCode: null, env: new Map(), keys: [], failureSummary: "Couldn't start PowerShell for the local start script." }),
      { status: { state: 'error', message: "Couldn't start PowerShell for the local start script." }, envFile: null }],
  ])('%s', async (_name, result, expected) => {
    const run = vi.fn(async () => result);
    const read = createLocalStartEnvReader({ file: createLocalStartScriptFile('echo DOPPLER_TOKEN=x'), run, format });
    const env = await read();
    expect(env).toEqual(expected);
    expect(run).toHaveBeenCalledWith('echo DOPPLER_TOKEN=x', { shell: 'sh', timeoutMs: 60_000 });
    expect(JSON.stringify(env.status)).not.toContain(LOCAL_SECRET);
  });

  it('runs nothing without a script, and the sandbox loses the old variables', async () => {
    const run = vi.fn(async () => runnerResult());
    const read = createLocalStartEnvReader({ file: createLocalStartScriptFile('   \n'), run, format });
    await expect(read()).resolves.toEqual({ status: { state: 'none' }, envFile: '' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('CloudSandboxManager local start script', () => {
  const rowOf = (snapshot: CloudSandboxesSnapshot, id = 'rp-alpha') => snapshot.sandboxes.find((row) => row.id === id);

  it('saves the script on this computer only: nothing reaches any running sandbox', async () => {
    const library = createLibrary({ list: vi.fn(async () => [summary(), summary({ hostname: 'rp-beta', label: 'beta' })]) });
    const { manager, localStartScriptFile } = createManager(library);
    expect((await manager.refresh()).localStartScriptSet).toBe(false);

    const snapshot = await manager.saveLocalStartScript({ shell: 'sh', script: 'echo DOPPLER_TOKEN=$(doppler configure get token --plain)' });

    expect(localStartScriptFile.write).toHaveBeenCalledWith({ shell: 'sh', script: 'echo DOPPLER_TOKEN=$(doppler configure get token --plain)' });
    expect(snapshot.localStartScriptSet).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const call of [library.start, library.create, library.runStartupScript, library.syncAgentDefaults, library.update]) expect(call).not.toHaveBeenCalled();
    await expect(manager.getLocalStartScript()).resolves.toEqual({ shell: 'sh', script: 'echo DOPPLER_TOKEN=$(doppler configure get token --plain)' });
    expect((await manager.saveLocalStartScript({ shell: 'sh', script: '  ' })).localStartScriptSet).toBe(false);
  });

  it('shows a failed, timed-out or unrun local start script on the row of the sandbox that ran it', async () => {
    const start = vi.fn(async () => summary({ localStart: { state: 'failed', exitCode: 2 } }));
    const library = createLibrary({ list: vi.fn(async () => [summary({ state: 'stopped' }), summary({ hostname: 'rp-beta', label: 'beta' })]), start });
    const { manager } = createManager(library);
    await manager.refresh();

    const failed = await manager.start('rp-alpha');
    expect(rowOf(failed)?.localStart).toEqual({ state: 'failed', exitCode: 2 });
    expect(rowOf(failed, 'rp-beta')?.localStart).toBeUndefined();

    start.mockResolvedValueOnce(summary({ localStart: { state: 'timeout', seconds: 60 } }));
    expect(rowOf(await manager.start('rp-alpha'))?.localStart).toEqual({ state: 'timeout', seconds: 60 });
    start.mockResolvedValueOnce(summary({ localStart: { state: 'ok', keys: 1, reserved: ['PATH'] } }));
    expect(rowOf(await manager.start('rp-alpha'))?.localStart).toEqual({ state: 'ok', reserved: ['PATH'] });
    start.mockResolvedValueOnce(summary({ localStart: { state: 'ok', keys: 1, reserved: [] } }));
    expect(rowOf(await manager.start('rp-alpha'))?.localStart).toBeUndefined();
  });
});

describe('CloudSandboxManager after a start that reports GitHub and local start states', () => {
  it('still remembers the Claude model the start gave the sandbox', async () => {
    const syncAgentDefaults = vi.fn(async (host: string) => summary({ hostname: host }));
    const library = createLibrary({
      list: vi.fn(async () => [summary({ state: 'stopped' })]),
      start: vi.fn(async () => summary({ github: { state: 'signed-in', user: 'octo-cat' }, localStart: { state: 'ok', keys: 1, reserved: [] } })),
      syncAgentDefaults,
    });
    const { manager } = createManager(library, { readDefaultClaudeModel: async () => 'claude-opus-5-5' });
    await manager.refresh();
    await manager.start('rp-alpha');

    await manager.syncDefaultClaudeModel();

    expect(syncAgentDefaults).not.toHaveBeenCalled();
  });
});
