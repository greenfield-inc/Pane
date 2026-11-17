import { PaneError } from '../../../../shared/paneError';
import type { DeviceDriver } from '../../../../shared/types/devices';

export interface DeviceDriverGateOptions {
  /** The driver a device tab shows now. */
  read(tabId: string): DeviceDriver | undefined;
  /** Shows `driver` in the device tab (undefined clears it). */
  write(tabId: string, driver: DeviceDriver | undefined): Promise<void>;
  /** How long an agent's call waits for the person to hand the device back. Under the CLI's own timeout, so the agent hears why. */
  waitMs: number;
  pollMs: number;
  /** The chip stays this long after an agent's last call, so a run of calls reads as one. */
  lingerMs: number;
}

/**
 * Who drives each device tab: an agent while its device calls run, or the person after Take over.
 * An agent's call waits while the person drives, gives up when its caller goes away, and
 * fails before the CLI's own timeout with ERR_DEVICE_PERSON_DRIVING. A driver left from before
 * Pane started is dropped the first time the tab is seen.
 */
export class DeviceDriverGate {
  private readonly running = new Map<string, number>();
  private readonly lingering = new Map<string, NodeJS.Timeout>();
  /** Tabs whose driver this run of Pane wrote or checked; any other driver is from before a restart. */
  private readonly current = new Set<string>();

  constructor(private readonly options: DeviceDriverGateOptions) {}

  /** The tab's driver, after dropping one left from before Pane started. */
  async driver(tabId: string): Promise<DeviceDriver | undefined> {
    if (!this.current.has(tabId)) {
      this.current.add(tabId);
      if (this.options.read(tabId)) await this.options.write(tabId, undefined);
    }
    return this.options.read(tabId);
  }

  /** Take over (`person`) or hand the device back (`undefined`). */
  async set(tabId: string, driver: DeviceDriver | undefined): Promise<void> {
    this.current.add(tabId);
    await this.options.write(tabId, driver);
  }

  /** Runs an agent's device call as the driver, after waiting for the person to hand the device back. */
  async run<Result>(tabId: string, agent: string, signal: AbortSignal | undefined, work: () => Promise<Result>): Promise<Result> {
    const deadline = Date.now() + this.options.waitMs;
    for (let driver = await this.driver(tabId); driver?.by === 'person'; driver = this.options.read(tabId)) {
      if (signal?.aborted) {
        await this.clearWaiting(tabId, agent);
        throw new PaneError('ERR_DEVICE_CALL_CANCELLED', 'The agent\'s device call was cancelled while the person had the device. Nothing ran.', 'Call it again once the person hands the device back.');
      }
      if (Date.now() >= deadline) {
        await this.clearWaiting(tabId, agent);
        throw new PaneError('ERR_DEVICE_PERSON_DRIVING', `The person took over this device in its tab and has not handed it back in ${Math.round(this.options.waitMs / 1000)} seconds. Nothing ran.`, 'Ask them to press Hand to agent in the device tab, then try again.');
      }
      if (driver.agentWaiting !== agent) await this.options.write(tabId, { by: 'person', agentWaiting: agent });
      await sleep(this.options.pollMs, signal);
    }
    clearTimeout(this.lingering.get(tabId));
    this.running.set(tabId, (this.running.get(tabId) ?? 0) + 1);
    if (this.options.read(tabId)?.by !== 'agent') await this.options.write(tabId, { by: 'agent', agent });
    try {
      return await work();
    } finally {
      const left = (this.running.get(tabId) ?? 1) - 1;
      if (left > 0) this.running.set(tabId, left);
      else {
        this.running.delete(tabId);
        this.lingering.set(tabId, setTimeout(() => {
          this.lingering.delete(tabId);
          if (this.options.read(tabId)?.by === 'agent') void this.options.write(tabId, undefined);
        }, this.options.lingerMs));
      }
    }
  }

  /** The person still drives; the chip stops naming an agent that no longer waits. */
  private async clearWaiting(tabId: string, agent: string): Promise<void> {
    const driver = this.options.read(tabId);
    if (driver?.by === 'person' && driver.agentWaiting === agent) await this.options.write(tabId, { by: 'person' });
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
