import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import { NotifyService } from './notifyService';

describe('NotifyService in-use poll', () => {
  let idleSeconds: number;
  let reads: number;
  let service: NotifyService;
  let config: AppConfig;
  let configManager: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    // Away when Pane starts: the start-up sweep reads that.
    idleSeconds = 600;
    reads = 0;
    config = { machineId: 'mini' };
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return config; }
    }
    configManager = new FakeConfigManager();
    service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: configManager as ConfigManager,
      getMainWindow: () => null,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: true,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      idleSeconds: () => { reads += 1; return idleSeconds; },
    });
    service.queue.setPaneFocused(true);
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does not read whether the computer is in use while nothing waits', async () => {
    reads = 0;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reads).toBe(0);
  });

  it('redraws within 5 seconds when the person leaves after a question arrives, though they came back unpolled', async () => {
    idleSeconds = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    void service.queue.ask({ question: { ui: 'ask', title: 'Ship it?' }, source: { name: 'feature', agent: 'Claude', paneId: 'p1', panelId: 't1' } });
    expect(service.queue.snapshot().stripSurface).toBe('pane');

    const changes = vi.fn();
    service.queue.on('change', changes);
    idleSeconds = 600;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(changes).toHaveBeenCalled();
    expect(service.queue.snapshot().stripSurface).toBeNull();
  });

  it('reads in use again when Approvals come back on with a saved question', async () => {
    idleSeconds = 0;
    // Asked an hour ago, so it is past its quiet grace and on the strip.
    service.queue.addWorkerQuestion({ id: 'q1', question: 'Ship it?', source: { name: 'feature', agent: 'Claude', paneId: 'p1', panelId: 't1' }, at: Date.now() - 3_600_000 });
    const setApprovals = (enabled: boolean) => {
      config = { ...config, notify: { ...config.notify, enabled } };
      configManager.emit('config-updated', config);
    };
    setApprovals(false);
    await vi.advanceTimersByTimeAsync(10_000);
    setApprovals(true);
    reads = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});
