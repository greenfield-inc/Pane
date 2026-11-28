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

  it('gives the sheet and approvals commands their keys, with no clash on any platform', () => {
    const keys = (id: string) => {
      const entry = getCatalogEntry(id);
      expect(entry, id).toBeDefined();
      return entry ? [defaultChordFor(entry, 'mac'), defaultChordFor(entry, 'other')] : [];
    };
    expect(keys('show-keyboard-shortcuts')).toEqual(['mod+/', 'mod+k mod+/']);
    expect(keys('toggle-approvals')).toEqual(['mod+shift+a', 'mod+shift+a']);
    expect(keys('open-session-approval')).toEqual(['mod+alt+a', 'mod+k mod+a']);
    expect(keys('send-approval')).toEqual(['mod+Enter', 'mod+Enter']);
    for (const id of ['next-approval', 'previous-approval', 'approvals-group-by']) expect(keys(id)).toEqual([null, null]);
    for (const platform of ['mac', 'other'] as const) {
      const seen = new Map<string, string>();
      for (const entry of KEYBOARD_SHORTCUT_CATALOG) {
        const chord = defaultChordFor(entry, platform);
        if (!chord) continue;
        const clash = seen.get(chord);
        if (clash) expect(scopesOverlap(entry.scope, getCatalogEntry(clash)?.scope ?? 'app'), `${platform}: ${clash}/${entry.id}`).toBe(false);
        seen.set(chord, entry.id);
      }
    }
  });

  it('keeps AltGr letters off the new defaults outside macOS', () => {
    // Ctrl+Alt+<letter> is AltGr+<letter> on many Windows and Linux layouts.
    for (const id of ['show-keyboard-shortcuts', 'toggle-approvals', 'open-session-approval', 'send-approval']) {
      const entry = getCatalogEntry(id);
      const chord = entry ? defaultChordFor(entry, 'other') ?? '' : '';
      for (const step of chord.split(' ')) expect(/(^|\+)alt\+/.test(step) && /\+[a-z0-9]$/.test(step), `${id}: ${chord}`).toBe(false);
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
      .toEqual(['mod+alt+3', 'mod+alt+4', 'mod+alt+5', 'mod+alt+6', 'mod+alt+shift+p', 'mod+alt+shift+a']);
    expect(getCatalogEntry('add-tool-terminal-cursor')?.platforms).toEqual(['darwin', 'linux', 'wsl']);
  });

  it('pins interception flags', () => {
    const notReleasedFromTerminal = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => !entry.releaseFromTerminal)
      .map(entry => entry.id);
    expect(notReleasedFromTerminal).toEqual(['send-approval', 'usage-share']);
    const notForwarded = KEYBOARD_SHORTCUT_CATALOG.filter(entry => !entry.forwardFromWebview).map(entry => entry.id).sort();
    expect(notForwarded).toEqual(['find-in-tab', 'find-next', 'find-previous', 'send-approval', 'show-keyboard-shortcuts', 'split-down', 'split-right', 'usage-download', 'usage-share']);
    const releasedInTui = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => entry.releaseInTui)
      .map(entry => entry.id)
      .sort();
    expect(releasedInTui).toEqual([
      'add-tool-custom-0', 'add-tool-custom-1', 'add-tool-custom-2', 'add-tool-custom-3',
      'add-tool-explorer', 'add-tool-terminal', 'add-tool-terminal-agy', 'add-tool-terminal-claude',
      'add-tool-terminal-codex', 'add-tool-terminal-cursor', 'add-tool-terminal-opencode', 'add-tool-terminal-pi',
      'cycle-session-next-0', 'cycle-session-prev-0',
      // New navigation keys (D-236): they reach Pane from vim and agent interfaces.
      'cycle-sidebar-session-next', 'cycle-sidebar-session-prev',
      'cycle-tab-next-d', 'cycle-tab-prev-a',
      'focus-group-down', 'focus-group-left', 'focus-group-right', 'focus-group-up',
      'focus-next-region', 'focus-previous-region', 'focus-sidebar',
      'minimize-region', 'next-approval', 'next-machine', 'open-command-palette', 'open-machine-switcher',
      'open-session-approval', 'open-shortcut-settings', 'previous-approval', 'show-keyboard-shortcuts', 'toggle-approvals',
      'panel-tab-1', 'panel-tab-2', 'panel-tab-3', 'panel-tab-4',
      'panel-tab-5', 'panel-tab-6', 'panel-tab-7', 'panel-tab-8', 'panel-tab-9',
      'previous-machine', 'split-down', 'split-right',
      ...Array.from({ length: 9 }, (_, index) => `switch-session-${index + 1}`),
      'toggle-all-machines', 'toggle-detail-panel', 'toggle-terminal', 'zoom-toggle',
    ].sort());
  });
});
