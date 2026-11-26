import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatPanelState } from '../../../shared/types/chatTab';
import { decodeChatFiles } from '../../../shared/types/chatTabDecoders';
import type { ToolPanel } from '../../../shared/types/panels';
import type { DiffManifest } from '../../../shared/types/gitDiff';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import type { GitDiffManager } from '../services/gitDiffManager';
import type { SessionManager } from '../services/sessionManager';
import type { WorktreeManager } from '../services/worktreeManager';
import type { Session } from '../types/session';
import type { Project } from '../database/models';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { AppServices } from './types';
import { registerChatTabHandlers } from './chatTabs';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member chat-tab:files reads.
  return value as Contract;
}

const SESSION_PANE = '__orchestration_session_test__';
let base: string;
let worktree: string;
let registry: PaneCommandRegistry;
interface ShownTab { sessionId: string; state: Partial<ChatPanelState> }
let tab: ShownTab;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pane-chat-files-')));
  worktree = path.join(base, 'worktree');
  await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
  await fs.mkdir(path.join(base, 'other'));
  for (const file of ['worktree/README.md', 'worktree/src/a.ts', 'worktree/src/b.ts', 'other/private.txt']) await fs.writeFile(path.join(base, file), '');
  execFileSync('git', ['init', '-q'], { cwd: worktree });
  tab = { sessionId: 'pane-1', state: { cwd: worktree } };
  vi.spyOn(panelManager, 'getPanel').mockImplementation(() => partial<ToolPanel>({
    id: 'chat-1', sessionId: tab.sessionId, type: 'chat',
    state: { isActive: true, customState: { agent: 'claude', launch: { kind: 'agent' }, status: 'idle', cwd: worktree, ...tab.state } },
  }));
  registry = new PaneCommandRegistry();
  registerChatTabHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({
    sessionManager: partial<SessionManager>({
      getSession: id => partial<Session>({ id, worktreePath: worktree }),
      getProjectContext: id => id === 'pane-1' ? { project: partial<Project>({ path: worktree }), pathResolver: new PathResolver({ path: worktree }), commandRunner: new CommandRunner({ path: worktree }) } : null,
    }),
    gitDiffManager: partial<GitDiffManager>({
      getDiffManifest: async () => partial<DiffManifest>({ files: [
        { path: 'src/b.ts', kind: 'modified', additions: 1, deletions: 0, isBinary: false },
        { path: 'src/gone.ts', kind: 'deleted', additions: 0, deletions: 1, isBinary: false },
      ] }),
    }),
    worktreeManager: partial<WorktreeManager>({}),
  }), registry);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});

const files = async (query: string) => decodeChatFiles(await registry.invoke('chat-tab:files', ['chat-1', query]))
  .map(file => `${file.path}${file.isDirectory ? '/' : ''}${file.changed ? ' (changed)' : ''}`);

describe('chat-tab:files', () => {
  it('lists the Pane\'s changed files, then folders, then files, and finds files by name', async () => {
    expect(await files('')).toEqual(['src/b.ts (changed)', 'src/', 'README.md']);
    expect(await files('a.ts')).toEqual(['src/a.ts']);
  });

  it('lists from the tab\'s own folder inside the Pane', async () => {
    tab.state.cwd = path.join(worktree, 'src');
    expect(await files('')).toEqual(['b.ts (changed)', 'a.ts']);
  });

  it('lists nothing for a folder outside the Pane, also through a link', async () => {
    tab.state.cwd = path.join(base, 'other');
    expect(await files('')).toEqual([]);
    expect(await files('private')).toEqual([]);
    if (process.platform === 'win32') return;
    await fs.symlink(path.join(base, 'other'), path.join(worktree, 'linked'));
    tab.state.cwd = path.join(worktree, 'linked');
    expect(await files('private')).toEqual([]);
  });

  it.each(['..', '../other/private', '/etc/hosts', '~/private', 'src/../../other'])('lists nothing for %j', async query => expect(await files(query)).toEqual([]));

  it('lists a Session\'s folder with nothing hidden', async () => {
    tab.sessionId = SESSION_PANE;
    await fs.mkdir(path.join(worktree, '.agent'));
    await fs.writeFile(path.join(worktree, '.agent', 'state.json'), '');
    expect(await files('')).toEqual(['src/', 'README.md']);
    expect(await files('state')).toEqual([]);
  });

  it('refuses Autopilot\'s tab and lists nothing for a Pane with no project', async () => {
    tab.sessionId = 'unknown';
    expect(await files('')).toEqual([]);
    tab.state.autopilotRunId = 'run-1';
    await expect(registry.invoke('chat-tab:files', ['chat-1', ''])).rejects.toThrow('Autopilot\'s chat does not list files.');
  });
});
