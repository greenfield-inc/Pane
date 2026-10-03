import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsManager } from './analyticsManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const send = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockResolvedValue(new Response());

function setup(appPath = '/Applications/Pane.app/Contents/Resources/app.asar') {
  const config = {
    isAnalyticsEnabled: vi.fn(() => true),
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
  }) };
}

afterEach(() => {
  vi.useRealTimers();
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
