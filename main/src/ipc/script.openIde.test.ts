import { afterEach, beforeEach, expect, it } from 'vitest';
import type { IpcMain } from 'electron';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { registerScriptHandlers } from './script';

type OpenIde = (event: null, sessionId: string, ideKey?: string) => Promise<{ success: boolean; error?: string }>;

let worktreePath: string;

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'pane-open-ide-'));
});

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true });
});

function setup(projectCommand: string | null, defaultIdeCommand: string | undefined): OpenIde {
  const handlers = new Map<string, OpenIde>();
  // SAFETY: These fixtures supply precisely the session, project and config boundary this handler reads.
  const services = {
    configManager: { getConfig: () => ({ defaultIdeCommand }) },
    sessionManager: {
      getSession: async () => ({ worktreePath }),
      getProjectForSession: () => ({ open_ide_command: projectCommand }),
    },
  } as AppServices;
  // SAFETY: Registration requires only IpcMain.handle, which this fixture implements.
  const ipcMain = { handle: (channel: string, handler: OpenIde) => handlers.set(channel, handler) } as IpcMain;
  registerScriptHandlers(ipcMain, services, new PaneCommandRegistry());
  const openIde = handlers.get('sessions:open-ide');
  if (!openIde) {
    throw new Error('sessions:open-ide was not registered');
  }
  return openIde;
}

function opened(): string {
  return readFileSync(join(worktreePath, 'opened.txt'), 'utf8').trim();
}

it('opens the default for all projects when the project has no IDE command', async () => {
  const openIde = setup(null, 'echo default > opened.txt');
  expect(await openIde(null, 'session')).toEqual({ success: true });
  expect(opened()).toBe('default');
});

it('prefers the project IDE command over the default for all projects', async () => {
  const openIde = setup('echo project > opened.txt', 'echo default > opened.txt');
  expect(await openIde(null, 'session')).toEqual({ success: true });
  expect(opened()).toBe('project');
});

it('says how to configure an IDE when neither the project nor the app has one', async () => {
  const openIde = setup(null, undefined);
  const result = await openIde(null, 'session');
  expect(result.success).toBe(false);
  expect(result.error).toContain('Project Settings');
  expect(existsSync(join(worktreePath, 'opened.txt'))).toBe(false);
});
