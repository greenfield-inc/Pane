import { describe, expect, it } from 'vitest';
import { AGENT_LAUNCH_PRESETS } from '../../../shared/constants/agentLaunchPresets';
import {
  defaultChordFor,
  getCatalogEntry,
  KEYBOARD_SHORTCUT_CATALOG,
  scopesOverlap,
} from '../../../shared/constants/keyboardShortcuts';

describe('keyboard shortcut catalog', () => {
  it('lists every command id registered in the renderer', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const { join } = await import('path');
    const root = join(__dirname, '../../../frontend/src');
    const ids = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/useHotkey\(\{\s*id:\s*['`]([^'`$]+)['`]/g)) ids.add(match[1]);
      }
    };
    walk(root);
    expect(ids.size).toBeGreaterThan(20);
    for (const id of ids) expect(getCatalogEntry(id), id).toBeDefined();
  });

  it('has unique ids and only the intentional exclusive default duplicate', () => {
    expect(new Set(KEYBOARD_SHORTCUT_CATALOG.map(entry => entry.id)).size).toBe(KEYBOARD_SHORTCUT_CATALOG.length);
    for (let left = 0; left < KEYBOARD_SHORTCUT_CATALOG.length; left += 1) {
      for (let right = left + 1; right < KEYBOARD_SHORTCUT_CATALOG.length; right += 1) {
        const a = KEYBOARD_SHORTCUT_CATALOG[left];
        const b = KEYBOARD_SHORTCUT_CATALOG[right];
        if (a.defaultChord && (a.defaultChord === b.defaultChord || a.defaultChord.split(' ')[0] === b.defaultChord?.split(' ')[0] && a.defaultChord.split(' ').length !== b.defaultChord.split(' ').length)) {
          expect(scopesOverlap(a.scope, b.scope), `${a.id}/${b.id}`).toBe(false);
        }
      }
    }
  });

  it('keeps the menu\'s Actual Size key off every default, and ⌘0 for Focus Sidebar', async () => {
    const { RESET_ZOOM_ACCELERATOR } = await import('../services/nativeMenus');
    expect(RESET_ZOOM_ACCELERATOR).toBe('CmdOrCtrl+Shift+0');
    for (const platform of ['mac', 'other'] as const) {
      const defaults = KEYBOARD_SHORTCUT_CATALOG.map(entry => defaultChordFor(entry, platform));
      expect(defaults).not.toContain('mod+shift+0');
      expect(defaults).toContain('mod+0');
    }
  });

  it('matches agent defaults and platform gates', () => {
    expect(AGENT_LAUNCH_PRESETS.map(preset => getCatalogEntry(preset.hotkeyId)?.defaultChord))
      .toEqual(['mod+alt+3', 'mod+alt+4', 'mod+alt+5', 'mod+alt+6', 'mod+alt+shift+p']);
    expect(getCatalogEntry('add-tool-terminal-cursor')?.platforms).toEqual(['darwin', 'linux', 'wsl']);
  });

  it('pins interception flags', () => {
    const notReleasedFromTerminal = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => !entry.releaseFromTerminal)
      .map(entry => entry.id);
    expect(notReleasedFromTerminal).toEqual(['usage-share']);
    const notForwarded = KEYBOARD_SHORTCUT_CATALOG.filter(entry => !entry.forwardFromWebview).map(entry => entry.id).sort();
    expect(notForwarded).toEqual(['find-in-tab', 'find-next', 'find-previous', 'split-down', 'split-right', 'usage-download', 'usage-share']);
    const releasedInTui = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => entry.releaseInTui)
      .map(entry => entry.id)
      .sort();
    expect(releasedInTui).toEqual([
      'add-tool-custom-0', 'add-tool-custom-1', 'add-tool-custom-2', 'add-tool-custom-3',
      'add-tool-explorer', 'add-tool-terminal', 'add-tool-terminal-claude',
      'add-tool-terminal-codex', 'add-tool-terminal-cursor', 'add-tool-terminal-opencode', 'add-tool-terminal-pi',
      'cycle-session-next-0', 'cycle-session-prev-0',
      // New navigation keys (D-236): they reach Pane from vim and agent interfaces.
      'cycle-sidebar-session-next', 'cycle-sidebar-session-prev',
      'cycle-tab-next-d', 'cycle-tab-prev-a',
      'focus-group-down', 'focus-group-left', 'focus-group-right', 'focus-group-up',
      'focus-next-region', 'focus-previous-region', 'focus-sidebar',
      'minimize-region', 'next-machine', 'open-command-palette', 'open-machine-switcher',
      'open-shortcut-settings',
      'panel-tab-1', 'panel-tab-2', 'panel-tab-3', 'panel-tab-4',
      'panel-tab-5', 'panel-tab-6', 'panel-tab-7', 'panel-tab-8', 'panel-tab-9',
      'previous-machine', 'split-down', 'split-right',
      ...Array.from({ length: 9 }, (_, index) => `switch-session-${index + 1}`),
      'toggle-all-machines', 'toggle-detail-panel', 'toggle-terminal', 'zoom-toggle',
    ].sort());
  });
});
