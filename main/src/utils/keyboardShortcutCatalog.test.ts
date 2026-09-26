import { describe, expect, it } from 'vitest';
import { AGENT_LAUNCH_PRESETS } from '../../../shared/constants/agentLaunchPresets';
import {
  getCatalogEntry,
  KEYBOARD_SHORTCUT_CATALOG,
  scopesOverlap,
} from '../../../shared/constants/keyboardShortcuts';

describe('keyboard shortcut catalog', () => {
  it('matches the complete audited registration inventory', () => {
    const expected = [
      'open-command-palette', 'toggle-sidebar', 'open-settings', 'focus-sidebar',
      'open-shortcut-settings', 'new-session', 'new-project', 'cycle-tab-prev-a',
      'cycle-tab-next-d', 'add-tool-terminal', 'add-tool-explorer',
      'add-tool-terminal-claude', 'add-tool-terminal-codex', 'add-tool-terminal-cursor',
      'close-active-tab', 'archive-active-session', 'split-right', 'split-down',
      'focus-group-left', 'focus-group-right', 'focus-group-up', 'focus-group-down',
      'zoom-toggle', 'git-commit', 'git-push', 'git-soft-reset', 'git-pull',
      'git-rebase-from-main', 'git-merge-to-main', 'cycle-session-next-0',
      'cycle-session-prev-0', 'cycle-sidebar-session-next', 'cycle-sidebar-session-prev',
      'toggle-terminal', 'toggle-detail-panel', 'open-add-tool', 'run-dev-server',
      'usage-download', 'usage-share', 'scroll-focused-surface-up',
      'scroll-focused-surface-down', 'page-focused-surface-up', 'page-focused-surface-down',
      ...Array.from({ length: 9 }, (_, index) => `panel-tab-${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `switch-session-${index + 1}`),
      ...Array.from({ length: 4 }, (_, index) => `add-tool-custom-${index}`),
    ].sort();
    expect(KEYBOARD_SHORTCUT_CATALOG.map(entry => entry.id).sort()).toEqual(expected);
  });

  it('has unique ids and only the intentional exclusive default duplicate', () => {
    expect(new Set(KEYBOARD_SHORTCUT_CATALOG.map(entry => entry.id)).size).toBe(KEYBOARD_SHORTCUT_CATALOG.length);
    for (let left = 0; left < KEYBOARD_SHORTCUT_CATALOG.length; left += 1) {
      for (let right = left + 1; right < KEYBOARD_SHORTCUT_CATALOG.length; right += 1) {
        const a = KEYBOARD_SHORTCUT_CATALOG[left];
        const b = KEYBOARD_SHORTCUT_CATALOG[right];
        if (a.defaultChord && a.defaultChord === b.defaultChord) {
          expect(scopesOverlap(a.scope, b.scope), `${a.id}/${b.id}`).toBe(false);
        }
      }
    }
  });

  it('matches agent defaults and platform gates', () => {
    expect(AGENT_LAUNCH_PRESETS.map(preset => getCatalogEntry(preset.hotkeyId)?.defaultChord))
      .toEqual(['mod+alt+3', 'mod+alt+4', 'mod+alt+5']);
    expect(getCatalogEntry('add-tool-terminal-cursor')?.platforms).toEqual(['darwin', 'linux', 'wsl']);
  });

  it('pins interception flags', () => {
    const notReleasedFromTerminal = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => !entry.releaseFromTerminal)
      .map(entry => entry.id);
    expect(notReleasedFromTerminal).toEqual(['usage-share']);
    const notForwarded = KEYBOARD_SHORTCUT_CATALOG.filter(entry => !entry.forwardFromWebview).map(entry => entry.id).sort();
    expect(notForwarded).toEqual(['split-down', 'split-right', 'usage-download', 'usage-share']);
    const releasedInTui = KEYBOARD_SHORTCUT_CATALOG
      .filter(entry => entry.releaseInTui)
      .map(entry => entry.id)
      .sort();
    expect(releasedInTui).toEqual([
      'add-tool-custom-0', 'add-tool-custom-1', 'add-tool-custom-2', 'add-tool-custom-3',
      'add-tool-explorer', 'add-tool-terminal', 'add-tool-terminal-claude',
      'add-tool-terminal-codex', 'add-tool-terminal-cursor', 'cycle-session-next-0',
      'cycle-session-prev-0', 'focus-group-down', 'focus-group-left', 'focus-group-right',
      'focus-group-up', 'panel-tab-1', 'panel-tab-2', 'panel-tab-3', 'panel-tab-4',
      'panel-tab-5', 'panel-tab-6', 'panel-tab-7', 'panel-tab-8', 'panel-tab-9',
      'split-down', 'split-right', 'zoom-toggle',
    ]);
  });
});
