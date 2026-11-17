import { describe, expect, it } from 'vitest';
import { KEYBOARD_SHORTCUT_CATALOG } from '../../../shared/constants/keyboardShortcuts';
import { buildShortcutMap } from './shortcutMap';
import { buildShortcutSheet, searchShortcutSheet, SHEET_GROUPS, type SheetGroup } from './shortcutSheet';

const mac = { keyPlatform: 'mac' as const, environment: 'darwin' };
const other = { keyPlatform: 'other' as const, environment: 'win32' };

function sheet(options: { platform?: 'mac' | 'other'; overridesRaw?: Record<string, string | null>; answerAll?: string } = {}) {
  const platform = options.platform ?? 'mac';
  const map = buildShortcutMap({ ...(platform === 'mac' ? mac : other), overridesRaw: options.overridesRaw });
  return buildShortcutSheet({ rows: map.rows, answerAll: options.answerAll ?? 'Control+Shift+Space', mac: platform === 'mac' });
}

const group = (groups: SheetGroup[], id: string) => groups.find(candidate => candidate.id === id);
const row = (groups: SheetGroup[], groupId: string, label: string) => group(groups, groupId)?.rows.find(candidate => candidate.label === label);
const caps = (groups: SheetGroup[], groupId: string, label: string) => row(groups, groupId, label)?.keys.map(key => key.kind === 'key' ? key.text : '…');

describe('buildShortcutSheet', () => {
  it('lays out the groups in rail order', () => {
    expect(sheet().map(candidate => candidate.name)).toEqual([
      'Navigation', 'Tabs and splits', 'Find', 'Chat', 'Approvals', 'Panes and Sessions', 'View',
      'Machines', 'Git', 'Tools', 'Terminal', 'Sidebar', 'Help',
    ]);
    expect(SHEET_GROUPS).toHaveLength(13);
  });

  it('lists the approvals keys in the reference order, with palette-only commands keyless', () => {
    const groups = sheet();
    expect(group(groups, 'approvals')?.rows.map(candidate => candidate.label)).toEqual([
      'Open or close Approvals',
      'Open this Session’s approval (from its chat)',
      'Next / previous approval (from anywhere; set your own key)',
      'Next / previous approval (in the approval)',
      'Decide, Summary and reference tabs',
      'Move between options',
      'Pick the focused option',
      'Next / previous question',
      'Send your answer',
      'Approvals list: move, open, back',
      'Approvals list: Group by… (set your own key)',
      'Approvals list: Waiting / Done today (your tab keys)',
      'Back to where you were',
      'Answer all, from any app',
    ]);
    expect(caps(groups, 'approvals', 'Open or close Approvals')).toEqual(['⌘⇧A']);
    expect(caps(groups, 'approvals', 'Open this Session’s approval (from its chat)')).toEqual(['⌘⌥A']);
    expect(caps(groups, 'approvals', 'Next / previous approval (from anywhere; set your own key)')).toEqual([]);
    expect(caps(groups, 'approvals', 'Next / previous question')).toEqual(['tab', '⇧tab']);
    expect(caps(groups, 'approvals', 'Send your answer')).toEqual(['⌘↩']);
    expect(caps(groups, 'approvals', 'Answer all, from any app')).toEqual(['⌃⇧Space']);
    expect(row(groups, 'approvals', 'Answer all, from any app')?.link).toBe('answer-all');
  });

  it('shows the person\'s own keys with the changed dot, including rows that follow the tab keys', () => {
    const groups = sheet({ overridesRaw: { 'cycle-tab-next-d': 'mod+alt+]', 'cycle-tab-prev-a': 'mod+alt+[' } });
    expect(caps(groups, 'tabs', 'Next Tab')).toEqual(['⌘⌥]']);
    expect(row(groups, 'tabs', 'Next Tab')?.changed).toBe(true);
    expect(row(groups, 'tabs', 'Close active tab')?.changed).toBe(false);
    expect(caps(groups, 'approvals', 'Decide, Summary and reference tabs')).toEqual(['⌘⌥]', '⌘⌥[']);
    expect(row(groups, 'approvals', 'Decide, Summary and reference tabs')?.changed).toBe(true);
  });

  it('folds the 1–9 runs into one row, and an unassigned command reads as palette only', () => {
    const groups = sheet({ overridesRaw: { 'toggle-sidebar': null } });
    expect(caps(groups, 'navigation', 'Switch to Pane 1–9')).toEqual(['⌘1', '…', '⌘9']);
    expect(caps(groups, 'tabs', 'Switch to tab 1–9')).toEqual(['⌘⇧1', '…', '⌘⇧9']);
    expect(caps(groups, 'view', 'Toggle Sidebar')).toEqual([]);
  });

  it('shows every available catalog command somewhere', () => {
    const groups = sheet();
    const shown = new Set(groups.flatMap(candidate => candidate.rows.flatMap(sheetRow => sheetRow.commandIds)));
    for (const entry of KEYBOARD_SHORTCUT_CATALOG) {
      if (entry.dynamicSlot) continue;
      expect(shown.has(entry.id), entry.id).toBe(true);
    }
  });

  it('formats keys for Windows and Linux', () => {
    const groups = sheet({ platform: 'other' });
    expect(caps(groups, 'approvals', 'Open or close Approvals')).toEqual(['Ctrl+Shift+A']);
    expect(caps(groups, 'help', 'Show keyboard shortcuts (this sheet)')).toEqual(['Ctrl+K', 'Ctrl+/']);
    expect(caps(groups, 'terminal', 'Clear (Ctrl+K then a key runs a two-step key)')).toEqual(['Ctrl+K']);
    expect(caps(groups, 'approvals', 'Answer all, from any app')).toEqual(['Ctrl+Shift+Space']);
  });

  it('keeps bare letters lower case', () => {
    expect(caps(sheet(), 'sidebar', 'Move, open, open and stay')).toEqual(['↓', '↑', 'j', 'k', '↩', 'Space']);
  });
});

describe('searchShortcutSheet', () => {
  it('finds rows by name in every group and counts them per group', () => {
    const result = searchShortcutSheet(sheet(), 'approv', true);
    expect(result.counts.get('find')).toBe(1);
    expect(result.counts.get('chat')).toBe(1);
    expect(result.counts.get('approvals')).toBeGreaterThanOrEqual(9);
    expect(result.counts.get('navigation')).toBe(0);
    expect(result.groups.map(candidate => candidate.id)).toEqual(['find', 'chat', 'approvals']);
  });

  it('shows a whole group when the query names it', () => {
    const groups = sheet();
    const result = searchShortcutSheet(groups, 'machines', true);
    expect(result.counts.get('machines')).toBe(group(groups, 'machines')?.rows.length);
  });

  it('finds keys by their chord symbols, in any order', () => {
    const groups = sheet();
    const hits = searchShortcutSheet(groups, '⌘⇧', true).groups.flatMap(candidate => candidate.rows.map(sheetRow => sheetRow.label));
    expect(hits).toContain('Open Search');
    expect(hits).toContain('Open or close Approvals');
    expect(hits).not.toContain('Toggle Sidebar');
    expect(searchShortcutSheet(groups, '⇧⌘', true).total).toBe(searchShortcutSheet(groups, '⌘⇧', true).total);
    expect(searchShortcutSheet(groups, '⌘⇧P', true).groups.flatMap(candidate => candidate.rows.map(sheetRow => sheetRow.label))).toEqual(['Open Search']);
  });

  it('finds keys by modifier names off macOS', () => {
    const groups = sheet({ platform: 'other' });
    const hits = searchShortcutSheet(groups, 'ctrl+shift', false).groups.flatMap(candidate => candidate.rows.map(sheetRow => sheetRow.label));
    expect(hits).toContain('Open Search');
    expect(hits).not.toContain('Toggle Sidebar');
  });

  it('returns nothing for a query that matches nothing', () => {
    const result = searchShortcutSheet(sheet(), 'zzq', true);
    expect(result.groups).toEqual([]);
    expect(result.total).toBe(0);
  });
});
