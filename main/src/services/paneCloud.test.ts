import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServiceStub, type ServiceStub } from 'pane-cloud-contract/stubs';
import { PaneCloudManager } from './paneCloud';
import { PaneError } from '../../../shared/paneError';
import type { VouchedPairing } from '../../../shared/types/relay';
import type { OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';

let service: ServiceStub;
let dir: string;
let clock: Date;
let opened: string[];
let pairings: VouchedPairing[];
/** Saved computers by relay id, as pairing leaves them in client.computers. */
let computers: Map<string, string>;
let started: Array<{ machineId: string; input: OrchestrationSessionCreateInput }>;
let forgotten: string[];
const managers: PaneCloudManager[] = [];

function manager(): PaneCloudManager {
  const created = new PaneCloudManager({
    serviceUrl: service.url,
    tokenFile: path.join(dir, 'pane-cloud.json'),
    openExternal: (url) => { opened.push(url); },
    pair: async (pairing) => {
      pairings.push(pairing);
      const id = `computer-${computers.size + 1}`;
      computers.set(pairing.relay.computerId, id);
      return id;
    },
    computerFor: (relayId) => computers.get(relayId) ?? null,
    startSession: async (machineId, input) => {
      started.push({ machineId, input });
      return `session-on-${machineId}`;
    },
    forget: async (machineId) => { forgotten.push(machineId); },
    pollMs: { waiting: 10, steady: 60_000 },
  });
  managers.push(created);
  return created;
}

/** Signs in as `email`, approving on the stub the way the person would on the hosted page. */
async function signIn(cloud: PaneCloudManager, email: string) {
  const pending = await cloud.startSignIn();
  if (pending.signIn.state !== 'pending') throw new Error(`expected a pending sign-in, got ${pending.signIn.state}`);
  service.approveDevice(pending.signIn.userCode, email);
  await vi.waitFor(() => expect(cloud.snapshot().signIn.state).toBe('signed-in'), { timeout: 5_000 });
}

const session = (name: string): OrchestrationSessionCreateInput => ({ name, agent: 'claude', goal: 'Fix the flaky test' });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pane-cloud-'));
  clock = new Date('2026-12-10T12:00:00Z');
  opened = [];
  pairings = [];
  computers = new Map();
  started = [];
  forgotten = [];
  service = await startServiceStub({
    now: () => clock,
    accounts: [
      { email: 'maya@example.test', name: 'Maya', invited: true },
      { email: 'wait@example.test', invited: false },
      { email: 'phone@example.test', invited: true, signupState: 'needs_phone' },
    ],
  });
});

afterEach(async () => {
  for (const cloud of managers.splice(0)) cloud.dispose();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Pane Cloud sign-in', () => {
  it('opens the sign-in page in the browser, then shows the account and keeps the session for the next start', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https?:\/\//);
    expect(cloud.snapshot().signIn).toMatchObject({ state: 'signed-in', email: 'maya@example.test', name: 'Maya', access: 'invited', signupState: 'ready' });

    const tokenFile = path.join(dir, 'pane-cloud.json');
    if (process.platform !== 'win32') expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await manager().refresh()).signIn).toMatchObject({ state: 'signed-in', email: 'maya@example.test' });
  });

  it('forgets the session on sign-out', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    expect((await cloud.signOut()).signIn).toEqual({ state: 'signed-out' });
    await expect(readFile(path.join(dir, 'pane-cloud.json'), 'utf8')).rejects.toThrow();
  });

  it('tells a waitlisted account it is on the list and creates nothing', async () => {
    const cloud = manager();
    await signIn(cloud, 'wait@example.test');

    await expect(cloud.createSession(session('Docs'))).rejects.toThrow(/on the list/);
    expect(cloud.snapshot().sessions).toEqual([]);
  });

  it('sends an account that has not finished sign-up to the next step', async () => {
    const cloud = manager();
    await signIn(cloud, 'phone@example.test');

    await expect(cloud.createSession(session('Docs'))).rejects.toMatchObject({ next: expect.stringMatching(/mobile number/) });
    expect(cloud.snapshot().sessions).toEqual([]);
  });
});

describe('New cloud Session', () => {
  it('creates a VM, pairs with the identity the service vouches for, and starts the Session on it', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');

    const created = await cloud.createSession(session('Docs site migration'));

    expect(pairings).toHaveLength(1);
    expect(pairings[0].link).toContain(pairings[0].relay.computerId);
    expect(created.machineId).toBe('computer-1');
    expect(created.sessionId).toBe('session-on-computer-1');
    expect(started).toEqual([{ machineId: 'computer-1', input: session('Docs site migration') }]);
    expect(created.snapshot.creating).toBeNull();
    expect(created.snapshot.sessions).toEqual([expect.objectContaining({ name: 'Docs site migration', awake: true, underReview: false, machineId: 'computer-1' })]);
  });

  it('names the VM for a Session left unnamed', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');

    const created = await cloud.createSession({ name: '', nameFromFirstMessage: true, agent: 'claude' });
    expect(created.snapshot.sessions[0].name).toBe('Cloud Session');
  });

  it('deletes the VM again when pairing fails, and says what to do', async () => {
    const cloud = new PaneCloudManager({
      serviceUrl: service.url,
      tokenFile: path.join(dir, 'pane-cloud.json'),
      openExternal: () => undefined,
      pair: async () => { throw new PaneError('ERR_RELAY_NOT_READY', 'Phone access did not get ready on this computer.', 'Check this computer can reach the internet.'); },
      computerFor: () => null,
      startSession: async () => 'never',
      forget: async () => undefined,
      pollMs: { waiting: 10, steady: 60_000 },
    });
    managers.push(cloud);
    await signIn(cloud, 'maya@example.test');

    await expect(cloud.createSession(session('Docs'))).rejects.toMatchObject({ message: 'Phone access did not get ready on this computer.', next: 'Check this computer can reach the internet.' });
    expect(cloud.snapshot().sessions).toEqual([]);
    expect(cloud.snapshot().usage?.awakeNow).toBe(0);
  });

  it('refuses a sixth Session awake with the service\'s reason and creates nothing more', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    for (let i = 1; i <= 5; i += 1) await cloud.createSession(session(`Session ${i}`));

    await expect(cloud.createSession(session('Session 6'))).rejects.toMatchObject({ code: 'awake_limit_reached' });
    expect(cloud.snapshot().sessions).toHaveLength(5);
    expect(cloud.snapshot().error).toMatchObject({ code: 'awake_limit_reached' });
    expect(cloud.snapshot().creating).toBeNull();
  });
});

describe('a cloud Session', () => {
  it('stops and starts again, and the usage counts it awake only while it runs', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    const { snapshot } = await cloud.createSession(session('Docs'));
    const vmId = snapshot.sessions[0].vmId;
    expect(snapshot.usage).toMatchObject({ plan: 'free', agentHoursLimit: 300, awakeNow: 1, awakeLimit: 5 });

    const stopped = await cloud.stop(vmId);
    expect(stopped.sessions[0].awake).toBe(false);
    expect(stopped.usage?.awakeNow).toBe(0);

    const startedAgain = await cloud.start(vmId);
    expect(startedAgain.sessions[0].awake).toBe(true);
    expect(startedAgain.error).toBeNull();
  });

  it('counts agent-hours as a plain number of the month\'s limit, with the reset date', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    await cloud.createSession(session('Docs'));
    clock = new Date('2026-12-10T15:00:00Z');

    const { usage } = await cloud.refresh();
    expect(usage).toMatchObject({ agentHoursUsed: 3, agentHoursLimit: 300, resetsAt: '2027-01-01T00:00:00.000Z' });
    expect(usage?.members).toEqual([expect.objectContaining({ name: 'Maya', you: true, agentHours: 3, awakeNow: 1, awakeLimit: 5 })]);
  });

  it('shows a Session paused for review as under review and refuses to start it', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    const { snapshot } = await cloud.createSession(session('Docs'));
    const vmId = snapshot.sessions[0].vmId;
    service.pauseForReview(vmId);

    expect((await cloud.refresh()).sessions[0]).toMatchObject({ awake: false, underReview: true });
    const after = await cloud.start(vmId);
    expect(after.sessions[0].awake).toBe(false);
    expect(after.error).toMatchObject({ code: 'under_review' });
  });

  it('deletes the VM and forgets the computer this desktop saved for it', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    const { snapshot } = await cloud.createSession(session('Docs'));

    const after = await cloud.remove(snapshot.sessions[0].vmId);
    expect(after.sessions).toEqual([]);
    expect(forgotten).toEqual(['computer-1']);
  });

  it('lists the action log with who asked and why', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    const { snapshot } = await cloud.createSession(session('Docs'));
    const vmId = snapshot.sessions[0].vmId;
    await cloud.stop(vmId);

    const actions = await cloud.actions(vmId);
    expect(actions.map((action) => action.operation)).toEqual(['stop', 'prepare_to_stop', 'create_pairing_link', 'bootstrap', 'create']);
    expect(actions[0]).toMatchObject({ actor: 'you', failed: false });
  });
});

describe('when the service ends the session', () => {
  it('signs out and says so, keeping saved computers', async () => {
    const cloud = manager();
    await signIn(cloud, 'maya@example.test');
    await cloud.createSession(session('Docs'));
    // Another device signing out ends this token too on the stub.
    await (await import('pane-cloud-contract')).createServiceClient({ baseUrl: service.url, token: JSON.parse(await readFile(path.join(dir, 'pane-cloud.json'), 'utf8')).token }).signOut();

    const after = await cloud.refresh();
    expect(after.signIn).toEqual({ state: 'signed-out' });
    expect(after.error?.message).toMatch(/session ended/i);
    expect(forgotten).toEqual([]);
  });
});
