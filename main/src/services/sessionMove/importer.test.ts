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
import { settleAfterFreeze, type FreezeTarget } from './afterFreeze';
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
    // The map stands for the saved rows too, which the database sets aside (fakeServices).
    dropPaneTabsFromMemory: async () => undefined,
  };
}

interface Row { id: string; name: string; archived: boolean; worktree_path: string; worktree_name: string; project_id: number }

/** The services the importer calls: one project (the target repository), Panes as rows, tabs as `panels`. */
function fakeServices(repo: string, setupGate?: Promise<void>, panels = new Map<string, ToolPanel>()) {
  const rows = new Map<string, Row>();
  const replaced: string[] = [];
  // Panes SessionManager holds in memory, as it does an archived Pane someone opened.
  const active = new Set<string>();
  const setMoveMark = vi.fn(async () => undefined);
  const importArriving = vi.fn(async () => undefined);
  const rekey = (from: string, to: string, panelIds: Record<string, string>) => {
    const row = rows.get(from);
    if (row) { rows.delete(from); rows.set(to, { ...row, id: to }); }
    for (const [panelFrom, panelTo] of Object.entries(panelIds)) {
      const panel = panels.get(panelFrom);
      if (panel) { panels.delete(panelFrom); panels.set(panelTo, { ...panel, id: panelTo, sessionId: to }); }
    }
  };
  const fixture = {
    databaseService: {
      getAllProjects: () => [{ id: 1, name: 'r', path: repo, worktree_folder: null }],
      getProjectEnvVars: () => [],
      getSession: (id: string) => rows.get(id),
      getSessionPanelLayout: () => null,
      setSessionPanelLayout: () => undefined,
      archiveSession: (id: string) => { const row = rows.get(id); if (row) row.archived = true; return !!row; },
      deleteArchivedSessionPermanently: (id: string) => { replaced.push(id); return rows.delete(id); },
      // As DatabaseService does: the archived row and its tabs move under other ids, and back.
      setArchivedSessionAside: (id: string, asideId: string) => {
        const row = rows.get(id);
        if (!row?.archived) return null;
        const panelIds = Object.fromEntries([...panels.values()].filter(panel => panel.sessionId === id).map(panel => [panel.id, `${panel.id}.${asideId}`]));
        rekey(id, asideId, panelIds);
        return { id, asideId, panelIds, hidden: 0 };
      },
      restoreSetAsideSession: (aside: { id: string; asideId: string; panelIds: Record<string, string> }) =>
        rekey(aside.asideId, aside.id, Object.fromEntries(Object.entries(aside.panelIds).map(([original, moved]) => [moved, original]))),
    },
    sessionManager: {
      getProjectContextByProjectId: () => ({ pathResolver: undefined }),
      getSession: (id: string) => rows.get(id)?.archived === false ? rows.get(id) : undefined,
      createSessionWithId: (id: string, name: string, worktreePath: string, _prompt: string, worktreeName: string) => {
        if (rows.has(id) || active.has(id)) throw new Error(`Session with ID ${id} already exists`);
        rows.set(id, { id, name, archived: false, worktree_path: worktreePath, worktree_name: worktreeName, project_id: 1 });
        return { id };
      },
      forgetSession: (id: string) => { active.delete(id); },
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
  return { services, rows, replaced, active, setMoveMark, importArriving };
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

  it('a failed move back puts back the archived Pane, its tabs and its snapshot ref, and deletes nothing it saved (F-6)', async () => {
    const tabs = memoryTabs();
    const { services, rows, replaced } = fakeServices(target, undefined, tabs.panels);
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
    // The arriving p1 did replace the archived one before p2 failed; only the arriving copy was deleted.
    expect(replaced).toEqual(['p1']);
    expect([...rows.keys()]).toEqual(['p1']);
    expect(git(target, 'rev-parse', 'refs/pane/move/p1')).toBe(previous);
    expect(rows.get('p1')?.archived).toBe(true);
    expect(tabs.panels.get('t-old')?.state.customState).toEqual({ conversationId: 'c-1' });
    expect(fs.existsSync(path.join(root, 'worktrees', 'p1'))).toBe(false);
  });

  it('a move back gets the arriving Explorer and Diff, not the archived copy\'s permanent ones', async () => {
    const tabs = memoryTabs();
    const { services, rows } = fakeServices(target, undefined, tabs.panels);
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

  it('a move back deletes the archive it replaced only once the move commits (F-6)', async () => {
    const tabs = memoryTabs();
    const { services, rows, replaced, active } = fakeServices(target, undefined, tabs.panels);
    rows.set('p1', { id: 'p1', name: 'Pane p1', archived: true, worktree_path: path.join(root, 'worktrees', 'p1'), worktree_name: 'p1', project_id: 1 });
    // Someone looked at the archived Pane here since Pane started, so it is in memory too (QA R3-1).
    active.add('p1');
    await tabs.createPanel({ id: 't-old', sessionId: 'p1', type: 'terminal', title: 'Old tab' });
    const importer = new MoveImporter(services, registry, path.join(root, 'moves'), tabs);
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [member('p1')]), { 'panes/p1.bundle': bundle });
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
    // Built and waiting for the source to freeze: the archive still waits, set aside.
    const aside = `p1.moving-${moveId}`;
    expect(rows.get(aside)?.archived).toBe(true);
    expect(tabs.panels.get(`t-old.${aside}`)).toBeDefined();
    expect(replaced).toEqual([]);
    importer.start(moveId);
    expect((await waitStage(importer, moveId, ['started', 'failed'])).stage).toBe('started');
    expect(replaced).toEqual([aside]);
    expect(rows.get('p1')?.archived).toBe(false);
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

describe('MoveImporter after a restart (F-10, J9)', () => {
  const registry = new PaneCommandRegistry();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-importer-restart-'));
    previousPaneDir = process.env.PANE_DIR;
    process.env.PANE_DIR = path.join(root, 'pane');
    fs.mkdirSync(path.join(root, 'target'));
  });
  afterEach(() => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A Pane that restarts: a new importer on the same folders, its in-memory jobs gone. */
  const restart = (services: AppServices) => new MoveImporter(services, registry, path.join(root, 'moves'), memoryTabs());

  async function built(services: AppServices): Promise<{ moveId: string; importer: MoveImporter }> {
    const importer = restart(services);
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, []), {});
    importer.build(moveId);
    expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
    return { moveId, importer };
  }

  it('restarted after the build, before the start arrived: it still says built, and a resent start completes the move', async () => {
    const { services, setMoveMark } = fakeServices(path.join(root, 'target'));
    const { moveId } = await built(services);
    const after = restart(services);
    expect(await after.status(moveId)).toMatchObject({ stage: 'built', durable: true });
    after.start(moveId);
    expect((await waitStage(after, moveId, ['started', 'failed', 'aborted'])).stage).toBe('started');
    expect(setMoveMark).toHaveBeenCalledWith('sess-1', undefined, 'Moved here from A.');
    // Asked again (a start resent while the answer was lost): still started, nothing runs twice.
    expect(after.start(moveId).stage).toBe('started');
    expect(setMoveMark).toHaveBeenCalledTimes(1);
  });

  it('restarted mid-commit: the start resumes on its own and the move ends started', async () => {
    const { services, setMoveMark } = fakeServices(path.join(root, 'target'));
    const { moveId, importer } = await built(services);
    // The commit is recorded, then Pane quits before the start finishes.
    setMoveMark.mockImplementationOnce(() => new Promise(() => undefined));
    importer.start(moveId);
    expect((await importer.status(moveId)).stage).toBe('starting');
    const after = restart(services);
    await after.resume();
    expect(await after.status(moveId)).toMatchObject({ stage: 'started', durable: true });
    // A committed move can no longer be rolled back.
    await expect(after.abort(moveId)).rejects.toThrow(/already started/);
  });

  it('rolled back after a restart: it proves the roll-back, removes the arriving Session record, and never starts later', async () => {
    const { services } = fakeServices(path.join(root, 'target'));
    const removeArriving = vi.fn(async () => undefined);
    const sessions = [{ id: 'sess-1', move: { state: 'arriving', machine: 'A', moveId: '', at: '' } }];
    Object.assign(services.orchestrationSessionManager!, { list: async () => ({ sessions }), removeArriving });
    const { moveId } = await built(services);
    sessions[0].move.moveId = moveId;
    const after = restart(services);
    expect(await after.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(removeArriving).toHaveBeenCalledWith('sess-1');
    expect(after.start(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(await restart(services).status(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
  });

  it('a move it has no record of was never committed: rolling it back fences it, so it can never start', async () => {
    const { services } = fakeServices(path.join(root, 'target'));
    const importer = restart(services);
    const moveId = newMoveId();
    expect(await importer.status(moveId)).toMatchObject({ stage: 'aborted', durable: true });
    expect(await importer.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    // The package turns up late: the fenced move refuses it, and can't start.
    await expect(stage(importer, manifest(moveId, []), {})).rejects.toThrow(/rolled back/);
    expect(importer.start(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
  });

  it('an abort before the start records the roll-back first, so the source may release its copy', async () => {
    const { services } = fakeServices(path.join(root, 'target'));
    const { moveId, importer } = await built(services);
    expect(await importer.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(await restart(services).status(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
  });

  it('end to end: the source loses its start, the target restarts, and the move still completes on its own', async () => {
    const { services, setMoveMark } = fakeServices(path.join(root, 'target'));
    const { moveId } = await built(services);
    // The link drops the first start; then the target restarts before anything else arrives.
    let target = restart(services);
    let dropped = 0;
    const link: FreezeTarget = {
      status: async () => target.status(moveId),
      start: async () => { if (dropped++ === 0) throw new Error('connection reset'); return target.start(moveId); },
      rollBack: async () => target.abort(moveId),
    };
    let rounds = 0;
    const outcome = await settleAfterFreeze(link, {
      onWait: () => { if (rounds === 1) target = restart(services); },
      stopped: () => (rounds += 1) > 200,
      sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    });
    expect(outcome?.kind).toBe('committed');
    expect(dropped).toBeGreaterThanOrEqual(2);
    expect(setMoveMark).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'move-ledger', `${moveId}.json`), 'utf8')).decision).toBe('started');
  });

  it('end to end: an unreachable target never releases the source', async () => {
    const { services } = fakeServices(path.join(root, 'target'));
    const { moveId } = await built(services);
    const released = vi.fn();
    let rounds = 0;
    const outcome = await settleAfterFreeze({
      status: async () => { throw new Error('timed out'); },
      start: async () => { throw new Error('timed out'); },
      rollBack: async () => { released(); throw new Error('timed out'); },
    }, { onWait: () => undefined, stopped: () => (rounds += 1) > 100, sleep: async () => undefined });
    expect(outcome).toBeUndefined();
    expect(released).not.toHaveBeenCalled();
    // The target still holds the move, undecided, for when contact comes back.
    expect(await restart(services).status(moveId)).toMatchObject({ stage: 'built' });
  });
});
