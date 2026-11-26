import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessageRecord } from '../../../shared/types/agentMessages';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { AgentMessageService } from '../services/agentMessages/agentMessageService';
import { AgentMessageStore } from '../services/agentMessages/agentMessageStore';
import { registerAgentMessageHandlers } from './agentMessages';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup(count: number): PaneCommandRegistry {
  const db = new Database(':memory:');
  dbs.push(db);
  const panel = (panelId: string) => ({ panelId, paneId: `pane-${panelId}`, sessionId: null, name: panelId, orchestrator: false, agent: true });
  const service = new AgentMessageService(new AgentMessageStore(db), {
    panel, orchestratorPanel: () => null, isPanelDown: async () => false, resumePanel: async () => true,
    isMidTurn: () => false, hasUnsentText: async () => false, typeIntoTab: async () => 'delivered', log: () => undefined,
  });
  for (let index = 0; index < count; index++) service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: `Q${index}` });
  const registry = new PaneCommandRegistry();
  registerAgentMessageHandlers({ handle: () => undefined }, { agentMessageService: service }, registry);
  return registry;
}

async function page(registry: PaneCommandRegistry, ...args: Array<string | { before?: string | number; limit?: number }>): Promise<string[]> {
  // SAFETY: agent-messages:for-panel answers { success, data: AgentMessageRecord[] }.
  const response = await registry.invoke('agent-messages:for-panel', args) as { success: boolean; data?: AgentMessageRecord[]; error?: string };
  if (!response.success) throw new Error(response.error);
  return (response.data ?? []).map(record => record.ref);
}

describe('agent-messages:for-panel (T-105 reads a tab\'s messages)', () => {
  it('returns at most 200, newest first, and pages back with before', async () => {
    const registry = setup(203);
    const first = await page(registry, 'a');
    expect(first).toHaveLength(200);
    expect(first[0]).toBe('M-203');
    expect(await page(registry, 'a', { before: first.at(-1) ?? '' })).toEqual(['M-3', 'M-2', 'M-1']);
    expect(await page(registry, 'a', { before: 3, limit: 1 })).toEqual(['M-2']);
  });

  it('refuses a cursor that is not a message id, and a page size that is not a whole number', async () => {
    const registry = setup(1);
    await expect(page(registry, 'a', { before: 'yesterday' })).rejects.toThrow(/not a message id/);
    await expect(page(registry, 'a', { limit: 1.5 })).rejects.toThrow(/not a whole number/);
    await expect(page(registry, 'a', { limit: 0 })).rejects.toThrow(/not a whole number/);
  });
});
