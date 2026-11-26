import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCustomCommandHandlers } from './customCommands';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { ConfigManager } from '../services/configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { AppConfig } from '../types/config';

interface TestIpcEvent { readonly sender?: { readonly id?: number } }
type Handler = (_event: TestIpcEvent, ...args: PaneCommandValue[]) => PaneCommandValue | Promise<PaneCommandValue>;

const tempDirs: string[] = [];
const sent = vi.fn();

afterEach(async () => {
  sent.mockReset();
  resetPaneRuntimeForTests();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function openConfig(dir?: string): Promise<{ configManager: ConfigManager; dir: string }> {
  const configDir = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'pane-custom-commands-'));
  if (!dir) tempDirs.push(configDir);
  vi.stubEnv('PANE_DIR', configDir);
  const configManager = new ConfigManager();
  await configManager.initialize();
  configManager.stopWatching();
  return { configManager, dir: configDir };
}

async function setup(seed?: Partial<AppConfig>) {
  const { configManager, dir } = await openConfig();
  if (seed) await configManager.updateConfigWith(() => seed);
  const registry = new PaneCommandRegistry();
  const handlers = new Map<string, Handler>();
  registerCustomCommandHandlers({ handle: (channel, listener) => { handlers.set(channel, listener); } }, configManager, registry);
  setPaneRuntime({
    eventSink: { send: sent },
    getConfigManager: () => configManager,
    getPtyHostRuntime: () => null,
    getWebviewContextMap: () => new Map(),
  });
  return { configManager, registry, handlers, dir };
}

describe('runpane custom-commands daemon commands', () => {
  it('lists an empty machine as an empty array', async () => {
    const { registry } = await setup();
    await expect(registry.invoke('runpane:custom-commands:list')).resolves.toEqual({ ok: true, commands: [] });
  });

  it('adds, edits, moves and removes by exact name, and the list survives a restart', async () => {
    const { registry, dir } = await setup();
    await registry.invoke('runpane:custom-commands:add', [{ name: 'Build all', command: 'pnpm build' }]);
    await registry.invoke('runpane:custom-commands:add', [{ name: 'build all', command: 'make', resume: { mode: 'reported' } }]);
    await registry.invoke('runpane:custom-commands:add', [{ name: 'Lint', command: 'pnpm lint' }]);
    await expect(registry.invoke('runpane:custom-commands:update', [{ name: 'Lint', newName: 'Lint fix', command: 'pnpm lint --fix' }]))
      .resolves.toMatchObject({ ok: true, action: 'updated', name: 'Lint fix', position: 3 });
    await expect(registry.invoke('runpane:custom-commands:reorder', [{ name: 'Lint fix', position: 1 }]))
      .resolves.toMatchObject({ ok: true, action: 'moved', position: 1, previousPosition: 3, changed: true });
    await registry.invoke('runpane:custom-commands:update', [{ name: 'build all', resume: null }]);
    await registry.invoke('runpane:custom-commands:remove', [{ name: 'Build all' }]);

    const reopened = await openConfig(dir);
    expect(reopened.configManager.getConfig().customCommands).toEqual([
      { name: 'Lint fix', command: 'pnpm lint --fix' },
      { name: 'build all', command: 'make' },
    ]);
  });

  it('shows the owner the command and both templates verbatim, but keeps them out of results, errors and events', async () => {
    const resume = { mode: 'reported', initialTemplate: 'canary-initial {command}', resumeTemplate: 'canary-resume {sessionId}' } as const;
    const { registry } = await setup({ customCommands: [{ name: 'C', command: 'canary-command', resume }] });
    await expect(registry.invoke('runpane:custom-commands:list')).resolves.toEqual({
      ok: true, commands: [{ position: 1, name: 'C', command: 'canary-command', resume }],
    });
    const results = [
      await registry.invoke('runpane:custom-commands:update', [{ name: 'C', newName: 'D' }]),
      await registry.invoke('runpane:custom-commands:add', [{ name: 'D', command: 'canary-2' }]).catch((error: Error) => error.message),
      await registry.invoke('runpane:custom-commands:update', [{ name: 'D', resume: { mode: 'generated' } }]).catch((error: Error) => error.message),
    ];
    expect(JSON.stringify([results, sent.mock.calls])).not.toMatch(/canary/);
    expect(sent).toHaveBeenCalledWith('remote:settings-changed');
    expect(sent.mock.calls.every(call => call.length === 1)).toBe(true);
  });

  it('refuses a teammate and a read-only device, even for list', async () => {
    const { registry, configManager } = await setup({ customCommands: [{ name: 'A', command: 'a' }] });
    for (const from of [{ teammate: 'someone@example.com' }, { readOnly: true }]) {
      await expect(registry.invokeRemote('runpane:custom-commands:list', [], from)).rejects.toMatchObject({ code: 'ERR_CUSTOM_COMMANDS_OWNER_ONLY' });
      await expect(registry.invokeRemote('runpane:custom-commands:remove', [{ name: 'A' }], from)).rejects.toMatchObject({ code: 'ERR_CUSTOM_COMMANDS_OWNER_ONLY' });
    }
    expect(configManager.getConfig().customCommands).toEqual([{ name: 'A', command: 'a' }]);
  });

  it('lets exactly one of two concurrent adds of the same name win, and keeps both distinct names', async () => {
    const { registry, configManager } = await setup();
    const same = await Promise.allSettled([
      registry.invoke('runpane:custom-commands:add', [{ name: 'Same', command: 'one' }]),
      registry.invoke('runpane:custom-commands:add', [{ name: 'Same', command: 'two' }]),
    ]);
    expect(same.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await Promise.all([
      registry.invoke('runpane:custom-commands:add', [{ name: 'X', command: 'x' }]),
      registry.invoke('runpane:custom-commands:add', [{ name: 'Y', command: 'y' }]),
    ]);
    expect((configManager.getConfig().customCommands ?? []).map(entry => entry.name)).toEqual(['Same', 'X', 'Y']);
  });

  it('a no-op move changes nothing and sends no event', async () => {
    const { registry } = await setup({ customCommands: [{ name: 'A', command: 'a' }] });
    await expect(registry.invoke('runpane:custom-commands:reorder', [{ name: 'A', position: 1 }])).resolves.toMatchObject({ changed: false });
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses a desktop row save once the row holds another entry', async () => {
    const { registry, handlers, configManager } = await setup({ customCommands: [{ name: 'A', command: 'a' }, { name: 'B', command: 'b' }] });
    await registry.invoke('runpane:custom-commands:reorder', [{ name: 'B', position: 1 }]);
    const editRow = handlers.get('config:custom-commands:edit-row')!;
    await expect(editRow({}, { index: 0, expected: { name: 'A', command: 'a' }, next: null })).resolves.toMatchObject({ success: false });
    await expect(editRow({}, { index: 1, expected: { name: 'A', command: 'a' }, next: { name: 'A2', command: 'a' } })).resolves.toMatchObject({ success: true });
    expect(configManager.getConfig().customCommands).toEqual([{ name: 'B', command: 'b' }, { name: 'A2', command: 'a' }]);
  });
});
