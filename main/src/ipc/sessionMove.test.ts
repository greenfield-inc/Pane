import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { SESSION_MOVE_CHANNELS, SESSION_MOVE_TARGET_CHANNELS } from '../../../shared/types/sessionMove';
import type { AppServices } from './types';
import { registerSessionMoveHandlers } from './sessionMove';

describe('Session move channels', () => {
  let root: string;
  let previousPaneDir: string | undefined;
  const registry = new PaneCommandRegistry();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-ipc-'));
    previousPaneDir = process.env.PANE_DIR;
    process.env.PANE_DIR = root;
    const ipcMain = { handle: () => undefined, removeHandler: () => undefined };
    // SAFETY: registration only stores handlers; these tests reach no service before the owner check.
    registerSessionMoveHandlers(ipcMain as IpcMain, {} as AppServices, registry);
  });
  afterAll(() => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuse a teammate on every source and target channel, before anything runs (F-1)', async () => {
    const requests: Array<[string, object]> = [
      [SESSION_MOVE_CHANNELS.start, { sessionId: 's', target: 'b' }],
      [SESSION_MOVE_CHANNELS.check, { sessionId: 's', target: 'b' }],
      [SESSION_MOVE_CHANNELS.status, { sessionId: 's' }],
      [SESSION_MOVE_CHANNELS.cancel, { sessionId: 's' }],
      [SESSION_MOVE_CHANNELS.stopNow, { sessionId: 's' }],
      [SESSION_MOVE_TARGET_CHANNELS.abort, { moveId: 'move-0001' }],
      [SESSION_MOVE_TARGET_CHANNELS.status, { moveId: 'move-0001' }],
    ];
    for (const [channel, request] of requests) {
      await expect(registry.invokeRemote(channel, [request], { teammate: 'sam@example.com' })).rejects.toMatchObject({ code: 'ERR_MOVE_TEAMMATE' });
    }
  });

  it('let the owner\'s own machines through', async () => {
    await expect(registry.invokeRemote(SESSION_MOVE_TARGET_CHANNELS.abort, [{ moveId: 'move-0001' }], {})).resolves.toMatchObject({ stage: 'aborted' });
    await expect(registry.invoke(SESSION_MOVE_CHANNELS.cancel, [{ sessionId: 's' }])).rejects.toMatchObject({ code: 'ERR_MOVE_NONE' });
  });
});
