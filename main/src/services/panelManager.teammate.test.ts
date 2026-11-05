import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import type { ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPanelHandlers } from '../ipc/panels';
import { setPaneRuntime, type PaneRuntime } from '../core/runtime';
import { databaseService } from './database';
import { panelManager } from './panelManager';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member read by the tested code.
  return value as Contract;
}

// A panel keeps who created it, so its processes start the same way after a
// respawn or restart, whoever's request is running then.
describe('the teammate who created a panel', () => {
  let registry: PaneCommandRegistry;
  let sessionId: string;

  beforeEach(() => {
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send: vi.fn() } }));
    registry = new PaneCommandRegistry();
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    sessionId = `pane-${Math.random().toString(36).slice(2)}`;
    databaseService.createSession({
      id: sessionId, name: sessionId, initial_prompt: '', worktree_name: sessionId,
      worktree_path: '/tmp/pane-teammate', project_id: null, tool_type: 'none',
    });
  });

  async function create(teammate: string | null, metadata?: Partial<ToolPanel['metadata']>): Promise<ToolPanel> {
    const request = { sessionId, type: 'terminal' as const, title: 'Terminal', activate: false, metadata };
    const result = teammate
      ? await registry.invokeRemote('panels:create', [request], { teammate })
      : await registry.invoke('panels:create', [request]);
    // SAFETY: panels:create answers { success, data: ToolPanel }.
    return (result as { data: ToolPanel }).data;
  }

  it('is recorded on the panel and survives a later update and a reload', async () => {
    const panel = await create('bob@example.com', { teammate: undefined });
    await registry.invokeRemote('panels:update', [panel.id, { metadata: { ...panel.metadata, teammate: undefined } }], { teammate: 'bob@example.com' });

    expect(panelManager.getPanel(panel.id)?.metadata.teammate).toBe('bob@example.com');
    expect(databaseService.getPanel(panel.id)?.metadata?.teammate).toBe('bob@example.com');
  });

});
