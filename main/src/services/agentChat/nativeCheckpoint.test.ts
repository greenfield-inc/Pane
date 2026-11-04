import { describe, expect, it } from 'vitest';
import { NativeCheckpoint } from './nativeCheckpoint';

describe('native conversation handoff checkpoint', () => {
  it('permits a checkpoint only after the provider reports no background work or scheduled wakeups', () => {
    const checkpoint = new NativeCheckpoint('conversation-a');
    checkpoint.observe({ session_id: 'conversation-a', hook_event_name: 'Stop', background_tasks: [], session_crons: [] });
    expect(checkpoint.read()).toEqual({ ready: true });
  });

  it('keeps a completed turn in Terminal while its background shell still runs', () => {
    const checkpoint = new NativeCheckpoint('conversation-a');
    checkpoint.observe({
      session_id: 'conversation-a',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      background_tasks: [{ id: 'shell-a', type: 'shell', status: 'running' }],
      session_crons: [],
    });
    expect(checkpoint.read()).toEqual({
      ready: false,
      reason: 'Background work is still running. Wait for it to finish before switching.',
    });
  });

  it('withdraws an earlier checkpoint when a permission, new input or incomplete provider report arrives', () => {
    const checkpoint = new NativeCheckpoint('conversation-a');
    const stopped = { session_id: 'conversation-a', hook_event_name: 'Stop', background_tasks: [], session_crons: [] };
    checkpoint.observe(stopped);
    checkpoint.observe({ session_id: 'conversation-a', hook_event_name: 'PermissionRequest' });
    expect(checkpoint.read().ready).toBe(false);
    checkpoint.observe(stopped);
    checkpoint.input();
    expect(checkpoint.read().ready).toBe(false);
    checkpoint.observe({ ...stopped, session_id: 'conversation-b' });
    expect(checkpoint.read().ready).toBe(false);
    checkpoint.observe(stopped);
    checkpoint.observe({ session_id: 'conversation-a', hook_event_name: 'Stop' });
    expect(checkpoint.read().ready).toBe(false);
    checkpoint.observe(stopped);
    checkpoint.observe({ ...stopped, session_crons: [{ id: 'wake-up' }] });
    expect(checkpoint.read().ready).toBe(false);
  });
});
