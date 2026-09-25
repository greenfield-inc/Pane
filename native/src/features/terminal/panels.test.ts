import { describe, expect, it } from 'vitest';

import type { ToolPanel } from '@shared/types/panels';

import { pickPanel, terminalPanels } from './panels';

function panel(id: string, type: ToolPanel['type'], position: number): ToolPanel {
  return {
    id,
    sessionId: 'pane-1',
    type,
    title: id,
    state: { isActive: false },
    metadata: { createdAt: '', lastActiveAt: '', position },
  };
}

describe('terminalPanels', () => {
  it('keeps terminal panels in tab order', () => {
    const panels = [panel('codex', 'terminal', 2), panel('diff', 'diff', 0), panel('claude', 'terminal', 1)];
    expect(terminalPanels(panels).map(p => p.id)).toEqual(['claude', 'codex']);
  });
});

describe('pickPanel', () => {
  const panels = [panel('claude', 'terminal', 0), panel('shell', 'terminal', 1)];

  it('keeps the tab picked on the phone', () => {
    expect(pickPanel(panels, 'shell', 'claude')?.id).toBe('shell');
  });

  it('follows the host when nothing is picked or the picked tab closed', () => {
    expect(pickPanel(panels, null, 'shell')?.id).toBe('shell');
    expect(pickPanel(panels, 'closed', 'shell')?.id).toBe('shell');
  });

  it('falls back to the first tab when the host has a non-terminal panel active', () => {
    expect(pickPanel(panels, null, 'diff')?.id).toBe('claude');
    expect(pickPanel([], null, null)).toBeNull();
  });
});
