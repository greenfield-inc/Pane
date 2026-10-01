import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';
import type { ToolPanel } from '../../../shared/types/panels';
import { markTerminalPanelsInterrupted } from './terminalShutdown';

function panel(id: string, sessionId: string, customState: JsonObject): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title: id,
    state: { isActive: true, customState },
    metadata: {
      createdAt: '2026-09-30T00:00:00.000Z',
      lastActiveAt: '2026-09-30T00:00:00.000Z',
      position: 0,
    },
  };
}

describe('markTerminalPanelsInterrupted', () => {
  it('marks OpenCode, legacy native agents, and custom resumes while isolating malformed state', async () => {
    const panels = [
      panel('opencode', 'session-opencode', { agentType: 'opencode' }),
      panel('legacy', 'session-legacy', { agentType: 'claude' }),
      panel('custom', 'session-custom', {
        customResume: {
          mode: 'generated',
          resumeTemplate: '{command} --resume {sessionId}',
          initialTemplate: '{command}',
        },
      }),
      panel('malformed', 'session-bad', { agentType: 'not-an-agent' }),
    ];
    const getPanel = (id: string) => panels.find(candidate => candidate.id === id);
    const updatePanel = vi.fn(async (id: string, updates: Partial<ToolPanel>) => {
      const found = getPanel(id);
      if (found && updates.state) found.state = updates.state;
    });

    const interrupted = await markTerminalPanelsInterrupted(
      panels.map(candidate => candidate.id),
      getPanel,
      updatePanel,
    );

    expect(interrupted).toEqual(new Map([
      ['session-opencode', ['opencode']],
      ['session-legacy', ['legacy']],
      ['session-custom', ['custom']],
    ]));
    expect(updatePanel).toHaveBeenCalledTimes(3);
    expect(panels[0].state.customState).toMatchObject({ agentType: 'opencode', wasInterrupted: true });
    expect(panels[1].state.customState).toMatchObject({ agentType: 'claude', wasInterrupted: true });
    expect(panels[3].state.customState).toEqual({ agentType: 'not-an-agent' });
  });
});
