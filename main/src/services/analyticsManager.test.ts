import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsManager } from './analyticsManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const send = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockResolvedValue(new Response());

function setup(appPath = '/Applications/Pane.app/Contents/Resources/app.asar', isInstalledApp = true) {
  const config = {
    isAnalyticsEnabled: vi.fn(() => true),
    getOrCreateAnalyticsInstallId: vi.fn(async () => 'install_11111111-1111-4111-8111-111111111111'),
    isVerbose: () => false,
    getAnalyticsSettings: () => ({
      installId: 'install_11111111-1111-4111-8111-111111111111',
      distinctId: 'email:private@example.com',
      githubUsername: 'private-user',
      gitUserName: 'Private Name',
    }),
  };
  return { config, analytics: new AnalyticsManager(config, {
    fetch: send,
    getVersion: () => '2.4.152',
    getAppPath: () => appPath,
    isInstalledApp: () => isInstalledApp,
  }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  send.mockReset().mockResolvedValue(new Response());
});

describe('app error telemetry', () => {
  it('sends handled CLI failures as ordinary events without account or SDK context', async () => {
    const { analytics } = setup();
    analytics.track('runpane_local_control_failed', {
      action: 'panels:input', status: 'failure', command_ok: false, failure_kind: 'handled',
      error_type: 'Error', error_code: 'EACCES', failure_category: 'permission',
      error: 'secret', input: 'private prompt', repo_path: '/Users/private/repo',
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const options = decodeBoundary(send.mock.calls[0][1], boundary.object({ body: boundary.string }));
    expect(JSON.parse(options.body)).toMatchObject({ event: 'runpane_local_control_failed', properties: {
      action: 'panels:input', error_code: 'EACCES', failure_kind: 'handled',
      distinct_id: 'install:install_11111111-1111-4111-8111-111111111111',
    } });
    expect(options.body).not.toMatch(/secret|private|Users|\$exception|\$current_url|github/);
  });

  it('sends only allowlisted exception context and packaged frames without a renderer', async () => {
    const { analytics } = setup();
    const error = Object.assign(new TypeError('secret token prompt source /Users/private/repo'), { code: 'secret-token' });
    error.stack = 'TypeError: secret token prompt source\n' +
      '    at privateFunction (file:///Applications/Pane.app/Contents/Resources/app.asar/frontend/dist/assets/main-abc123.js:24:8)\n' +
      '    at privateFunction (/Users/private/repo/source.js:9:1)\n' +
      '    at envSecret (node:internal/foo:1:2)\n' +
      '    at doWork (/Applications/Pane.app/Contents/Resources/app.asar/main/dist/main/src/index.js:12:3)';
    analytics.captureException(error, 'react-boundary');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const options = decodeBoundary(send.mock.calls[0][1], boundary.object({ body: boundary.string }));
    const payload = decodeBoundary(JSON.parse(options.body), boundary.jsonObject);
    expect(payload.event).toBe('$exception');
    expect(payload.properties).toMatchObject({
      distinct_id: 'install:install_11111111-1111-4111-8111-111111111111',
      $process_person_profile: false,
      app_version: '2.4.152',
      error_type: 'TypeError',
      error_code: 'unknown',
      source: 'react-boundary',
      $exception_list: [{
        type: 'TypeError', value: 'Pane react-boundary (unknown)',
        mechanism: { handled: true, synthetic: false },
        stacktrace: { type: 'raw', frames: [
          { platform: 'custom', lang: 'javascript', function: '[app]', filename: 'main/dist/main/src/index.js', lineno: 12, colno: 3, in_app: true },
          { platform: 'custom', lang: 'javascript', function: '[app]', filename: 'frontend/dist/assets/main-abc123.js', lineno: 24, colno: 8, in_app: true },
        ] },
      }],
    });
    expect(options.body).not.toMatch(/secret|private|Users|Applications|prompt|source\.js/);
    expect(send.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('honors opt-out before both ordinary events and exceptions', async () => {
    const { config, analytics } = setup();
    config.isAnalyticsEnabled.mockReturnValue(false);
    analytics.track('app_opened');
    analytics.captureException(new Error('private'), 'main-uncaught');
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    config.isAnalyticsEnabled.mockReturnValue(true);
    analytics.captureException(new Error('private'), 'main-uncaught');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('keeps a Windows packaged frame after a malformed file URL without leaking its absolute path', async () => {
    const { analytics } = setup('C:\\Users\\private\\AppData\\Local\\Pane\\resources\\app.asar');
    const error = new TypeError('private prompt');
    error.stack = 'TypeError: private prompt\n' +
      '    at secret (file:///C:/Users/private/%ZZ/frontend/dist/assets/main.js:1:2)\n' +
      '    at secret (file:///C:/Users/private/AppData/Local/Pane/resources/app.asar/frontend/dist/assets/main-abc123.js:17:4)\n' +
      '    at secret (C:\\Users\\private\\repo\\source.js:99:8)';
    analytics.captureException(error, 'renderer-error');
    expect(send).toHaveBeenCalledTimes(1);
    const options = decodeBoundary(send.mock.calls[0][1], boundary.object({ body: boundary.string }));
    const payload = decodeBoundary(JSON.parse(options.body), boundary.jsonObject);
    expect(payload.properties).toMatchObject({ $exception_list: [{ stacktrace: { frames: [
      { platform: 'custom', lang: 'javascript', function: '[app]', filename: 'frontend/dist/assets/main-abc123.js', lineno: 17, colno: 4, in_app: true },
    ] } }] });
    expect(options.body).not.toMatch(/private|Users|AppData|C:|%ZZ|prompt/);
  });

  it('deduplicates crashes, caps an error loop, and starts a new hourly budget', async () => {
    vi.useFakeTimers();
    const { analytics } = setup();
    for (let i = 0; i < 100; i++) analytics.captureException(new Error('ignored'), 'renderer-crash');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    for (let minute = 0; minute < 55; minute += 5) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      analytics.captureException(new Error('ignored'), 'renderer-crash');
      analytics.captureException(new Error('ignored'), 'renderer-oom');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(send).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    analytics.captureException(new Error('ignored'), 'renderer-crash');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(21);
  });

  it('keeps duplicate suppression across an hourly budget reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { analytics } = setup();
    await vi.advanceTimersByTimeAsync(3_599_000);
    analytics.captureException(undefined, 'renderer-crash');
    await vi.advanceTimersByTimeAsync(1_000);
    analytics.captureException(undefined, 'renderer-crash');
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299_000);
    analytics.captureException(undefined, 'renderer-crash');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('bounds simultaneous requests and contains synchronous transport failures', async () => {
    const { analytics } = setup();
    let complete: (response: Response) => void = () => {};
    send.mockReturnValue(new Promise<Response>(resolve => { complete = resolve; }));
    for (const source of ['main-uncaught', 'renderer-error', 'renderer-rejection', 'react-boundary', 'renderer-crash'] as const) {
      expect(() => analytics.captureException(new Error('private'), source)).not.toThrow();
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    complete(new Response());
    await Promise.resolve();
    await Promise.resolve();
    send.mockImplementation(() => { throw new Error('network failure'); });
    expect(() => analytics.captureException(undefined, 'shutdown')).not.toThrow();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
  });
});

describe('install heartbeat', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function heartbeatBody(call: number) {
    const options = decodeBoundary(send.mock.calls[call][1], boundary.object({ body: boundary.string }));
    return decodeBoundary(JSON.parse(options.body), boundary.jsonObject);
  }

  it.each([true, false])('sends only the install ID, version and OS at start and every 24 hours (analytics on: %s)', async (enabled) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    const { config, analytics } = setup();
    config.isAnalyticsEnabled.mockReturnValue(enabled);
    analytics.startHeartbeat();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('https://runpane.com/api/c/capture/');
    expect(heartbeatBody(0)).toEqual({
      api_key: 'phc_wir25CCsjr2NsZGEdlWNdvwcNG1XDjhxc9RyL5KDCf1',
      event: 'app_heartbeat',
      properties: {
        distinct_id: 'install:install_11111111-1111-4111-8111-111111111111',
        app_version: '2.4.152',
        platform: process.platform,
        $process_person_profile: false,
      },
      timestamp: '2026-10-19T12:00:00.000Z',
    });

    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(send).toHaveBeenCalledTimes(3);
    expect(heartbeatBody(2).event).toBe('app_heartbeat');
  });

  it('creates an install ID when the install has none', async () => {
    const { config, analytics } = setup();
    config.getOrCreateAnalyticsInstallId.mockResolvedValue('install_22222222-2222-4222-8222-222222222222');
    analytics.startHeartbeat();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(config.getOrCreateAnalyticsInstallId).toHaveBeenCalled();
    expect(heartbeatBody(0).properties).toMatchObject({ distinct_id: 'install:install_22222222-2222-4222-8222-222222222222' });
  });

  it.each([
    ['DO_NOT_TRACK=1', () => vi.stubEnv('DO_NOT_TRACK', '1'), true],
    ['RUNPANE_TELEMETRY_DISABLED', () => vi.stubEnv('RUNPANE_TELEMETRY_DISABLED', 'yes'), true],
    ['not the installed app', () => {}, false],
  ])('sends nothing with %s', async (_name, arrange, installed) => {
    vi.useFakeTimers();
    arrange();
    const { config, analytics } = setup(undefined, installed);
    analytics.startHeartbeat();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(send).not.toHaveBeenCalled();
    expect(config.getOrCreateAnalyticsInstallId).not.toHaveBeenCalled();
  });

  it('survives failing and hanging requests, and stops on shutdown', async () => {
    vi.useFakeTimers();
    const { analytics } = setup();
    send.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(new Promise<Response>(() => {}));
    expect(() => analytics.startHeartbeat()).not.toThrow();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);

    analytics.stopHeartbeat();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
