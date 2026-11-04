import { describe, expect, it } from 'vitest';

import type { ToolPanel } from '@shared/types/panels';

import { followsHost, pickPanel, sessionWorkspacePanels, stripPanels, tabView } from './panels';

function panel(id: string, type: ToolPanel['type'], position: number, customState?: object): ToolPanel {
  return {
    id,
    sessionId: 'pane-1',
    type,
    title: id,
    state: { isActive: false, customState },
    metadata: { createdAt: '', lastActiveAt: '', position },
  };
}

describe('stripPanels', () => {
  it('lists every tab: terminals, pages, Explorer and Diff, other tabs, then desktop-only tabs, each group in tab order', () => {
    const panels = [
      panel('notes', 'notes', 0),
      panel('diff', 'diff', 1),
      panel('run', 'logs', 2),
      panel('page', 'browser', 3),
      panel('shell', 'terminal', 4),
      panel('files', 'explorer', 5),
      panel('claude', 'terminal', 6),
      panel('file', 'editor', 7, { filePath: 'src/a.ts' }),
      panel('setup', 'setup-tasks', 8),
      panel('board', 'dashboard', 9),
    ];
    expect(stripPanels(panels).map(p => p.id)).toEqual(['shell', 'claude', 'page', 'diff', 'files', 'run', 'file', 'notes', 'setup', 'board']);
  });
});

describe('tabView', () => {
  it('draws terminals, pages, Explorer, Diff, open files and script output on the phone', () => {
    expect(tabView(panel('t', 'terminal', 0))).toBe('terminal');
    expect(tabView(panel('b', 'browser', 0))).toBe('browser');
    expect(tabView(panel('e', 'explorer', 0))).toBe('explorer');
    expect(tabView(panel('d', 'diff', 0))).toBe('diff');
    expect(tabView(panel('f', 'editor', 0, { filePath: 'README.md' }))).toBe('editor');
    expect(tabView(panel('l', 'logs', 0))).toBe('logs');
  });

  it('opens an editor showing a file’s changes as its patch', () => {
    const diffEditor = panel('d', 'editor', 0, { filePath: 'a.ts', diff: { kind: 'scope', scope: { kind: 'working-tree' } } });
    expect(tabView(diffEditor)).toBe('file-diff');
  });

  it('shows a placeholder for tabs whose data stays on the computer', () => {
    for (const type of ['notes', 'dashboard', 'setup-tasks'] as const) {
      expect(tabView(panel(type, type, 0))).toBe('placeholder');
    }
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

  it('falls back to the first tab when the host’s active tab is gone', () => {
    expect(pickPanel(panels, null, 'closed')?.id).toBe('claude');
    expect(pickPanel([], null, null)).toBeNull();
  });

  it('never opens on Explorer, Diff or a placeholder the host reports as active', () => {
    const strip = [panel('claude', 'terminal', 0), panel('page', 'browser', 1), panel('files', 'explorer', 2), panel('diff', 'diff', 3), panel('notes', 'notes', 4)];
    expect(pickPanel(strip, null, 'files')?.id).toBe('claude');
    expect(pickPanel(strip, null, 'diff')?.id).toBe('claude');
    expect(pickPanel(strip, null, 'notes')?.id).toBe('claude');
    expect(pickPanel(strip, null, 'page')?.id).toBe('page');
  });

  it('opens a tab picked on the phone whatever its type', () => {
    const strip = [panel('claude', 'terminal', 0), panel('files', 'explorer', 1)];
    expect(pickPanel(strip, 'files', 'claude')?.id).toBe('files');
  });
});

describe('followsHost', () => {
  it('follows the computer to tabs on its stage that the phone draws', () => {
    expect(followsHost(panel('t', 'terminal', 0))).toBe(true);
    expect(followsHost(panel('b', 'browser', 0))).toBe(true);
    expect(followsHost(panel('f', 'editor', 0, { filePath: 'a.ts' }))).toBe(true);
  });

  it('stays put for Explorer and Diff, which live in the desktop’s side panel, and for placeholders', () => {
    expect(followsHost(panel('e', 'explorer', 0))).toBe(false);
    expect(followsHost(panel('d', 'diff', 0))).toBe(false);
    expect(followsHost(panel('n', 'notes', 0))).toBe(false);
  });
});

describe('sessionWorkspacePanels', () => {
  const session = { panelIds: { claude: 'claude-chat', codex: 'codex-chat', cursor: 'cursor-chat' } };
  const workspace = [panel('shell', 'terminal', 0), panel('codex-chat', 'terminal', 1), panel('claude-chat', 'terminal', 2), panel('server', 'terminal', 3)];

  it('puts the current agent’s chat first, then the workspace’s own terminals, hiding other agents’ chats', () => {
    const tabs = sessionWorkspacePanels({ session, panel: panel('claude-chat', 'terminal', 2) }, workspace);
    expect(tabs.map(p => p.id)).toEqual(['claude-chat', 'shell', 'server']);
  });

  it('shows the chat the host returned before the panel list includes it', () => {
    const tabs = sessionWorkspacePanels({ session, panel: panel('cursor-chat', 'terminal', 9) }, [panel('shell', 'terminal', 0)]);
    expect(tabs.map(p => p.id)).toEqual(['cursor-chat', 'shell']);
  });
});
