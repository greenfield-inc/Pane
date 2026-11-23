import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMoveCheck, SessionMovePreflight, SessionMoveProgress } from '../../../../shared/types/sessionMove';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
import { PaneCommandRegistry } from '../../daemon/commandRegistry';
import type { AppServices } from '../../ipc/types';
import { MoveCoordinator } from './coordinator';
import { createSnapshot } from './gitSnapshot';
import { SIGNED_OUT_PANE_CLOUD } from '../../../../shared/types/paneCloud';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * The source side of a move against a real git worktree and the test PANE_DIR, with the move's
 * own steps (`run`) and preflight (`check`) swapped for ones the test controls.
 */

/** The parts of a source job this test reads and sets. */
interface TestJob {
  peer: { name: string; invoke: () => Promise<void> };
  snapshotRefs: { worktree: string; ref: string; previous: string | null }[];
  progress: SessionMoveProgress;
}

let root: string;
let previousPaneDir: string | undefined;
const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv() }).toString().trim();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-move-source-')));
  previousPaneDir = process.env.PANE_DIR;
  process.env.PANE_DIR = path.join(root, 'pane');
});

afterEach(() => {
  if (previousPaneDir === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = previousPaneDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MoveCoordinator.start', () => {
  it('two overlapping starts of one Session run one move, so no failed job puts back the Restore ref of the move that runs', async () => {
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'work'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'worktree', 'add', '-qb', 'feature', worktree);
    fs.writeFileSync(path.join(worktree, 'work'), 'latest uncommitted work');
    const ref = 'refs/pane/move/member';

    const recordFixture = { id: 'session', name: 'Session', internalSessionId: 'owner', associations: [{ paneId: 'member' }] };
    // SAFETY: the coordinator reads only these record fields on the path this test drives.
    const record = recordFixture as OrchestrationSessionRecord;
    const servicesFixture = {
      configManager: { getConfig: () => ({}) },
      orchestrationSessionManager: { get: async () => record },
      sessionManager: { getSession: (id: string) => id === 'member' ? { id, name: 'member', worktreePath: worktree, archived: false } : undefined },
    };
    // SAFETY: the fixture supplies the exact AppServices members start, fail and status read, with their call shapes.
    const coordinator = new MoveCoordinator(servicesFixture as AppServices, new PaneCommandRegistry());

    // Both starts wait in preflight together, as two owner clients clicking Move at once do.
    let releasePreflight = () => {};
    const preflight = new Promise<void>(resolve => { releasePreflight = resolve; });
    const launched: TestJob[] = [];
    const snapshotted: Promise<void>[] = [];
    let allSnapshotted = () => {};
    const snapshotsDone = new Promise<void>(resolve => { allSnapshotted = resolve; });
    Object.assign(coordinator, {
      check: async ({ target }: { target: string }): Promise<SessionMovePreflight> => {
        await preflight;
        return { target, ready: true, checks: [], paneCount: 1, tabCount: 0, bytes: 0 };
      },
      tabsOf: () => [],
      // The pack step: each job snapshots in turn. A job the Session no longer runs then fails (its
      // send to the target broke), and start's own failure path cleans it up.
      run: async (job: TestJob) => {
        launched.push(job);
        job.peer = { name: 'B', invoke: async () => undefined };
        const earlier = [...snapshotted];
        const step = (async () => {
          await Promise.all(earlier);
          const snapshot = await createSnapshot(worktree, ref);
          job.snapshotRefs.push({ worktree, ref, previous: snapshot.previous });
        })();
        snapshotted.push(step);
        await step;
        await snapshotsDone;
        const active = await coordinator.status({ sessionId: 'session' });
        if (active?.moveId !== job.progress.moveId) throw new Error('send failed');
      },
    });

    const starts = [coordinator.start({ sessionId: 'session', target: 'B' }), coordinator.start({ sessionId: 'session', target: 'B' })];
    releasePreflight();
    const [first, second] = await Promise.all(starts);
    await Promise.all(snapshotted);
    allSnapshotted();
    // Wait until every job the Session no longer runs has failed and cleaned up.
    await vi.waitFor(async () => {
      const active = (await coordinator.status({ sessionId: 'session' }))?.moveId;
      expect(launched.filter(job => job.progress.moveId !== active).every(job => job.progress.phase === 'failed')).toBe(true);
    });

    // The Restore ref still holds the latest work.
    const remaining = git(repo, 'for-each-ref', '--format=%(objectname)', ref);
    expect(remaining).not.toBe('');
    expect(git(repo, 'show', `${remaining}:work`)).toBe('latest uncommitted work');
    expect(launched).toHaveLength(1);
    expect(second.moveId).toBe(first.moveId);
    expect((await coordinator.status({ sessionId: 'session' }))?.moveId).toBe(first.moveId);
  });
});

describe('MoveCoordinator.resume (T-44)', () => {
  const card = (id: string) => ({ item: { id, ui: 'ask', title: `Q-${id}: go?`, state: 'waiting', createdAt: 1, source: { name: 'S', agent: 'Claude', panelId: 'orch' } } });
  const handoff = (moveId: string, ids: string[]) => {
    const dir = path.join(root, 'pane', 'moves-out', moveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'approvals.json'), JSON.stringify(ids.map(card)));
    return path.join(dir, 'approvals.json');
  };

  it('puts back the cards of a move that never froze, and keeps those of a finished one away', async () => {
    const lost = handoff('move-never-froze', ['1', '2']);
    const done = handoff('move-finished', ['3']);
    const adopted: string[] = [];
    const servicesFixture = {
      configManager: { getConfig: () => ({}) },
      orchestrationSessionManager: { list: async () => ({ sessions: [{ id: 'gone', name: 'Moved away', move: { state: 'moved', machine: 'B', moveId: 'move-finished', at: '' } }] }) },
      notifyService: { adoptMovedApprovals: (approvals: Array<{ item: { id: string } }>) => adopted.push(...approvals.map(approval => approval.item.id)) },
    };
    // SAFETY: the fixture supplies the exact AppServices members resume reads, with their call shapes.
    const coordinator = new MoveCoordinator(servicesFixture as AppServices, new PaneCommandRegistry());
    await coordinator.resume();
    expect(adopted).toEqual(['1', '2']);
    expect(fs.existsSync(lost)).toBe(false);
    expect(fs.existsSync(done)).toBe(false);
  });
});

describe('MoveCoordinator: a move to Pane Cloud', () => {
  /** The new cloud machine's Pane: a local HTTP server that records each fix the move runs there. */
  let server: http.Server;
  let fixes: JsonValue[];
  beforeEach(async () => {
    fixes = [];
    server = http.createServer((request, response) => {
      let text = '';
      request.on('data', chunk => { text += chunk; });
      request.on('end', () => {
        const body = decodeBoundary(JSON.parse(text), boundary.object({ channel: boundary.string, args: boundary.array(boundary.jsonObject) }));
        if (body.channel === 'runpane:move:fix') fixes.push(body.args[0].fix ?? null);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: null }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  const clone = { kind: 'clone' as const, label: 'Clone', remote: 'git@example.invalid:team/app.git', path: '/home/pane/app' };

  /** A coordinator whose cloud machine answers on the test server, with the target's checks given by `checks`. */
  function cloudMove(checks: () => SessionMoveCheck[]) {
    const made: string[] = [];
    const removed: string[] = [];
    const baseUrl = `http://127.0.0.1:${decodeBoundary(server.address(), boundary.object({ port: boundary.number })).port}`;
    const computers = [{ id: 'vm-computer', label: 'Fix login', routes: [{ id: `public:${baseUrl}`, kind: 'public', source: 'link', baseUrl, token: 't' }] }];
    const recordFixture = { id: 'session', name: 'Fix login', internalSessionId: 'owner', associations: [] };
    // SAFETY: the coordinator reads only these record fields on the path this test drives.
    const record = recordFixture as OrchestrationSessionRecord;
    const servicesFixture = {
      configManager: { getConfig: () => ({ remoteDaemon: normalizeRemoteDaemonConfig({ client: { mode: 'local', computers } }) }) },
      orchestrationSessionManager: { get: async () => record },
      sessionManager: { getSession: () => undefined },
    };
    const cloud = {
      createMachine: async (name: string) => { made.push(name); return { vmId: 'vm-1', machineId: 'vm-computer' }; },
      remove: async (vmId: string) => { removed.push(vmId); return SIGNED_OUT_PANE_CLOUD; },
    };
    // SAFETY: the fixture supplies the exact AppServices members a move to Pane Cloud reads before its pack.
    const coordinator = new MoveCoordinator(servicesFixture as AppServices, new PaneCommandRegistry(), () => cloud);
    Object.assign(coordinator, {
      check: async (): Promise<SessionMovePreflight> => ({ target: 'Pane Cloud', ready: true, checks: [], paneCount: 1, tabCount: 0, bytes: 0 }),
      tabsOf: () => [],
      // The target's preflight: its checks, as the cloud machine answers them now.
      preflight: async (): Promise<SessionMovePreflight> => {
        const found = checks();
        return { target: 'Pane Cloud', ready: !found.some(check => check.level === 'block'), checks: found, paneCount: 1, tabCount: 0, bytes: 0 };
      },
      // The pack breaks, as a full disk would: the move fails before the freeze.
      manifest: async () => { throw new Error('No space left on device'); },
    });
    return { coordinator, made, removed };
  }

  it('makes the machine named after the Session, clones what it lacks there, and deletes it when the move fails before the freeze', async () => {
    const { coordinator, made, removed } = cloudMove(() => fixes.length
      ? [{ id: 'repo:app', level: 'ok', title: 'team/app is on Pane Cloud' }]
      : [{ id: 'repo:app', level: 'block', title: 'team/app isn\'t on Pane Cloud', fix: clone }]);
    const started = await coordinator.start({ sessionId: 'session', target: 'Pane Cloud', cloud: true });
    expect(started.steps.map(step => step.id)).toEqual(['machine', 'stop', 'pack', 'send', 'build', 'start']);

    await vi.waitFor(async () => expect((await coordinator.status({ sessionId: 'session' }))?.phase).toBe('failed'));
    const progress = await coordinator.status({ sessionId: 'session' });
    expect(made).toEqual(['Fix login']);
    expect(fixes).toEqual([clone]);
    expect(progress?.steps.find(step => step.id === 'machine')?.state).toBe('done');
    expect(progress?.computerId).toBe('vm-computer');
    expect(progress?.error?.message).toContain('Pane deleted the cloud machine it made for the move.');
    expect(removed).toEqual(['vm-1']);
  });

  it('deletes the machine and stops no tab when a check without a fix still blocks', async () => {
    const { coordinator, removed } = cloudMove(() => [{ id: 'version', level: 'block', title: 'Update Pane on Pane Cloud', detail: 'Pane there is too old.' }]);
    await coordinator.start({ sessionId: 'session', target: 'Pane Cloud', cloud: true });

    await vi.waitFor(async () => expect((await coordinator.status({ sessionId: 'session' }))?.phase).toBe('failed'));
    const progress = await coordinator.status({ sessionId: 'session' });
    expect(progress?.error?.message).toContain('Update Pane on Pane Cloud');
    expect(progress?.steps.find(step => step.id === 'stop')?.state).toBe('pending');
    expect(removed).toEqual(['vm-1']);
  });
});
