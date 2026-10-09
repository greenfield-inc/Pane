import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPanelHandlers } from '../ipc/panels';
import { setPaneRuntime, type PaneRuntime } from '../core/runtime';
import { databaseService } from './database';
import { panelManager } from './panelManager';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

// Two clients on one Pane: a client's own tab choice is remembered by the host
// as last used and moves nobody; a host-initiated activation goes out as a
// request (panel:activeChanged) that clients on that Pane follow.
describe('panel activation', () => {
  const send = vi.fn();
  let registry: PaneCommandRegistry;
  let sessionId: string;

  const activationRequests = () => send.mock.calls
    .filter(([channel]) => channel === 'panel:activeChanged')
    .map(([, payload]) => payload);
  const lastUsed = async () => {
    const active = await registry.invoke('panels:getActive', [sessionId]);
    return (active as { id: string } | null)?.id ?? null;
  };
  const tab = async (title: string) => (await panelManager.createPanel({ sessionId, type: 'logs', title, activate: false })).id;

  beforeEach(() => {
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send } }));
    registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    sessionId = `pane-${Math.random().toString(36).slice(2)}`;
    databaseService.createSession({
      id: sessionId, name: sessionId, initial_prompt: '', worktree_name: sessionId,
      worktree_path: '/tmp/pane-activation', project_id: null, tool_type: 'none',
    });
  });

  afterEach(() => send.mockReset());

  it('records a client tab click as last used without asking any client to move', async () => {
    const u = await tab('U');
    const v = await tab('V');
    send.mockReset();

    await expect(registry.invoke('panels:set-active', [sessionId, u])).resolves.toEqual({ success: true });
    await expect(registry.invoke('panels:set-active', [sessionId, v])).resolves.toEqual({ success: true });

    expect(await lastUsed()).toBe(v);
    expect(activationRequests()).toEqual([]);
  });

  it('asks clients on the Pane to show a host-activated tab', async () => {
    const u = await tab('U');
    send.mockReset();

    await panelManager.setActivePanel(sessionId, u);

    expect(await lastUsed()).toBe(u);
    expect(activationRequests()).toEqual([{ sessionId, panelId: u }]);
  });

  it('carries placement when the host opens a new tab that comes forward', async () => {
    const page = await panelManager.createPanel({
      sessionId, type: 'logs', title: 'Page', metadata: { openPlacement: 'split' }, announceActivation: true,
    });

    expect(await lastUsed()).toBe(page.id);
    expect(activationRequests()).toEqual([{ sessionId, panelId: page.id, placement: 'split' }]);
  });

  it('creates a client tab as last used without moving other clients', async () => {
    const created = await panelManager.createPanel({ sessionId, type: 'logs', title: 'Mine' });

    expect(await lastUsed()).toBe(created.id);
    expect(activationRequests()).toEqual([]);
  });

  it('moves the last-used tab off a closed tab without moving clients that show other tabs', async () => {
    const t = await tab('T');
    const u = await tab('U');
    await registry.invoke('panels:set-active', [sessionId, t]);
    send.mockReset();

    await panelManager.deletePanel(t);

    expect(await lastUsed()).toBe(u);
    expect(activationRequests()).toEqual([]);
  });
});
