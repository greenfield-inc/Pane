import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { agentFarmConfigRoot, bundledAgentFarm, bundledAgentFarmProcess } from '../services/agentFarm/bundledAgentFarm';
import { readProfilesSwitchFrom } from '../services/agentFarm/profilesFeature';
import { writeRecoveryNote } from '../services/agentFarm/agentFarmRecovery';
import { readProfileSync } from '../services/agentFarm/profileSyncFile';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PROFILE_SYNC_CHANNELS, PROFILE_SYNC_OFF_CODE } from '../../../shared/types/profileSync';
import { profileSync, registerProfileHandlers } from './profiles';
import type { AppServices } from './types';
import type { ConfigManager } from '../services/configManager';
import type { AppConfig } from '../types/config';

/** The Profiles tab's channels (T-63 PR 5) behind the Profiles switch (D-474). */

type Handler = Parameters<IpcMain['handle']>[1];

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: each fixture supplies every member the profile handlers and sync service read (getConfig, the config-updated event).
  return value as Contract;
}

const temporary: string[] = [];
afterEach(() => {
  readProfilesSwitchFrom(() => undefined);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// SAFETY: the profiles handlers never read their invoke event.
const event = {} as IpcMainInvokeEvent;

function register(paneDir: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain: Pick<IpcMain, 'handle'> = { handle: (channel, handler) => { handlers.set(channel, handler); } };
  // SAFETY: the handlers read only orchestrationSessionManager, which may be absent.
  registerProfileHandlers(ipcMain, {} as AppServices, paneDir);
  return handlers;
}

const CALLS: Array<[string, unknown[]]> = [
  ['profiles:list', []],
  ['profiles:read', ['labtest', 'plugin.yaml']],
  ['profiles:save', ['labtest', [{ path: 'agents/x.md', content: 'x' }]]],
  ['profiles:new-profile', ['researcher', 'claude']],
  ['profiles:new-file', ['labtest', 'writer', 'skill', 'recap']],
  ['profiles:restore', ['greenfield']],
  ['profiles:photos', []],
  ['profiles:set-photo', ['labtest/writer', 'iVBORw0KGgo=']],
  ['profiles:remove-photo', ['labtest/writer']],
  ['profiles:set-details', ['labtest', 'writer', { title: 'x', description: 'y' }]],
  ['profiles:parse-yaml', ['a: 1']],
  // The saved-aside plugin notice (#1740 review F-3).
  ['profiles:dismiss-recovery', ['greenfield-0.0.9-2026-11-27T00-00-00-000Z']],
  ['profiles:open-recovery', ['greenfield-0.0.9-2026-11-27T00-00-00-000Z']],
  // Sync (PR 6).
  ['profiles:sync-status', []],
  ['profiles:sync-now', []],
];

describe('the Profiles channels', () => {
  it('refuse every call while Profiles is off, and write nothing', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: false }));
    const handlers = register(paneDir);
    expect([...handlers.keys()].sort()).toEqual(CALLS.map(([channel]) => channel).sort());
    for (const [channel, args] of CALLS) {
      const answer = await handlers.get(channel)!(event, ...args);
      expect(answer, channel).toMatchObject({ success: false, error: expect.stringContaining('Profiles is off on this computer') });
    }
    expect(existsSync(path.join(paneDir, 'agent-farm')) ? readdirSync(path.join(paneDir, 'agent-farm')) : []).toEqual([]);
  });

  it('answer once Profiles is on', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
    const handlers = register(paneDir);
    expect(await handlers.get('profiles:parse-yaml')!(event, 'a: 1')).toEqual({ success: true, data: { data: { a: 1 } } });
    expect(await handlers.get('profiles:photos')!(event)).toEqual({ success: true, data: { profiles: {}, sources: {}, titles: {} } });
    expect(await handlers.get('profiles:list')!(event)).toMatchObject({ success: true, data: { plugins: [] } });
  });

  it('list a saved-aside plugin until its notice is dismissed (#1740 review F-3)', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
    const id = 'greenfield-0.0.9-2026-11-27T10-00-00-000Z';
    const folder = path.join(paneDir, 'agent-farm', 'recovered', id);
    mkdirSync(folder, { recursive: true });
    await writeRecoveryNote(folder, { plugin: 'greenfield', version: '0.0.9', reason: 'unknown variant opus' });
    const handlers = register(paneDir);
    expect(await handlers.get('profiles:list')!(event)).toMatchObject({ success: true, data: { recovered: [{ id, plugin: 'greenfield', folder }] } });
    expect(await handlers.get('profiles:dismiss-recovery')!(event, id)).toEqual({ success: true, data: undefined });
    expect(await handlers.get('profiles:list')!(event)).toEqual({ success: true, data: expect.not.objectContaining({ recovered: expect.anything() }) });
    expect(await handlers.get('profiles:open-recovery')!(event, '../plugins')).toMatchObject({ success: false, error: expect.stringContaining('Pane has no saved copy') });
  });

  it('sync answers other computers only while Profiles is on, and records nothing while it is off (PR 6)', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    let on = false;
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: on }));
    const registry = new PaneCommandRegistry();
    const handlers = new Map<string, Handler>();
    const ipcMain: Pick<IpcMain, 'handle'> = { handle: (channel, handler) => { handlers.set(channel, handler); } };
    // SAFETY: the handlers read only orchestrationSessionManager and configManager, which may be absent.
    registerProfileHandlers(ipcMain, {} as AppServices, paneDir, registry);
    for (const channel of Object.values(PROFILE_SYNC_CHANNELS)) {
      await expect(registry.invoke(channel, [{}]), channel).rejects.toMatchObject({ code: PROFILE_SYNC_OFF_CODE });
    }
    expect(existsSync(path.join(paneDir, 'agent-farm', 'sync.json'))).toBe(false);
    on = true;
    expect(await registry.invoke(PROFILE_SYNC_CHANNELS.state, [{}])).toMatchObject({ plugins: {} });
  });

  it('starts syncing as soon as the switch goes back on (PR 6 QA)', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    let on = true;
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: on }));
    const configManager = partial<ConfigManager>(Object.assign(new EventEmitter(), { getConfig: () => partial<AppConfig>({ sessionProfilesEnabled: on, machineId: 'a-id' }) }));
    registerProfileHandlers({ handle: () => undefined }, partial<AppServices>({ configManager }), paneDir);
    const service = profileSync();
    if (!service) throw new Error('expected the profile sync service');
    const request = vi.spyOn(service.coordinator, 'request');
    service.start(null);
    request.mockClear();
    on = false;
    configManager.emit('config-updated');
    on = true;
    configManager.emit('config-updated');
    expect(request).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('records and syncs a plugin installed outside Pane while it runs, without a save in the tab (T-63 build 11)', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
    register(paneDir);
    const sync = profileSync()!;
    sync.start(null);
    try {
      // The first sync, on start, has run and found nothing to record.
      await vi.waitFor(() => expect(sync.coordinator.status().lastSyncAt).toBeDefined(), { timeout: 5_000 });
      // `agent-farm plugin install <path> --config-root <PANE_DIR>/agent-farm`, run in a terminal.
      const source = path.join(mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-src-')), 'outside');
      temporary.push(path.dirname(source));
      for (const [relative, content] of Object.entries({ 'plugin.yaml': 'name: outside\nversion: 0.1.0\ncli_major: 0\n', 'profiles/writer.yaml': 'agent: writer\n', 'agents/writer.md': '---\nharness: claude\nmodel: claude-opus-5-5\ndescription: Drafts posts\n---\n\n# Writer\n\nMarker: APPLE\n' })) {
        mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
        writeFileSync(path.join(source, relative), content);
      }
      const run = bundledAgentFarmProcess(bundledAgentFarm()!, ['plugin', 'install', source], agentFarmConfigRoot(paneDir));
      await promisify(execFile)(run.executable, run.args, { env: run.env });
      // Its record is what your other computers read: without one it never reaches them.
      await vi.waitFor(async () => expect((await readProfileSync(agentFarmConfigRoot(paneDir))).plugins.outside).toMatchObject({ state: 'saved', machine: 'unknown' }), { timeout: 10_000, interval: 100 });
    } finally {
      sync.stop();
    }
  }, 20_000);

  it('watches for changes outside Pane only while Profiles is on', () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-ipc-'));
    temporary.push(paneDir);
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: false }));
    register(paneDir);
    const sync = profileSync()!;
    const watchOutside = vi.spyOn(sync.host, 'watchOutside');
    sync.start(null);
    sync.stop();
    expect(watchOutside).not.toHaveBeenCalled();
    expect(existsSync(path.join(paneDir, 'agent-farm'))).toBe(false);
  });
});
