import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import panePiBridge from './piBridge';

const rpc = vi.fn();
beforeEach(() => { vi.useFakeTimers(); rpc.mockReset(); vi.stubEnv('PANE_PEER_ID', 'pi-worker'); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

function runtime() {
  const context = { isIdle: () => true, sessionManager: { getSessionId: () => 'test' }, ui: { notify: vi.fn() } };
  const handlers = new Map<string, (event: { type: string }, ctx: typeof context) => void | Promise<void>>();
  const pi = {
    on: (event: string, handler: (event: { type: string }, ctx: typeof context) => void | Promise<void>) => { handlers.set(event, handler); },
    sendMessage: vi.fn(),
  };
  panePiBridge(pi, request => rpc('runpane:peers', [request]));
  return { pi, context, handlers, event: (name: string) => handlers.get(name)?.({ type: name }, context) };
}

describe('optional Pi native bridge', () => {
  it('delivers one native message and never mistakes a tool round or settled state for task completion', async () => {
    let status = 'received';
    rpc.mockImplementation(async (_channel, [request]) => {
      if (request.action === 'inbox') return { messages: request.claim ? [{ id: 'task-1', body: 'Implement', status: 'received' }] : [] };
      if (request.action === 'wait') return { message: { status } };
      return { ok: true, protocolVersion: 1 };
    });
    const run = runtime();
    await run.event('session_start');
    expect(run.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(run.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ details: { paneMessageId: 'task-1' } }), { triggerTurn: true, deliverAs: 'followUp' });
    expect(run.handlers.has('turn_end')).toBe(false);
    await run.event('agent_settled');
    await vi.advanceTimersByTimeAsync(1);
    expect(run.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.some(([, [request]]) => request.action === 'reply')).toBe(false);
    status = 'completed';
    rpc.mockImplementation(async (_channel, [request]) => request.action === 'wait' ? { message: { status } } : { messages: [], protocolVersion: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.pi.sendMessage).toHaveBeenCalledTimes(1);
    await run.event('session_shutdown');
  });

  it('does not replay a claim whose response was lost', async () => {
    let claimed = false;
    rpc.mockImplementation(async (_channel, [request]) => {
      if (request.action === 'inbox' && request.claim) { claimed = true; throw new Error('Connection lost after commit'); }
      if (request.action === 'inbox') return { messages: claimed ? [{ id: 'task-1', body: 'Task', status: 'received' }] : [] };
      return { protocolVersion: 1 };
    });
    const run = runtime();
    await run.event('session_start');
    await vi.advanceTimersByTimeAsync(10000);
    expect(run.pi.sendMessage).not.toHaveBeenCalled();
    expect(rpc.mock.calls.filter(([, [request]]) => request.claim)).toHaveLength(1);
    expect(run.context.ui.notify).toHaveBeenCalled();
    await run.event('session_shutdown');
  });

  it('leaves a task inspectable when shutdown happens after claiming', async () => {
    const run = runtime();
    rpc.mockImplementation(async (_channel, [request]) => {
      if (request.action === 'inbox' && request.claim) {
        await run.event('session_shutdown');
        return { messages: [{ id: 'task-1', body: 'Task', status: 'received' }] };
      }
      return { messages: [], protocolVersion: 1 };
    });
    await run.event('session_start');
    expect(run.pi.sendMessage).not.toHaveBeenCalled();
    const calls = rpc.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(rpc.mock.calls).toHaveLength(calls);
  });
});
