import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineCommand, MachineState } from '../../../shared/types/machineConnections';
import type { MachineEntry } from './machineList';
import {
  createPaneOn,
  createSessionOn,
  newMachines,
  readRepositories,
  rememberNewMachine,
  startingNewMachineId,
} from './newOnMachine';

const states: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
  { id: 'build-box', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'travel-laptop', label: 'travel-laptop', kind: 'remote', status: 'offline', offlineSince: '2026-10-30T09:14:00.000Z' },
];

const entry = (id: string, name: string, os: MachineEntry['os'], active = false): MachineEntry => ({
  id, name, os, kind: id === 'local' ? 'local' : 'tailnet', slot: 2, active, presence: 'solid',
  stateText: '', subtitle: '', action: active ? 'none' : 'switch',
});
const entries = [entry('local', 'studio-mac', 'macOS', true), entry('build-box', 'build-box', 'Linux')];

// What each machine answers, by machine and channel, as the host commands answer today.
const replies: Record<string, Record<string, object>> = {
  'build-box': { 'projects:get-all': { success: true, data: [{ id: 4, name: 'infra', path: '/srv/infra' }] } },
  'office-pc': { 'projects:get-all': { success: true, data: [{ id: 1, name: 'acme-web', path: 'C:\\code\\acme-web' }, { id: 2, name: 'blog', path: 'C:\\code\\blog' }] } },
};

let runs: Array<{ machineId: string; command: MachineCommand }>;
let storage: Map<string, string>;

beforeEach(() => {
  runs = [];
  storage = new Map();
  vi.stubGlobal('window', {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    electronAPI: { machines: {
      read: async (machineId: string, channel: string) => ({ machineId, data: replies[machineId]?.[channel] ?? { success: false, error: 'not served' } }),
      run: async (machineId: string, command: MachineCommand) => {
        runs.push({ machineId, command });
        return { machineId, data: command.type === 'create-session' ? { success: true, data: { id: 'session-7', name: 'Rotate keys' } } : { success: true, data: { jobId: 'job-1' } } };
      },
    } },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('the New dialog machine picker', () => {
  it('names each machine as the machine menu does and keeps offline machines out of reach', () => {
    expect(newMachines(states, entries, 'local').map(({ id, name, status, current }) => ({ id, name, status, current }))).toEqual([
      { id: 'local', name: 'studio-mac', status: 'online', current: true },
      { id: 'build-box', name: 'build-box', status: 'online', current: false },
      { id: 'travel-laptop', name: 'travel-laptop', status: 'offline', current: false },
    ]);
  });

  it('starts on the machine the app is on the first time, then on the last machine used', () => {
    const machines = newMachines(states, entries, 'local');
    expect(startingNewMachineId(machines)).toBe('local');

    rememberNewMachine('build-box');
    expect(storage.get('pane.new.lastMachine')).toBe('build-box');
    expect(startingNewMachineId(machines)).toBe('build-box');
  });

  it('starts on the machine the app is on when the last machine used is offline', () => {
    rememberNewMachine('travel-laptop');
    expect(startingNewMachineId(newMachines(states, entries, 'local'))).toBe('local');
  });
});

describe('reading and creating on the picked machine', () => {
  it("reads the picked machine's repositories", async () => {
    expect(await readRepositories({ id: 'build-box', name: 'build-box' })).toEqual([{ id: 4, name: 'infra' }]);
    expect(await readRepositories({ id: 'office-pc', name: 'office-pc' })).toEqual([{ id: 1, name: 'acme-web' }, { id: 2, name: 'blog' }]);
  });

  it("explains a machine that can't list its repositories", async () => {
    await expect(readRepositories({ id: 'travel-laptop', name: 'travel-laptop' }))
      .rejects.toThrow('travel-laptop did not answer: not served. Pick the machine again to retry.');
  });

  it('creates a Pane on the picked machine, tagged so this desktop opens it there', async () => {
    const reply = await createPaneOn({ id: 'build-box' }, { prompt: '', worktreeTemplate: 'rotate-backup-keys', projectId: 4, baseBranch: 'origin/main', toolType: 'none' });

    expect(reply.success).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0].machineId).toBe('build-box');
    expect(runs[0].command).toMatchObject({ type: 'create-pane', request: { worktreeTemplate: 'rotate-backup-keys', projectId: 4, baseBranch: 'origin/main' } });
    expect(runs[0].command.type === 'create-pane' && 'clientRequestId' in runs[0].command.request).toBe(true);
  });

  it('creates a Session on the picked machine and returns its id', async () => {
    expect(await createSessionOn({ id: 'build-box', name: 'build-box' }, { name: 'Rotate keys', agent: 'codex' })).toBe('session-7');
    expect(runs).toEqual([{ machineId: 'build-box', command: { type: 'create-session', input: { name: 'Rotate keys', agent: 'codex' } } }]);
  });
});
