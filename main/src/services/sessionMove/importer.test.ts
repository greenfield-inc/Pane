import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { AppServices } from '../../ipc/types';
import { PaneCommandRegistry } from '../../daemon/commandRegistry';
import { sessionWorkspacePath } from '../sessionWorkspace';
import { createBundle, createSnapshot } from './gitSnapshot';
import { MoveImporter, type ImporterTabs, type TargetStatus } from './importer';
import { gitSteps } from '../../test/gitBudget';
import { settleAfterFreeze, type FreezeTarget } from './afterFreeze';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue } from '../../daemon/commandRegistry';
import type { MoveManifest, MovePane } from './manifest';

/**
 * The target's build, start and abort against real git repositories and a scratch PANE_DIR, with
 * Pane's tab managers and services replaced by in-memory ones.
 */

let root: string;
let previousPaneDir: string | undefined;
const gitEnv = (home: string) => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const gitAt = (home: string, cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(home) }).toString().trim();
const git = (cwd: string, ...args: string[]) => gitAt(root, cwd, ...args);

// Counted git starts in a test body (see test/gitBudget.ts): at most 41 for any test here, plus 78 for the shared
// template (repo, clone, bundle), which the first test that needs it builds inside its body.
const BUILD_TIMEOUT_MS = gitSteps(41 + 78);

/** Pane's panels, in memory, as PanelManager keeps them: a permanent tab refuses delete, and creating an existing ID returns it. */
function memoryTabs(panels = new Map<string, ToolPanel>()): ImporterTabs & { panels: Map<string, ToolPanel> } {
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
  // The Session records, as OrchestrationSessionManager keeps them.
  const sessions: Array<{ id: string; move?: { state: string; machine: string; moveId: string; at: string } }> = [];
  const setMoveMark = vi.fn(async (id: string, mark?: { state: string; machine: string; moveId: string; at: string }) => {
    const session = sessions.find(item => item.id === id);
    if (session) session.move = mark;
  });
  const importArriving = vi.fn(async (record: { id: string; move?: { state: string; machine: string; moveId: string; at: string } }) => {
    const at = sessions.findIndex(item => item.id === record.id);
    if (at >= 0) sessions.splice(at, 1);
    sessions.push({ id: record.id, move: record.move });
  });
  const removeArriving = vi.fn(async (id: string) => {
    const at = sessions.findIndex(item => item.id === id && item.move?.state === 'arriving');
    if (at >= 0) sessions.splice(at, 1);
  });
  // Pane notices the importer shows the person.
  const notices: Array<{ title?: string; context?: string }> = [];
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
    orchestrationSessionManager: { list: async () => ({ sessions }), importArriving, removeArriving, setMoveMark },
    notifyService: { queue: { ask: async (request: { question: { title?: string; context?: string } }) => { notices.push(request.question); return { answer: 'ok' }; } } },
  };
  // SAFETY: the fixture supplies the exact AppServices members the importer reads, with their call shapes.
  const services = fixture as AppServices;
  return { services, rows, replaced, active, setMoveMark, importArriving, removeArriving, sessions, notices };
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

/**
 * A source repository with uncommitted work packed as p1's bundle, and the target's clone, built once
 * per file: every test gets its own copy of the clone (tests change its refs and worktrees) and the same bundle.
 */
let template: Promise<{ dir: string; bundle: Buffer }> | undefined;
async function buildTemplate(): Promise<{ dir: string; bundle: Buffer }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-importer-template-'));
  const source = path.join(dir, 'source');
  fs.mkdirSync(source);
  gitAt(dir, source, 'init', '-q');
  fs.writeFileSync(path.join(source, 'a.txt'), 'one\n');
  gitAt(dir, source, 'add', '-A');
  gitAt(dir, source, 'commit', '-q', '-m', 'base');
  gitAt(dir, dir, 'clone', '-q', source, 'target');
  gitAt(dir, path.join(dir, 'target'), 'remote', 'set-url', 'origin', 'https://example.invalid/o/r.git');
  // The source's uncommitted work, as a move packs it.
  fs.writeFileSync(path.join(source, 'a.txt'), 'two\n');
  await createSnapshot(source, 'refs/pane/move/p1');
  await createBundle(source, ['refs/pane/move/p1'], path.join(dir, 'p1.bundle'));
  return { dir, bundle: fs.readFileSync(path.join(dir, 'p1.bundle')) };
}

afterAll(async () => {
  const built = await template?.catch(() => undefined);
  if (built) fs.rmSync(built.dir, { recursive: true, force: true });
});

/** A scratch PANE_DIR, and this test's copy of the target's clone with p1's bundle. */
async function gitFixture(prefix: string): Promise<{ target: string; bundle: Buffer }> {
  template ??= buildTemplate();
  const { dir, bundle } = await template;
  root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  previousPaneDir = process.env.PANE_DIR;
  process.env.PANE_DIR = path.join(root, 'pane');
  const target = path.join(root, 'target');
  fs.cpSync(path.join(dir, 'target'), target, { recursive: true, preserveTimestamps: true });
  return { target, bundle };
}

describe('MoveImporter', { timeout: BUILD_TIMEOUT_MS }, () => {
  let target: string;
  let bundle: Buffer;
  const registry = new PaneCommandRegistry();

  beforeEach(async () => {
    ({ target, bundle } = await gitFixture('pane-importer-'));
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

/** An agent tab in the owner Pane (the orchestrator's), running and mid-turn when the move stopped it. */
function ownerWithAgent(): MovePane {
  return {
    id: '__owner__', name: 'S', role: 'owner', repo: null, worktreePath: '/a/.pane/sessions/sess-1', worktreeName: 'sess-1',
    branch: null, head: null, baseBranch: null, baseCommit: null, snapshot: null, bundle: null, layout: null,
    record: { prompt: '', permissionMode: 'ignore', noTool: false }, ignored: [],
    tabs: [{ id: 't-agent', type: 'terminal', title: 'Orchestrator', metadata: { createdAt: '', lastActiveAt: '', position: 0 }, state: { agentType: 'claude' }, working: true, interrupted: false, running: true }],
  };
}

/**
 * One target machine across restarts: its saved rows and tabs (the fakes stand for the database)
 * survive; a restart is a new importer on the same folders, its in-memory jobs gone. The registry
 * records each tab it launches and each line it types.
 */
function targetMachine(repo: string, setupGate?: Promise<void>, beforeLaunch: () => Promise<void> = async () => undefined) {
  const tabs = memoryTabs();
  const world = fakeServices(repo, setupGate, tabs.panels);
  const launched: string[] = [];
  const typed: string[] = [];
  const registry = new PaneCommandRegistry();
  registry.register('runpane:panels:resume', async (request: PaneCommandValue) => { await beforeLaunch(); launched.push(String(decodeBoundary(request, boundary.object({ panelId: boundary.string })).panelId)); return { action: 'resumed' }; });
  registry.register('runpane:panels:submit', async (request: PaneCommandValue) => { typed.push(decodeBoundary(request, boundary.object({ panelId: boundary.string })).panelId); return { ok: true }; });
  const restart = () => new MoveImporter(world.services, registry, path.join(root, 'moves'), tabs);
  return { ...world, tabs, launched, typed, restart };
}

async function builtOn(machine: ReturnType<typeof targetMachine>, panes: MovePane[], files: Record<string, Buffer | string> = {}): Promise<{ moveId: string; importer: MoveImporter }> {
  const importer = machine.restart();
  const moveId = newMoveId();
  await stage(importer, manifest(moveId, panes), files);
  importer.build(moveId);
  expect((await waitStage(importer, moveId, ['built', 'failed'])).stage).toBe('built');
  return { moveId, importer };
}

const ledgerFile = (moveId: string) => path.join(root, 'move-ledger', `${moveId}.json`);
const settle = async (until: () => boolean) => { for (let attempt = 0; attempt < 300 && !until(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10)); };

describe('MoveImporter after a restart (F-10, J9)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-importer-restart-'));
    previousPaneDir = process.env.PANE_DIR;
    process.env.PANE_DIR = path.join(root, 'pane');
    fs.mkdirSync(path.join(root, 'target'));
  });
  afterEach(() => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    fs.chmodSync(root, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restarted after the build, before the start arrived: it still says built, and a resent start launches the agent once', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId } = await builtOn(machine, [ownerWithAgent()]);
    const after = machine.restart();
    expect(await after.status(moveId)).toMatchObject({ stage: 'built', durable: true });
    after.start(moveId);
    expect((await waitStage(after, moveId, ['started', 'failed', 'aborted']))).toMatchObject({ stage: 'started', resumed: 1, failedTabs: [] });
    expect(machine.setMoveMark).toHaveBeenCalledWith('sess-1', undefined, 'Moved here from A.');
    expect(machine.launched).toEqual(['t-agent']);
    await settle(() => machine.typed.length > 0);
    expect(machine.typed).toEqual(['t-agent']);
    // Asked again (a start resent while the answer was lost): still started, nothing runs twice.
    expect(after.start(moveId).stage).toBe('started');
    expect(machine.launched).toEqual(['t-agent']);
  });

  it('restarted mid-commit: the start resumes on its own, launches the agent once, and the move ends started', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent()]);
    // The commit is recorded, then Pane quits before the start finishes.
    machine.setMoveMark.mockImplementationOnce(() => new Promise(() => undefined));
    importer.start(moveId);
    expect((await importer.status(moveId)).stage).toBe('starting');
    const after = machine.restart();
    await after.resume();
    expect(await after.status(moveId)).toMatchObject({ stage: 'started', durable: true, resumed: 1 });
    expect(machine.launched).toEqual(['t-agent']);
    // A committed move can no longer be rolled back.
    await expect(after.abort(moveId)).rejects.toThrow(/already started/);
  });

  it('a ledger it cannot read during a resumed commit is unknown, never proof: the fence is refused and the source stays frozen (F-15)', async () => {
    // Launching the agent stalls until let go: the commit is past the Session's mark, so nothing but the record says it committed.
    const stalls: Array<() => void> = [];
    const machine = targetMachine(path.join(root, 'target'), undefined, () => new Promise<void>(resolve => { stalls.push(resolve); }));
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent()]);
    importer.start(moveId);
    await settle(() => stalls.length === 1);
    // Pane quits mid-commit; the restarted one resumes it and stalls at the same launch.
    const after = machine.restart();
    const resumed = after.resume();
    await settle(() => stalls.length === 2);
    expect(machine.sessions.find(session => session.id === 'sess-1')?.move).toBeUndefined();
    // The record becomes unreadable (EACCES); its folder stays writable.
    fs.chmodSync(ledgerFile(moveId), 0o000);
    let rounds = 0;
    const outcome = await settleAfterFreeze({
      status: () => after.status(moveId),
      start: async () => after.start(moveId),
      rollBack: () => after.abort(moveId),
    }, { onWait: () => undefined, stopped: () => (rounds += 1) > 20, sleep: async () => undefined });
    expect(outcome).toBeUndefined();
    fs.chmodSync(ledgerFile(moveId), 0o644);
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).decision).toBe('committed');
    // Readable again: the commit finishes and the move ends started.
    stalls.forEach(release => release());
    await resumed;
    await after.status(moveId);
    await settle(() => JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).decision === 'started');
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).decision).toBe('started');
  });

  it('a Session still arriving for a move with no record is unknown, not "never committed" (F-15)', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId } = await builtOn(machine, [ownerWithAgent()]);
    fs.rmSync(ledgerFile(moveId));
    const after = machine.restart();
    await expect(after.status(moveId)).rejects.toThrow(/arriving/);
    await expect(after.abort(moveId)).rejects.toThrow(/arriving/);
  });

  it('a move it has no record of was never committed: rolling it back fences it, so it can never start', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const importer = machine.restart();
    const moveId = newMoveId();
    expect(await importer.status(moveId)).toMatchObject({ stage: 'aborted', durable: true });
    expect(await importer.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    // The package turns up late: the fenced move refuses it, and can't start.
    await expect(stage(importer, manifest(moveId, []), {})).rejects.toThrow(/rolled back/);
    expect(importer.start(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
  });

  it('an abort before the start records the roll-back first, so the source may release its copy', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent()]);
    expect(await importer.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(await machine.restart().status(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(machine.launched).toEqual([]);
  });

  it('end to end: the source loses its start, the target restarts, and the move still completes on its own', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId } = await builtOn(machine, [ownerWithAgent()]);
    let target = machine.restart();
    let dropped = 0;
    const link: FreezeTarget = {
      status: async () => target.status(moveId),
      start: async () => { if (dropped++ === 0) throw new Error('connection reset'); return target.start(moveId); },
      rollBack: async () => target.abort(moveId),
    };
    let rounds = 0;
    const outcome = await settleAfterFreeze(link, {
      onWait: () => { if (rounds === 1) target = machine.restart(); },
      stopped: () => (rounds += 1) > 200,
      sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    });
    expect(outcome?.kind).toBe('committed');
    expect(dropped).toBeGreaterThanOrEqual(2);
    expect(machine.launched).toEqual(['t-agent']);
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).decision).toBe('started');
  });

  it('end to end: an unreachable target never releases the source', async () => {
    const machine = targetMachine(path.join(root, 'target'));
    const { moveId } = await builtOn(machine, [ownerWithAgent()]);
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
    expect(await machine.restart().status(moveId)).toMatchObject({ stage: 'built' });
  });
});

describe('MoveImporter full roll-back after a restart (D-1)', { timeout: BUILD_TIMEOUT_MS }, () => {
  let target: string;
  let bundle: Buffer;

  beforeEach(async () => {
    ({ target, bundle } = await gitFixture('pane-importer-rollback-'));
  });
  afterEach(() => {
    if (previousPaneDir === undefined) delete process.env.PANE_DIR;
    else process.env.PANE_DIR = previousPaneDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A move back: what the earlier move away left here (snapshot ref, archived Pane with a tab, Session folder). */
  async function earlierCopy(machine: ReturnType<typeof targetMachine>): Promise<{ previous: string; folder: string }> {
    const previous = git(target, 'rev-parse', 'HEAD');
    git(target, 'update-ref', 'refs/pane/move/p1', previous);
    machine.rows.set('p1', { id: 'p1', name: 'Pane p1', archived: true, worktree_path: path.join(root, 'worktrees', 'p1'), worktree_name: 'p1', project_id: 1 });
    await machine.tabs.createPanel({ id: 't-old', sessionId: 'p1', type: 'terminal', title: 'Old tab', initialState: { customState: { conversationId: 'c-1' } } });
    const folder = sessionWorkspacePath('sess-1');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'notes.md'), 'kept here\n');
    return { previous, folder };
  }

  function expectAsBefore(machine: ReturnType<typeof targetMachine>, { previous, folder }: { previous: string; folder: string }): void {
    expect(fs.existsSync(path.join(root, 'worktrees', 'p1'))).toBe(false);
    expect(git(target, 'rev-parse', 'refs/pane/move/p1')).toBe(previous);
    expect(git(target, 'for-each-ref', 'refs/pane/move-incoming')).toBe('');
    expect([...machine.rows.keys()]).toEqual(['p1']);
    expect(machine.rows.get('p1')?.archived).toBe(true);
    expect(machine.tabs.panels.get('t-old')?.state.customState).toEqual({ conversationId: 'c-1' });
    expect(machine.tabs.panels.has('t-agent')).toBe(false);
    expect(fs.readdirSync(folder)).toEqual(['notes.md']);
    expect(fs.readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('kept here\n');
    expect(fs.readdirSync(path.dirname(folder)).filter(name => name.startsWith('sess-1'))).toEqual(['sess-1']);
    expect(machine.sessions).toEqual([]);
    expect(machine.launched).toEqual([]);
  }

  it('rolled back after a restart: everything the build made goes, and what was here comes back', async () => {
    const machine = targetMachine(target);
    const before = await earlierCopy(machine);
    const { moveId } = await builtOn(machine, [ownerWithAgent(), member('p1')], { 'panes/p1.bundle': bundle });
    const after = machine.restart();
    expect(await after.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expectAsBefore(machine, before);
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8'))).toMatchObject({ decision: 'rolledBack', rollbackDone: true });
    expect(machine.notices).toEqual([]);
  });

  it('a roll-back cut short by a restart finishes when Pane starts again, and running it again changes nothing', async () => {
    const machine = targetMachine(target);
    const before = await earlierCopy(machine);
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent(), member('p1')], { 'panes/p1.bundle': bundle });
    // Deleting the arriving Pane fails once, as if Pane quit there.
    const db = machine.services.databaseService;
    const remove = db.deleteArchivedSessionPermanently.bind(db);
    let failures = 1;
    db.deleteArchivedSessionPermanently = (id: string) => { if (failures-- > 0) throw new Error('quit'); return remove(id); };
    expect(await importer.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).rollbackDone).toBeUndefined();
    await machine.restart().resume();
    expectAsBefore(machine, before);
    await machine.restart().resume();
    expectAsBefore(machine, before);
  });

  it('a build cut short by a restart rolls back when Pane starts again, and can never start', async () => {
    const machine = targetMachine(target, new Promise(() => undefined));
    const before = await earlierCopy(machine);
    const importer = machine.restart();
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [ownerWithAgent(), member('p1')]), { 'panes/p1.bundle': bundle });
    importer.build(moveId);
    // Setup never ends: Pane quits with the worktree and the Pane made.
    await settle(() => fs.existsSync(path.join(root, 'worktrees', 'p1')) && machine.rows.has('p1') && !machine.rows.get('p1')?.archived);
    expect(machine.rows.get('p1')?.archived).toBe(false);
    const after = machine.restart();
    await after.resume();
    expect(await after.status(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expect(after.start(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expectAsBefore(machine, before);
  });

  it('a build cut short after the arriving Session and its tabs exist, then fenced by the source, leaves nothing (QA observation 2)', async () => {
    const machine = targetMachine(target);
    const before = await earlierCopy(machine);
    const owner = ownerWithAgent();
    owner.tabs.push({ ...owner.tabs[0], id: 't-second', title: 'Second' });
    // The second tab never finishes being made: Pane quits with the arriving record and the first tab, paused, in place.
    const create = machine.tabs.createPanel;
    machine.tabs.createPanel = async request => request.id === 't-second' ? new Promise(() => undefined) : create(request);
    const importer = machine.restart();
    const moveId = newMoveId();
    await stage(importer, manifest(moveId, [owner, member('p1')]), { 'panes/p1.bundle': bundle });
    importer.build(moveId);
    await settle(() => machine.tabs.panels.has('t-agent'));
    expect(machine.sessions).toMatchObject([{ id: 'sess-1', move: { state: 'arriving', moveId } }]);
    machine.tabs.createPanel = create;
    // The source, not yet frozen, gives up and asks the restarted target to roll back, before anything else runs.
    const after = machine.restart();
    expect(await after.abort(moveId)).toMatchObject({ stage: 'aborted', rolledBack: true });
    expectAsBefore(machine, before);
    expect(machine.tabs.panels.has('t-second')).toBe(false);
  });

  it('an undo that failed runs again before any older step, so it never deletes the archived tab it would restore (F-16)', async () => {
    const machine = targetMachine(target);
    await earlierCopy(machine);
    // The arriving tab has the same ID as the archived Pane's tab.
    const pane = member('p1');
    pane.tabs = [{ id: 't-old', type: 'terminal', title: 'Incoming tab', metadata: { createdAt: '', lastActiveAt: '', position: 0 }, state: { from: 'incoming' }, working: false, interrupted: false, running: false }];
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent(), pane], { 'panes/p1.bundle': bundle });
    // Deleting the arriving tab fails once.
    const remove = machine.tabs.deletePanel;
    let fail = true;
    machine.tabs.deletePanel = async id => {
      if (id === 't-old' && fail) { fail = false; throw new Error('one transient tab deletion failure'); }
      await remove(id);
    };
    await importer.abort(moveId);
    // The replay stopped at the failed deletion: the archived tab still waits, set aside, behind it.
    expect(machine.tabs.panels.get(`t-old.p1.moving-${moveId}`)?.state.customState).toEqual({ conversationId: 'c-1' });
    await machine.restart().resume();
    expect(machine.tabs.panels.get('t-old')?.state.customState).toEqual({ conversationId: 'c-1' });
    expect(machine.rows.get('p1')?.archived).toBe(true);
    expect(JSON.parse(fs.readFileSync(ledgerFile(moveId), 'utf8')).rollbackDone).toBe(true);
  });

  it('a step that keeps failing is retried at each start and, after five tries, shown once to the person', async () => {
    const machine = targetMachine(target);
    await earlierCopy(machine);
    const { moveId, importer } = await builtOn(machine, [ownerWithAgent(), member('p1')], { 'panes/p1.bundle': bundle });
    const db = machine.services.databaseService;
    db.deleteArchivedSessionPermanently = () => { throw new Error('EACCES: permission denied'); };
    await importer.abort(moveId);
    for (let start = 0; start < 6; start += 1) await machine.restart().resume();
    expect(machine.notices).toHaveLength(1);
    expect(machine.notices[0].title).toMatch(/Pane p1/);
    expect(machine.notices[0].context).toMatch(/EACCES/);
    // Newer steps were undone; older ones wait behind the failed one, so the archived Pane of the same ID stays set aside and safe.
    expect(machine.tabs.panels.has('t-agent')).toBe(false);
    expect(machine.sessions).toEqual([]);
    expect(machine.rows.get(`p1.moving-${moveId}`)?.archived).toBe(true);
    expect(machine.tabs.panels.get(`t-old.p1.moving-${moveId}`)).toBeDefined();
  });
});

