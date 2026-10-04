import { describe, expect, it, vi } from 'vitest';
import { shutdownBeforeQuit, startHeadlessHost } from './startHeadless';

describe('startHeadlessHost', () => {
  it('starts transcript indexing after the daemon host is ready', async () => {
    const callOrder: string[] = [];
    const host = { shutdown: vi.fn() };

    const result = await startHeadlessHost(
      async () => {
        callOrder.push('host');
        return host;
      },
      {
        async start() {
          callOrder.push('usage');
        },
      },
    );

    expect(result).toBe(host);
    expect(callOrder).toEqual(['host', 'usage']);
  });
});

describe('shutdownBeforeQuit', () => {
  it('holds the quit Electron starts on SIGTERM until the host shuts down', () => {
    let willQuit: ((event: { preventDefault(): void }) => void) | undefined;
    const electronApp = {
      on: vi.fn((_name: 'will-quit', listener: (event: { preventDefault(): void }) => void) => {
        willQuit = listener;
      }),
    };
    const shutdown = vi.fn(async () => undefined);
    const event = { preventDefault: vi.fn() };

    shutdownBeforeQuit(electronApp, shutdown);
    willQuit?.(event);

    expect(electronApp.on).toHaveBeenCalledWith('will-quit', expect.any(Function));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
