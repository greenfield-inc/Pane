import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineHealthCard } from '../../../../shared/types/machineHealth';
import { askAgentAbout, type HealthNotifyItem } from './healthCardActions';

function card(over: Partial<HealthNotifyItem>): HealthNotifyItem {
  const machineHealth: MachineHealthCard = { kind: 'memory', level: 'warning', hostname: 'DESKTOP-7Q2K.local', rows: [], agentPrompt: 'Free memory.' };
  // SAFETY: askAgentAbout reads only machineId, machine and machineHealth.
  return { id: 'n1', title: 'Memory is tight', machineHealth, ...over } as HealthNotifyItem;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('askAgentAbout', () => {
  it('tells the agent to reach a linked machine by its saved id, which runpane workspace resolves', async () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal('window', { electronAPI: { invoke } });
    await askAgentAbout(card({ machineId: 'devbox-a1', machine: 'Build box' }));
    expect(invoke).toHaveBeenCalledWith('resource-monitor:machine-ask-agent', {
      prompt: 'This is about the linked machine Build box. Run each runpane command there as `runpane workspace devbox-a1 <command>`. Free memory.',
    });
  });
});
