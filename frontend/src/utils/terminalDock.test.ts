import { describe, expect, it } from 'vitest';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { getDockTerminalPanel } from './terminalDock';

const terminal = (id: string, customState: TerminalPanelState = {}): ToolPanel => ({
  id, sessionId: 'session', type: 'terminal', title: id,
  state: { isActive: false, customState },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

describe('getDockTerminalPanel', () => {
  it('keeps the first plain shell in the dock and leaves additional shells as tabs', () => {
    const shell = terminal('shell');
    expect(getDockTerminalPanel([shell, terminal('extra')])).toBe(shell);
  });

  it.each([
    { initialCommand: 'codex --yolo' },
    { initialCommand: 'claude --dangerously-skip-permissions' },
    { initialCommand: 'pnpm dev' },
    { agentType: 'codex' as const },
    { agentType: 'claude' as const },
    { isCliPanel: true },
  ])('never promotes a tool after deleting its shell: %j', state => {
    const agent = terminal('agent', state);
    const shell = terminal('shell');
    expect(getDockTerminalPanel([agent, shell])).toBe(shell);
    expect(getDockTerminalPanel([agent])).toBeUndefined();
  });

  it('ignores inspector panels and supports legacy shells without custom state', () => {
    const shell = { ...terminal('shell'), state: { isActive: false } };
    const inspector: ToolPanel = { ...terminal('files'), type: 'explorer' };
    expect(getDockTerminalPanel([inspector, shell])).toBe(shell);
    expect(getDockTerminalPanel([])).toBeUndefined();
  });
});
