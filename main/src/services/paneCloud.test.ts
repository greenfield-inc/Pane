import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServiceStub, type ServiceStub } from 'pane-cloud-contract/stubs';
import { PaneCloudManager, type PaneCloudHosts } from './paneCloud';
import type { RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';

let service: ServiceStub;
let dir: string;
let saved: RemotePaneConnectionProfile[];
let forgotten: string[];
const managers: PaneCloudManager[] = [];

const hosts: PaneCloudHosts = {
  save: async (profile) => { saved.push(profile); },
  forget: async (machineId) => { forgotten.push(machineId); },
};

function manager(): PaneCloudManager {
  const created = new PaneCloudManager({ serviceUrl: service.url, tokenFile: path.join(dir, 'pane-cloud.json'), hosts });
  managers.push(created);
  return created;
}

/** Signs in as `login`, approving the device code the way the person would on GitHub. */
async function signIn(cloud: PaneCloudManager, login: string) {
  const pending = await cloud.startSignIn();
  if (pending.signIn.state !== 'pending') throw new Error(`expected a device code, got ${pending.signIn.state}`);
  service.approveDevice(pending.signIn.userCode, login);
  await vi.waitFor(() => expect(cloud.snapshot().signIn.state).toBe('signed-in'), { timeout: 5_000 });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pane-cloud-'));
  saved = [];
  forgotten = [];
  service = await startServiceStub({ accounts: [{ githubLogin: 'alice', name: 'Alice', cohort: true }, { githubLogin: 'eve', cohort: false }] });
});

afterEach(async () => {
  for (const cloud of managers.splice(0)) cloud.dispose();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

describe('Pane Cloud sign-in', () => {
  it('shows the device code, then the signed-in account, and keeps the session for the next start', async () => {
    const cloud = manager();
    const pending = await cloud.startSignIn();
    expect(pending.signIn).toMatchObject({ state: 'pending', verificationUri: 'https://github.com/login/device' });

    await signIn(cloud, 'alice');
    expect(cloud.snapshot().signIn).toEqual({ state: 'signed-in', githubLogin: 'alice', name: 'Alice', access: 'invited' });

    const tokenFile = path.join(dir, 'pane-cloud.json');
    if (process.platform !== 'win32') expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    const again = await manager().refresh();
    expect(again.signIn).toMatchObject({ state: 'signed-in', githubLogin: 'alice' });
  });

  it('tells a waitlisted account it is on the list and creates nothing', async () => {
    const cloud = manager();
    await signIn(cloud, 'eve');
    expect(cloud.snapshot().signIn).toMatchObject({ access: 'waitlisted' });

    const after = await cloud.createMachine('dev');
    expect(after.machine).toBeNull();
    expect(after.error?.message).toMatch(/on the list/);
  });

  it('forgets the session on sign-out', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    expect((await cloud.signOut()).signIn).toEqual({ state: 'signed-out' });
    await expect(readFile(path.join(dir, 'pane-cloud.json'), 'utf8')).rejects.toThrow();
  });
});

describe('a Pane Cloud machine', () => {
  it('asks the user to join their tailnet, then saves it as a codeless host on that tailnet', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');

    const created = await cloud.createMachine('dev');
    const machine = created.machine;
    expect(machine).toMatchObject({ name: 'dev', state: 'running', profileId: null });
    expect(machine?.tailnetLoginUrl).toMatch(/^https:\/\/login\.tailscale\.com\//);
    expect(saved).toEqual([]);

    service.joinTailnet(machine?.id ?? '');
    const joined = await cloud.refresh();
    expect(saved).toEqual([expect.objectContaining({
      label: 'dev',
      token: '',
      tailnetMachine: `pane-${machine?.id}`,
      tailnetDomain: 'tailnet.ts.net',
      baseUrl: `https://pane-${machine?.id}.tailnet.ts.net:8443`,
      paneCloud: { machineId: machine?.id },
      hostKind: { label: 'Pane Cloud machine', icon: 'cloud' },
    })]);
    expect(joined.machine).toMatchObject({ tailnetLoginUrl: null, profileId: saved[0].id });
  });

  it('refuses a second machine for the same seat with the service\'s reason', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    await cloud.createMachine('dev');

    const second = await cloud.createMachine('dev-2');
    expect(second.error).toEqual({ message: 'Your seat already has a machine.', next: 'Open your existing machine, or delete it before creating another.' });
    expect(second.machine?.name).toBe('dev');
  });

  it('lists every operation with who asked and why, newest first', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    const id = (await cloud.createMachine('dev')).machine?.id ?? '';

    await cloud.stopMachine();
    await cloud.startMachine();
    await cloud.updatePane();
    service.hostStop(id, 'idle');
    const latest = await cloud.refresh();

    expect(latest.machine?.state).toBe('stopped');
    expect(latest.machine?.stateReason).toBe('idle');
    const actions = latest.machine?.actions ?? [];
    expect(actions.map((action) => [action.operation, action.actor])).toEqual([
      ['stop', 'the host'],
      ['update_pane', 'you'],
      ['start', 'you'],
      ['stop', 'you'],
      ['prepare_to_stop', 'Pane Cloud'],
      ['bootstrap', 'Pane Cloud'],
      ['create', 'you'],
    ]);
    expect(actions[0].reason).toBe('No agent ran and no one was connected for 30 minutes.');
  });

  it('says when the daily CPU budget is used', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    const id = (await cloud.createMachine('dev')).machine?.id ?? '';

    service.setCpuSecondsUsed(id, 43_200);
    const usage = (await cloud.refresh()).machine?.usage;
    expect(usage).toMatchObject({ cpuSecondsUsed: 43_200, dailyCpuSeconds: 43_200, throttled: true });
  });

  it('forgets the saved host when the machine is deleted', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    const id = (await cloud.createMachine('dev')).machine?.id ?? '';
    service.joinTailnet(id);
    await cloud.refresh();

    const after = await cloud.deleteMachine();
    expect(forgotten).toEqual([id]);
    expect(after.machine).toBeNull();
  });

  it('reports an unreachable service as what happened and what to do next', async () => {
    const cloud = manager();
    await signIn(cloud, 'alice');
    await service.close();

    const after = await cloud.refresh();
    expect(after.error?.message).toMatch(/could not reach Pane Cloud/i);
    expect(after.error?.next).toMatch(/Your saved hosts and this computer keep working/);
    service = await startServiceStub({ accounts: [] });
  });
});
