import { describe, expect, it } from 'vitest';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { resolveTerminalPanelKind } from './terminalPanelKind';

const terminal = (id: string, customState: TerminalPanelState = {}): ToolPanel => ({
  id, sessionId: 'session', type: 'terminal', title: id,
  state: { isActive: false, customState },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

describe('resolveTerminalPanelKind', () => {
  it.each([
    { initialCommand: 'claude --dangerously-skip-permissions' },
    { initialCommand: '/usr/local/bin/codex --yolo' },
    { agentType: 'cursor' as const, initialCommand: 'agent-farm run' },
    { isCliPanel: true },
  ])('calls an agent tab an agent: %j', state => {
    const agent = terminal('agent', state);
    expect(resolveTerminalPanelKind(agent, [agent])).toBe('agent');
  });

  it('calls a tab running another command a command', () => {
    const command = terminal('command', { initialCommand: 'pnpm dev' });
    expect(resolveTerminalPanelKind(command, [command])).toBe('command');
  });

  it('calls the first plain shell the dock and later plain shells tabs', () => {
    const agent = terminal('agent', { initialCommand: 'claude' });
    const dock = terminal('dock');
    const shell = terminal('shell');
    const panels = [agent, dock, shell];
    expect(resolveTerminalPanelKind(dock, panels)).toBe('dock');
    expect(resolveTerminalPanelKind(shell, panels)).toBe('shell');
  });

  it('judges the spawning panel by its own state, stored or not', () => {
    const storedAsShell = terminal('panel');
    const launching = terminal('panel', { initialCommand: 'pnpm dev' });
    const shell = terminal('shell');
    expect(resolveTerminalPanelKind(launching, [storedAsShell, shell])).toBe('command');
    expect(resolveTerminalPanelKind(shell, [storedAsShell, shell])).toBe('shell');

    const unstored = terminal('unstored');
    expect(resolveTerminalPanelKind(unstored, [])).toBe('dock');
    expect(resolveTerminalPanelKind(unstored, [shell])).toBe('shell');
  });
});
