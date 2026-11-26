import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { readProfilesSwitchFrom } from '../services/agentFarm/profilesFeature';
import { registerProfileHandlers } from './profiles';
import type { AppServices } from './types';

/** The Profiles tab's channels (T-63 PR 5) behind the Profiles switch (D-474). */

type Handler = Parameters<IpcMain['handle']>[1];

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
    expect(await handlers.get('profiles:photos')!(event)).toEqual({ success: true, data: { profiles: {}, plugins: {} } });
    expect(await handlers.get('profiles:list')!(event)).toMatchObject({ success: true, data: { plugins: [] } });
  });
});
