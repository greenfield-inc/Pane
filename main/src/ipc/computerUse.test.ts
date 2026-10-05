import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ScriptHosts } from '../services/computerUse/scriptHosts';
import type { AppConfig } from '../types/config';
import { buildScriptHostChild, fakeEngine, PIXEL } from '../test/computerUseFakes';
import { registerComputerUseHandlers } from './computerUse';

const child = buildScriptHostChild();
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-artifacts-'));
afterAll(() => {
  child.cleanup();
  fs.rmSync(artifacts, { recursive: true, force: true });
});

const OFF = "Computer use is off on this machine. Turn it on in Pane's Remote Access settings.";

function setup(enabled: boolean) {
  let config: AppConfig = { computerUse: { enabled } };
  const configManager = Object.assign(new EventEmitter(), { getConfig: () => config });
  const fake = fakeEngine();
  const hosts = new ScriptHosts({ getEngine: () => fake.engine, childEntry: child.entry });
  const registry = new PaneCommandRegistry();
  const opened: unknown[] = [];
  registry.register('runpane:panels:open', (request) => {
    opened.push(request);
    return { ok: true };
  });
  registerComputerUseHandlers(registry, configManager, hosts, (sessionId) => path.join(artifacts, sessionId, 'computer-use'));
  const setEnabled = (next: boolean) => {
    config = { computerUse: { enabled: next } };
    configManager.emit('config-updated', config);
  };
  return { registry, hosts, fake, setEnabled, opened };
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

  it('saves the steps a run records into its Pane and opens the replay in a tab', async () => {
    const { registry, hosts, opened } = setup(true);
    const code = `
      recordStep({ index: 0, action: 'click', args: { app: 'TextEdit', element: 3 }, result: 'clicked', screenshot: ${JSON.stringify(PIXEL)}, at: '2026-10-04T23:00:00.000Z' });
      recordStep({ index: 1, action: 'type_text', args: { text: 'hi' }, result: 'typed', at: '2026-10-04T23:00:01.000Z' });
      return 'done';`;
    const result = await registry.invoke('computer-use:run', [{ connectionId: 'c1', code, sessionId: 'pane-1' }]);

    const replay = path.join(artifacts, 'pane-1', 'computer-use', 'replay.html');
    expect(result).toEqual({ ok: true, text: `done\n\nReplay (2 steps this run): ${replay}`, images: [] });
    const screenshots = fs.readdirSync(path.join(artifacts, 'pane-1', 'computer-use', 'steps'));
    expect(screenshots).toHaveLength(1);
    expect(opened).toEqual([{ paneId: 'pane-1', url: pathToFileURL(replay).href, title: 'Computer use replay', placement: 'tab', noFocus: true, source: 'agent' }]);
    await hosts.stopAll('done');
  });

  it('leaves no replay for a run without steps or without a Pane', async () => {
    const { registry, hosts, opened } = setup(true);
    expect(await registry.invoke('computer-use:run', [{ connectionId: 'c1', code: 'return 1', sessionId: 'pane-2' }])).toEqual({ ok: true, text: '1', images: [] });
    const unattached = await registry.invoke('computer-use:run', [{ connectionId: 'c1', code: `recordStep({ action: 'click' }); return 1` }]);
    expect(unattached).toEqual({ ok: true, text: '1', images: [] });
    expect(fs.existsSync(path.join(artifacts, 'pane-2'))).toBe(false);
    expect(opened).toEqual([]);
    await hosts.stopAll('done');
  });

  it('caps the steps and screenshot size one run saves, and says what it dropped', async () => {
    const { registry, hosts } = setup(true);
    const code = `
      const huge = 'A'.repeat(8 * 1024 * 1024 + 4);
      recordStep({ action: 'click', screenshotPng: huge });
      for (let i = 1; i < 1003; i++) recordStep({ action: 'scroll', screenshotPng: '${PIXEL.base64}' });
      return 'done';`;
    const result = await registry.invoke('computer-use:run', [{ connectionId: 'c1', code, sessionId: 'pane-3' }]);

    const dir = path.join(artifacts, 'pane-3', 'computer-use');
    const replay = path.join(dir, 'replay.html');
    expect(result).toMatchObject({ ok: true, text: `done\n\nReplay (1000 steps this run): ${replay} (3 steps past the 1000-step limit not saved; 1 screenshot over 6 MB not saved)` });
    expect(fs.readFileSync(path.join(dir, 'steps.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1000);
    expect(fs.readdirSync(path.join(dir, 'steps'))).toHaveLength(999);
    await hosts.stopAll('done');
  });
});
