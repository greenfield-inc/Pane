import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ScriptHosts } from '../services/computerUse/scriptHosts';
import type { AppConfig } from '../types/config';
import { buildScriptHostChild, fakeEngine } from '../test/computerUseFakes';
import { registerComputerUseHandlers } from './computerUse';

const child = buildScriptHostChild();
afterAll(child.cleanup);

const OFF = "Computer use is off on this machine. Turn it on in Pane's Remote Access settings.";

function setup(enabled: boolean) {
  let config: AppConfig = { computerUse: { enabled } };
  const configManager = Object.assign(new EventEmitter(), { getConfig: () => config });
  const fake = fakeEngine();
  const hosts = new ScriptHosts({ getEngine: () => fake.engine, childEntry: child.entry });
  const registry = new PaneCommandRegistry();
  registerComputerUseHandlers(registry, configManager, hosts);
  const setEnabled = (next: boolean) => {
    config = { computerUse: { enabled: next } };
    configManager.emit('config-updated', config);
  };
  return { registry, hosts, fake, setEnabled };
}

describe('computer-use channels', () => {
  it('runs a script for a connection and reports it in status', async () => {
    const { registry, hosts } = setup(true);
    const result = await registry.invoke('computer-use:run', [{ connectionId: 'c1', code: 'return 6 * 7' }]);
    expect(result).toEqual({ ok: true, text: '42', images: [] });
    expect(await registry.invoke('computer-use:status')).toMatchObject({ enabled: true, hosts: [{ connectionId: 'c1', running: false }] });
    expect(await registry.invoke('computer-use:reset', [{ connectionId: 'c1' }])).toEqual({ ok: true, reset: true });
    await hosts.stopAll('done');
  });

  it('refuses when computer use is off', async () => {
    const { registry } = setup(false);
    expect(await registry.invoke('computer-use:run', [{ connectionId: 'c1', code: 'return 1' }])).toEqual({ ok: false, text: OFF, images: [] });
  });

  it('turning it off stops a running script, stops the engine, and refuses the next call', async () => {
    const { registry, hosts, fake, setEnabled } = setup(true);
    const running = registry.invoke('computer-use:run', [{ connectionId: 'c1', code: 'await new Promise(() => {})' }]);
    await new Promise((resolve) => setTimeout(resolve, 200));

    setEnabled(false);

    expect(await running).toEqual({ ok: false, text: OFF, images: [] });
    expect(hosts.summaries()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.stops()).toBe(1);
    expect(await registry.invoke('computer-use:run', [{ connectionId: 'c1', code: 'return 1' }])).toEqual({ ok: false, text: OFF, images: [] });
  });

  it('refuses calls that arrive from another machine', async () => {
    const { registry } = setup(true);
    const result = await registry.invokeRemote('computer-use:run', [{ connectionId: 'c1', code: 'return 1' }]);
    expect(result).toEqual({ ok: false, text: 'Computer use runs only from this machine for now.', images: [] });
  });
});
