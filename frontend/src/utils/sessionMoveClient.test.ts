import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MOVE_CHANNELS } from '../../../shared/types/sessionMove';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import { checkSessionMove, sessionMovePeers, sessionMoveStatus, startSessionMove } from './sessionMoveClient';
import { confirmingReason } from './sessionMoveView';

const preflight = { target: 'studio-b', ready: true, checks: [{ id: 'repos', level: 'ok', title: 'Repositories found' }], paneCount: 2, tabCount: 3, bytes: 10 };
const progress = {
  moveId: 'm1', sessionId: 's1', sessionName: 'Alpha', target: 'studio-b', phase: 'waiting', waiting: [], stoppedTabs: 1, totalTabs: 3,
  steps: [], frozen: false, updatedAt: '2026-11-15T10:00:00Z',
};

let invoked: Array<{ channel: string; args: unknown[] }>;
let runs: Array<{ machineId: string; command: unknown }>;
let answer: (channel: string) => JsonValue;

beforeEach(() => {
  invoked = [];
  runs = [];
  answer = channel => (channel === SESSION_MOVE_CHANNELS.check ? preflight : channel === SESSION_MOVE_CHANNELS.status ? null : progress);
  vi.stubGlobal('window', {
    electronAPI: {
      invoke: async (channel: string, ...args: unknown[]) => { invoked.push({ channel, args }); return answer(channel); },
      machines: {
        run: async (machineId: string, command: { channel: string }) => { runs.push({ machineId, command }); return { machineId, data: answer(command.channel) }; },
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('the move client', () => {
  it('calls this host with one object argument', async () => {
    await expect(checkSessionMove({ kind: 'here' }, 's1', 'studio-b')).resolves.toEqual(preflight);
    await expect(sessionMoveStatus({ kind: 'here' }, 's1', true)).resolves.toBeNull();
    expect(invoked).toEqual([
      { channel: 'runpane:sessions:move-check', args: [{ sessionId: 's1', target: 'studio-b' }] },
      { channel: 'runpane:sessions:move-status', args: [{ sessionId: 's1', recheck: true }] },
    ]);
  });

  it('carries the call to a machine in All machines as a move-session command', async () => {
    await expect(startSessionMove({ kind: 'machine', machineId: 'build' }, 's1', 'studio-b')).resolves.toEqual(progress);
    expect(runs).toEqual([{ machineId: 'build', command: { type: 'move-session', channel: 'runpane:sessions:move', request: { sessionId: 's1', target: 'studio-b' } } }]);
  });

  it('throws what a refusing machine said, and peers fall back to none', async () => {
    answer = () => ({ success: false, error: 'Session alpha is not on this machine' });
    await expect(startSessionMove({ kind: 'machine', machineId: 'build' }, 's1', 'studio-b')).rejects.toThrow('Session alpha is not on this machine');
    await expect(sessionMovePeers({ kind: 'here' })).resolves.toEqual([]);
  });

  it('keeps why a frozen move waits, so the recovery screen can say it (QA r2: the reason line never showed)', async () => {
    const confirming = {
      ...progress, phase: 'confirming', frozen: true, waitReason: 'unreachable',
      error: { message: 'studio-b isn’t answering (timed out).', next: 'Open Pane on studio-b.' },
    };
    answer = () => confirming;
    for (const where of [{ kind: 'here' as const }, { kind: 'machine' as const, machineId: 'build' }]) {
      const received = await sessionMoveStatus(where, 's1');
      expect(received?.waitReason).toBe('unreachable');
      expect(received && confirmingReason(received)?.title).toBe('studio-b isn’t answering');
    }
  });

  it('refuses an answer that is not a preflight', async () => {
    answer = () => ({ target: 'studio-b' });
    await expect(checkSessionMove({ kind: 'here' }, 's1', 'studio-b')).rejects.toThrow(/ready/);
  });
});
