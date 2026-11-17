import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { AppServices } from '../../ipc/types';
import { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { sessionWorkspacePath } from '../sessionWorkspace';
import { createBundle, createSnapshot } from './gitSnapshot';
import { MoveImporter, type ImporterTabs, type TargetStatus } from './importer';
import type { MoveManifest, MovePane } from './manifest';

/**
 * The target's build, start and abort against real git repositories and a scratch PANE_DIR, with
 * Pane's tab managers and services replaced by in-memory ones.
 */

let root: string;
let previousPaneDir: string | undefined;
const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv() }).toString().trim();

/** Pane's panels, in memory, as PanelManager keeps them: a permanent tab refuses delete, and creating an existing ID returns it. */
function memoryTabs(): ImporterTabs & { panels: Map<string, ToolPanel> } {
  const panels = new Map<string, ToolPanel>();
  return {
    panels,
    getPanel: id => panels.get(id),
    getPanelsForSession: paneId => [...panels.values()].filter(panel => panel.sessionId === paneId),
    createPanel: async request => {
      const existing = request.id ? panels.get(request.id) : undefined;
      if (existing) return existing;
      const panel: ToolPanel = {
        id: request.id ?? `panel-${panels.size}`, sessionId: request.sessionId, type: request.type, title: request.title ?? '',
        state: { isActive: false, customState: request.initialState?.customState }, metadata: request.metadata ?? { createdAt: '', lastActiveAt: '', position: 0 },
      };
      panels.set(panel.id, panel);
      return panel;
    },
    deletePanel: async id => { if (!panels.get(id)?.metadata.permanent) panels.delete(id); },
    isTerminalInitialized: () => false,
    destroyTerminal: async () => undefined,
    clearPaused: async () => undefined,
    releaseChatMove: async () => undefined,
    forgetPaneTabs: async paneId => { for (const panel of [...panels.values()]) if (panel.sessionId === paneId) panels.delete(panel.id); },
  };
}

interface Row { id: string; name: string; archived: boolean; worktree_path: string; worktree_name: string; project_id: number }

/** The services the importer calls: one project (the target repository), Panes as rows. */
function fakeServices(repo: string, setupGate?: Promise<void>) {
  const rows = new Map<string, Row>();
  const replaced: string[] = [];
  const setMoveMark = vi.fn(async () => undefined);
  const importArriving = vi.fn(async () => undefined);
  const fixture = {
    databaseService: {
      getAllProjects: () => [{ id: 1, name: 'r', path: repo, worktree_folder: null }],
      getProjectEnvVars: () => [],
      getSession: (id: string) => rows.get(id),
      getSessionPanelLayout: () => null,
      setSessionPanelLayout: () => undefined,
      archiveSession: (id: string) => { const row = rows.get(id); if (row) row.archived = true; return !!row; },
      deleteArchivedSessionPermanently: (id: string) => { replaced.push(id); return rows.delete(id); },
    },
    sessionManager: {
      getProjectContextByProjectId: () => ({ pathResolver: undefined }),
      getSession: (id: string) => rows.get(id)?.archived === false ? rows.get(id) : undefined,
      createSessionWithId: (id: string, name: string, worktreePath: string, _prompt: string, worktreeName: string) => {
        if (rows.has(id)) throw new Error(`Session with ID ${id} already exists`);
        rows.set(id, { id, name, archived: false, worktree_path: worktreePath, worktree_name: worktreeName, project_id: 1 });
        return { id };
      },
      emitSessionCreated: () => undefined,
      updateSession: async () => undefined,
      archiveSession: async (id: string) => { const row = rows.get(id); if (row) row.archived = true; },
    },
    worktreeManager: { getWorktreePath: (_project: string, name: string) => path.join(root, 'worktrees', name) },
    taskQueue: { runWorktreeSetup: async () => { await setupGate; } },
    orchestrationSessionManager: { list: async () => ({ sessions: [] }), importArriving, removeArriving: async () => undefined, setMoveMark },
  };
  // SAFETY: the fixture supplies the exact AppServices members the importer reads, with their call shapes.
  const services = fixture as AppServices;
  return { services, rows, replaced, setMoveMark, importArriving };
}

let moveCount = 0;
const newMoveId = () => `0b000000-0000-4000-8000-${String(++moveCount).padStart(12, '0')}`;

function member(id: string): MovePane {
  return {
    id, name: `Pane ${id}`, role: 'member',
    repo: { remote: 'https://example.invalid/o/r.git', identity: null, root: '/a/repos/r', relativeToHome: null, name: 'r' },
    worktreePath: `/a/worktrees/${id}`, worktreeName: id, branch: null, head: null, baseBranch: null, baseCommit: null,
    snapshot: { ref: `refs/pane/move/${id}`, commit: 'from-the-bundle' }, bundle: `panes/${id}.bundle`, layout: null,
    record: { prompt: '', permissionMode: 'ignore', noTool: false }, tabs: [], ignored: [],
  };
}

function manifest(moveId: string, panes: MovePane[], extra: Partial<MoveManifest> = {}): MoveManifest {
  return {
    version: 1, moveId,
    source: { machine: 'A', home: '/a', paneDir: '/a/.pane', platform: 'darwin', paneVersion: '1.0.0', agentVersions: {}, profiles: {}, envNames: [] },
    session: { id: 'sess-1', name: 'S', internalSessionId: '__owner__', associations: [] },
    sessionFolder: { root: '/a/.pane/sessions/sess-1', files: [] },
    panes, approvals: [], files: [],
    ...extra,
  };
}

/** Puts the package where the receiver keeps it and opens the job, as the first chunk would. */
async function stage(importer: MoveImporter, data: MoveManifest, files: Record<string, Buffer | string>): Promise<void> {
  for (const [relative, content] of Object.entries({ ...files, 'manifest.json': JSON.stringify(data) })) {
    const file = importer.receiver.filePath(data.moveId, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  await importer.write({ moveId: data.moveId, path: 'opened', offset: 0, content: '' });
}

async function waitStage(importer: MoveImporter, moveId: string, wanted: Array<TargetStatus['stage']>): Promise<TargetStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const status = await importer.status(moveId);
    if (wanted.includes(status.stage)) return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return importer.status(moveId);
}

describe('MoveImporter', () => {
  let target: string;
  let bundle: Buffer;
  const registry = new PaneCommandRegistry();

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-importer-'));
    previousPaneDir = process.env.PANE_DIR;
    process.env.PANE_DIR = path.join(root, 'pane');
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    fs.writeFileSync(path.join(source, 'a.txt'), 'one\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'base');
    git(root, 'clone', '-q', source, 'target');
    target = path.join(root, 'target');
    git(target, 'remote', 'set-url', 'origin', 'https://example.invalid/o/r.git');
    // The source's uncommitted work, as a move packs it.
    fs.writeFileSync(path.join(source, 'a.txt'), 'two\n');
    await createSnapshot(source, 'refs/pane/move/p1');
    await createBundle(source, ['refs/pane/move/p1'], path.join(root, 'p1.bundle'));
    bundle = fs.readFileSync(path.join(root, 'p1.bundle'));
  });
  afterEach(() => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a binary Session-folder file byte for byte, even without a binary suffix (F-3)', async () => {
    const { services } = fakeServices(target);
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), memoryTabs());
    const moveId = newMoveId();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    await stage(importer, manifest(moveId, [], { sessionFolder: { root: '/a/.pane/sessions/sess-1', files: ['artifact', 'notes.md'] } }), {
      'session/artifact': bytes, 'session/notes.md': 'see /a/.pane/sessions/sess-1/x',
    });
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
    const folder = sessionWorkspacePath('sess-1');
    expect(fs.readFileSync(path.join(folder, 'artifact')).equals(bytes)).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe(`see ${folder}/x`);
  });

  it('refuses a package that carries open approvals, and keeps nothing (F-9)', async () => {
    const { services, importArriving } = fakeServices(target);
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), memoryTabs());
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [], { approvals: [{ id: 'n-1' }] }), {});
    importer.build(moveId);
    const status = await waitStage(importer, moveId, ['built', 'failed']);
    expect(status.stage).toBe('failed');
    expect(status.error?.message).toMatch(/approval/);
    expect(importArriving).not.toHaveBeenCalled();
  });

  it('a failed move back puts back the archived Pane, its tabs and its snapshot ref (F-6)', async () => {
    const { services, rows, replaced } = fakeServices(target);
    const tabs = memoryTabs();
    // What the earlier move away left here: the snapshot ref for Restore, the archived Pane and its tab.
    const previous = git(target, 'rev-parse', 'HEAD');
    git(target, 'update-ref', 'refs/pane/move/p1', previous);
    rows.set('p1', { id: 'p1', name: 'Pane p1', archived: true, worktree_path: path.join(root, 'worktrees', 'p1'), worktree_name: 'p1', project_id: 1 });
    await tabs.createPanel({ id: 't-old', sessionId: 'p1', type: 'terminal', title: 'Old tab', initialState: { customState: { conversationId: 'c-1' } } });
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), tabs);
    const moveId = newMoveId();
    // p1 sets up; p2's bundle is unreadable, so the whole build rolls back.
    await stage(importer, manifest(moveId, [member('p1'), member('p2')]), { 'panes/p1.bundle': bundle, 'panes/p2.bundle': 'not a bundle' });
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('failed');
    // The arriving p1 did replace the archived one before p2 failed.
    expect(replaced).toContain('p1');
    expect(git(target, 'rev-parse', 'refs/pane/move/p1')).toBe(previous);
    expect(rows.get('p1')?.archived).toBe(true);
    expect(tabs.panels.get('t-old')?.state.customState).toEqual({ conversationId: 'c-1' });
    expect(fs.existsSync(path.join(root, 'worktrees', 'p1'))).toBe(false);
  });

  it('a move back gets the arriving Explorer and Diff, not the archived copy\'s permanent ones', async () => {
    const { services, rows } = fakeServices(target);
    const tabs = memoryTabs();
    rows.set('p1', { id: 'p1', name: 'Pane p1', archived: true, worktree_path: path.join(root, 'worktrees', 'p1'), worktree_name: 'p1', project_id: 1 });
    const permanent = { createdAt: '', lastActiveAt: '', position: 0, permanent: true };
    await tabs.createPanel({ id: 'explorer-1', sessionId: 'p1', type: 'explorer', title: 'Explorer', initialState: { customState: { from: 'archive' } }, metadata: permanent });
    const pane = member('p1');
    pane.tabs = [{ id: 'explorer-1', type: 'explorer', title: 'Explorer', metadata: permanent, state: { from: 'arriving' }, working: false, interrupted: false, running: false }];
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), tabs);
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [pane]), { 'panes/p1.bundle': bundle });
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
    expect(tabs.panels.get('explorer-1')?.state.customState).toEqual({ from: 'arriving' });
  });

  it('abort waits for a build in flight, and nothing it made survives (F-7)', async () => {
    let release!: () => void;
    const { services, rows, importArriving } = fakeServices(target, new Promise(resolve => { release = resolve; }));
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), memoryTabs());
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [member('p1')]), { 'panes/p1.bundle': bundle });
    importer.build(moveId);
    // Setup is under way (the Pane exists) when the source cancels.
    for (let attempt = 0; attempt < 300 && !rows.has('p1'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    expect(rows.has('p1') ? 'set up' : JSON.stringify(await importer.status(moveId))).toBe('set up');
    let settled = false;
    const aborted = importer.abort(moveId).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    release();
    expect((await aborted).stage).toBe('aborted');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await importer.status(moveId)).stage).toBe('aborted');
    expect(rows.has('p1')).toBe(false);
    expect(fs.existsSync(path.join(root, 'worktrees', 'p1'))).toBe(false);
    expect(importArriving).not.toHaveBeenCalled();
    expect(importer.start(moveId).stage).toBe('aborted');
  });

  it('a start that fails before any tab starts reports failed, not started, and can be asked again (F-8)', async () => {
    const { services, setMoveMark } = fakeServices(target);
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), memoryTabs());
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, []), {});
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
    setMoveMark.mockRejectedValueOnce(new Error('disk full'));
    importer.start(moveId);
    const failed = await waitStage(importer, moveId, ['started', 'failed']);
    expect(failed).toMatchObject({ stage: 'failed', retryable: true });
    await expect(importer.abort(moveId)).rejects.toThrow(/already started/);
    importer.start(moveId);
    expect((await waitStage(importer, moveId, ['started', 'failed'])).stage).toBe('started');
  });
});
