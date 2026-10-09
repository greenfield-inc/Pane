import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig, type RemoteHostTailnetNotice } from '../../../shared/types/remoteDaemon';
import { RemoteHostTailnetMonitor } from './remoteHostTailnet';
import { createFakeTailscale, TAILNET_A, TAILNET_B } from './__fixtures__/fakeTailscale';

function hostConfig(options: { enabled?: boolean; tunnelKind?: 'tailscale' | 'manual' } = {}): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config.enabled = options.enabled ?? true;
  config.host.access = {
    baseUrl: options.tunnelKind === 'manual' ? 'https://pane.example.com' : 'https://parsa-devbox.taila5e94c.ts.net',
    tunnel: { kind: options.tunnelKind ?? 'tailscale', selected: true, tailscaleIp: TAILNET_A.ip },
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
  return config;
}

function createConfigStore(initial: RemoteDaemonConfig) {
  let config = { remoteDaemon: initial };
  return {
    getConfig: () => config,
    updateConfigWith: async (update: (current: typeof config) => Partial<typeof config>) => {
      config = { ...config, ...update(config) };
      return config;
    },
  };
}

describe('RemoteHostTailnetMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-applies the 443 forward and refreshes saved access within a minute of a tailnet switch', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const tailscale = createFakeTailscale({ tailnet: TAILNET_A });
    tailscale.serveRemoteForward(42137);
    const store = createConfigStore(hostConfig());
    const monitor = new RemoteHostTailnetMonitor(store, tailscale.run);
    try {
      await monitor.start();
      expect(tailscale.serveCalls()).toEqual([]);
      expect(store.getConfig().remoteDaemon.host.access?.updatedAt).toBe('2026-09-30T00:00:00.000Z');

      tailscale.switchTailnet(TAILNET_B);
      await vi.advanceTimersByTimeAsync(60_000);
      await monitor.idle();

      expect(tailscale.serveCalls().map(call => call.args)).toEqual([
        ['serve', '--bg', '--tls-terminated-tcp=443', '42137'],
      ]);
      expect(store.getConfig().remoteDaemon.host.access).toMatchObject({
        baseUrl: 'https://parsa-devbox.tail3c2c57.ts.net',
        tunnel: { kind: 'tailscale', tailscaleIp: TAILNET_B.ip },
      });
    } finally {
      monitor.stop();
    }
  });

  it('leaves Serve and saved access alone when the remote host is off or not on Tailscale', async () => {
    for (const config of [hostConfig({ enabled: false }), hostConfig({ tunnelKind: 'manual' })]) {
      const tailscale = createFakeTailscale({ tailnet: TAILNET_B });
      const store = createConfigStore(config);
      const monitor = new RemoteHostTailnetMonitor(store, tailscale.run);
      await monitor.start();
      monitor.stop();

      expect(tailscale.calls).toEqual([]);
      expect(store.getConfig().remoteDaemon.host.access).toEqual(config.host.access);
    }
  });

  it('does not bring back access that was forgotten while it was checking', async () => {
    const tailscale = createFakeTailscale({ tailnet: TAILNET_B });
    const store = createConfigStore(hostConfig());
    const run: typeof tailscale.run = async (command, args, options) => {
      if (args[0] === 'serve' && args[1] === '--bg') {
        const current = store.getConfig().remoteDaemon;
        await store.updateConfigWith(() => ({ remoteDaemon: { ...current, host: { ...current.host, access: undefined } } }));
      }
      return tailscale.run(command, args, options);
    };
    const monitor = new RemoteHostTailnetMonitor(store, run);
    await monitor.start();
    monitor.stop();

    expect(store.getConfig().remoteDaemon.host.access).toBeUndefined();
  });
});

describe('RemoteHostTailnetMonitor notices in Settings', () => {
  function createNoticeSink() {
    let notice: RemoteHostTailnetNotice | null = null;
    return {
      current: () => notice,
      getTailnetNotice: () => notice,
      setTailnetNotice: (next: RemoteHostTailnetNotice | null) => { notice = next; },
    };
  }

  it('says where the host moved and that older codes need replacing', async () => {
    const tailscale = createFakeTailscale({ tailnet: TAILNET_B });
    const notices = createNoticeSink();
    const monitor = new RemoteHostTailnetMonitor(createConfigStore(hostConfig()), tailscale.run, notices);
    await monitor.start();
    monitor.stop();

    expect(notices.current()).toEqual({
      tone: 'info',
      title: `Moved to tailnet ${TAILNET_B.name}`,
      message: expect.stringContaining('New connection codes use https://parsa-devbox.tail3c2c57.ts.net'),
    });
    expect(notices.current()?.message).toContain('create a new code');
  });

  it('shows a problem with its fix and command, then clears it once fixed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const tailscale = createFakeTailscale({ tailnet: TAILNET_B });
    tailscale.serveRemoteForward(9999);
    const notices = createNoticeSink();
    const monitor = new RemoteHostTailnetMonitor(createConfigStore(hostConfig()), tailscale.run, notices);
    try {
      await monitor.start();
      expect(notices.current()).toEqual({
        tone: 'warning',
        title: expect.stringContaining('already forwards to 127.0.0.1:9999'),
        message: expect.stringMatching(/^To fix it: /),
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
      });

      tailscale.serveRemoteForward(42137);
      await vi.advanceTimersByTimeAsync(60_000);
      await monitor.idle();
      expect(notices.current()).toMatchObject({ tone: 'info', title: `Moved to tailnet ${TAILNET_B.name}` });
    } finally {
      monitor.stop();
    }
  });

  it('clears its notice when the remote host is turned off', async () => {
    const notices = createNoticeSink();
    notices.setTailnetNotice({ tone: 'warning', title: 'stale', message: 'To fix it: x' });
    const monitor = new RemoteHostTailnetMonitor(createConfigStore(hostConfig({ enabled: false })), createFakeTailscale().run, notices);
    await monitor.start();
    monitor.stop();

    expect(notices.current()).toBeNull();
  });
});
