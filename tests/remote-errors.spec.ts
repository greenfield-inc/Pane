import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

test('remote terminal creation errors survive healthy connection heartbeats', async ({ page }, testInfo) => {
  await openConnectedRemotePwa(page);
  await page.route('http://anim-pane.test/**', async route => {
    if (route.request().postDataJSON()?.channel !== 'panels:create') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { message: 'Could not create terminal: host is read-only.' } }),
    });
  });
  await page.getByRole('button', { name: 'Add tool' }).click();
  await page.getByRole('menuitem', { name: /Terminal Start a shell/ }).click();
  const error = page.getByText('Could not create terminal: host is read-only.', { exact: false });
  await expect(error).toBeVisible();
  await page.evaluate(() => {
    if (!window.__paneRemoteHeartbeat) throw new Error('No remote heartbeat fixture');
    window.__paneRemoteHeartbeat(new Date(Date.now() - 60_000).toISOString());
  });
  await expect(page.getByText(/seen 1m ago/)).toBeVisible();
  await expect(error).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('action-error-after-heartbeat.png') });
});

for (const scenario of [
  { mode: 'streaming', failure: 'socket', message: 'Failed to connect to Deepgram live transcription.' },
  { mode: 'streaming', failure: 'recorder', message: 'Recorder unavailable.' },
  { mode: 'recorded', failure: 'recorder', message: 'Recorder unavailable.' },
] as const) {
  test(`${scenario.mode} dictation releases the microphone when ${scenario.failure} startup fails`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(({ failure }) => {
      // A browser-owned audio track with no microphone device behind it.
      const context = new AudioContext();
      const stream = context.createMediaStreamDestination().stream;
      let acquisitions = 0;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => { acquisitions += 1; return stream; } },
      });
      Object.defineProperty(window, '__paneVoiceState', {
        value: () => ({ acquisitions, tracks: stream.getTracks().map(track => track.readyState) }),
      });
      class MockRecorder {
        static isTypeSupported() { return true; }
        constructor() { throw new Error('Recorder unavailable.'); }
      }
      class MockSocket extends EventTarget {
        static OPEN = 1;
        static CLOSED = 3;
        static CLOSING = 2;
        readyState = 0;
        constructor() {
          super();
          queueMicrotask(() => {
            this.readyState = failure === 'socket' ? 3 : 1;
            this.dispatchEvent(new Event(failure === 'socket' ? 'error' : 'open'));
          });
        }
        close() { this.readyState = 3; }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: MockRecorder });
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockSocket });
    }, scenario);
    await openConnectedRemotePwa(page, { voiceMode: scenario.mode });
    const start = page.getByRole('button', { name: 'Start voice recording', exact: true });
    await start.click();
    await expect(page.getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(start).toBeEnabled();
    expect(await page.evaluate(() => window.__paneVoiceState?.())).toEqual({ acquisitions: 1, tracks: ['ended'] });
    await page.screenshot({ path: testInfo.outputPath('voice-startup-failure.png') });
  });
}

declare global {
  interface Window {
    __paneVoiceState?: () => { acquisitions: number; tracks: MediaStreamTrackState[] };
  }
}
