import { expect, test } from '@playwright/test';

interface FixtureLogEvent {
  sessionId: string;
  entry: { timestamp: string; level: 'info'; message: string };
}

test('keeps live log history bounded while following the newest output', async ({ page }, testInfo) => {
  page.on('pageerror', error => { throw error; });
  await page.route('**/__session_logs_fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<html class="dark"><body><div id="logs" style="height:600px"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      window.electronAPI = {
        sessions: { getLogs: async () => ({ success: true, data: [] }) },
        events: {
          onSessionLog: callback => { window.emitLog = callback; return () => {}; },
          onSessionLogsCleared: callback => { window.clearLogs = callback; return () => {}; }
        }
      };
      const [{ default: React }, { default: ReactDOM }, { LogsView }, { ThemeContext }] = await Promise.all([
        import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'),
        import('/src/components/panels/logPanel/LogsView.tsx'), import('/src/contexts/themeContextValue.ts')
      ]);
      await import('/src/index.css');
      ReactDOM.createRoot(document.getElementById('logs')).render(React.createElement(ThemeContext.Provider,
        { value: { theme: 'dark' } }, React.createElement(LogsView, { sessionId: 'logs-test', isVisible: true })));
    </script></body></html>`,
  }));
  await page.goto('/__session_logs_fixture');
  await expect(page.getByText('No logs available')).toBeVisible();
  await page.evaluate(() => {
    for (let index = 0; index < 1002; index++) {
      // SAFETY: The isolated page fixture supplies this event entry point.
      (window as typeof window & { emitLog: (data: FixtureLogEvent) => void }).emitLog({
        sessionId: 'logs-test', entry: { timestamp: '2026-01-01T00:00:00Z', level: 'info', message: `line ${index}` },
      });
    }
  });
  await expect(page.locator('.log-line')).toHaveCount(1000);
  await expect(page.locator('.log-line').first()).toHaveText('line 2');
  await expect(page.locator('.log-line').last()).toHaveText('line 1001');
  await page.evaluate(() => {
    // SAFETY: The isolated fixture supplies the preload event entry point.
    (window as typeof window & { emitLog: (data: FixtureLogEvent) => void }).emitLog({
      sessionId: 'logs-test', entry: { timestamp: '2026-01-01T00:00:00Z', level: 'info', message: 'line 1002' },
    });
  });
  await expect(page.locator('.log-line').last()).toHaveText('line 1002');
  await expect(page.locator('.log-line').last()).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('bounded-live-logs.png') });

  await page.evaluate(() => {
    // SAFETY: These entry points model the preload event subscription in the isolated fixture.
    const events = window as typeof window & { clearLogs: (data: { sessionId: string }) => void; emitLog: (data: FixtureLogEvent) => void };
    events.clearLogs({ sessionId: 'logs-test' });
    for (const message of ['a'.repeat(600000), 'b'.repeat(600000)]) {
      events.emitLog({ sessionId: 'logs-test', entry: { timestamp: '2026-01-01T00:00:00Z', level: 'info', message } });
    }
  });
  await expect(page.locator('.log-line')).toHaveCount(1);
  expect(await page.locator('.log-line').textContent()).toBe('b'.repeat(600000));
});
