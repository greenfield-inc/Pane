export type ShortcutScope = 'app' | 'session' | 'session-panels' | 'usage';
export type ShortcutCategory =
  | 'navigation'
  | 'session'
  | 'tabs'
  | 'view'
  | 'tools'
  | 'debug'
  | 'shortcuts';

type Digit1to9 = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type CustomSlot = '0' | '1' | '2' | '3';

export type PanelTabId = `panel-tab-${Digit1to9}`;
export type SwitchSessionId = `switch-session-${Digit1to9}`;
export type CustomCommandId = `add-tool-custom-${CustomSlot}`;
export type ScrollSurfaceId =
  | 'scroll-focused-surface-up'
  | 'scroll-focused-surface-down'
  | 'page-focused-surface-up'
  | 'page-focused-surface-down';

const STATIC_SHORTCUT_IDS = [
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
  'scroll-focused-surface-down', 'page-focused-surface-up',
  'page-focused-surface-down',
] as const;

export type StaticKeyboardShortcutId = typeof STATIC_SHORTCUT_IDS[number];
export type KeyboardShortcutId = StaticKeyboardShortcutId | PanelTabId | SwitchSessionId | CustomCommandId;
export type HotkeyId = KeyboardShortcutId | `terminal-shortcut-${string}`;

export interface ShortcutCatalogEntry {
  id: KeyboardShortcutId;
  label: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  defaultChord: string | null;
  platforms?: readonly string[];
  dynamicSlot?: 'custom-command';
  releaseFromTerminal: boolean;
  releaseInTui: boolean;
  forwardFromWebview: boolean;
}

type InterceptionFlag = 'releaseFromTerminal' | 'releaseInTui' | 'forwardFromWebview';
type EntryInput = Omit<ShortcutCatalogEntry, InterceptionFlag>
  & Partial<Pick<ShortcutCatalogEntry, InterceptionFlag>>;

function entry(input: EntryInput): ShortcutCatalogEntry {
  return {
    ...input,
    releaseFromTerminal: input.releaseFromTerminal ?? true,
    releaseInTui: input.releaseInTui ?? false,
    forwardFromWebview: input.forwardFromWebview ?? true,
  };
}

const APP_ENTRIES: readonly ShortcutCatalogEntry[] = [
  entry({ id: 'open-command-palette', label: 'Open Command Palette', category: 'navigation', scope: 'app', defaultChord: 'mod+shift+p' }),
  entry({ id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'view', scope: 'app', defaultChord: 'mod+b' }),
  entry({ id: 'open-settings', label: 'Open Settings', category: 'navigation', scope: 'app', defaultChord: 'mod+,' }),
  entry({ id: 'focus-sidebar', label: 'Focus Sidebar', category: 'navigation', scope: 'app', defaultChord: 'mod+shift+e' }),
  entry({ id: 'open-shortcut-settings', label: 'Open Shortcut Settings', category: 'shortcuts', scope: 'app', defaultChord: 'mod+alt+/' }),
  entry({ id: 'new-session', label: 'New Pane', category: 'session', scope: 'app', defaultChord: 'mod+n' }),
  entry({ id: 'new-project', label: 'New Project', category: 'navigation', scope: 'app', defaultChord: 'mod+shift+n' }),
];

const SESSION_ENTRIES: readonly ShortcutCatalogEntry[] = [
  entry({ id: 'cycle-tab-prev-a', label: 'Previous Tab', category: 'tabs', scope: 'session', defaultChord: 'mod+a' }),
  entry({ id: 'cycle-tab-next-d', label: 'Next Tab', category: 'tabs', scope: 'session', defaultChord: 'mod+d' }),
  entry({ id: 'add-tool-terminal', label: 'Add Terminal', category: 'tools', scope: 'session', defaultChord: 'mod+alt+1', releaseInTui: true }),
  entry({ id: 'add-tool-explorer', label: 'Show Files', category: 'tools', scope: 'session', defaultChord: 'mod+alt+2', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-claude', label: 'Add Claude Code', category: 'tools', scope: 'session', defaultChord: 'mod+alt+3', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-codex', label: 'Add Codex', category: 'tools', scope: 'session', defaultChord: 'mod+alt+4', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-cursor', label: 'Add Cursor', category: 'tools', scope: 'session', defaultChord: 'mod+alt+5', platforms: ['darwin', 'linux', 'wsl'], releaseInTui: true }),
  entry({ id: 'close-active-tab', label: 'Close active tab', category: 'tabs', scope: 'session', defaultChord: 'mod+w' }),
  entry({ id: 'archive-active-session', label: 'Archive Pane', category: 'session', scope: 'session', defaultChord: 'mod+shift+w' }),
  entry({ id: 'split-right', label: 'Split Right', category: 'tabs', scope: 'session', defaultChord: 'mod+\\', releaseInTui: true, forwardFromWebview: false }),
  entry({ id: 'split-down', label: 'Split Down', category: 'tabs', scope: 'session', defaultChord: 'mod+shift+\\', releaseInTui: true, forwardFromWebview: false }),
  entry({ id: 'focus-group-left', label: 'Focus Group Left', category: 'tabs', scope: 'session', defaultChord: 'mod+alt+ArrowLeft', releaseInTui: true }),
  entry({ id: 'focus-group-right', label: 'Focus Group Right', category: 'tabs', scope: 'session', defaultChord: 'mod+alt+ArrowRight', releaseInTui: true }),
  entry({ id: 'focus-group-up', label: 'Focus Group Up', category: 'tabs', scope: 'session', defaultChord: 'mod+alt+ArrowUp', releaseInTui: true }),
  entry({ id: 'focus-group-down', label: 'Focus Group Down', category: 'tabs', scope: 'session', defaultChord: 'mod+alt+ArrowDown', releaseInTui: true }),
  entry({ id: 'zoom-toggle', label: 'Toggle Zoom', category: 'tabs', scope: 'session', defaultChord: 'mod+shift+z', releaseInTui: true }),
  entry({ id: 'git-commit', label: 'Git: Commit', category: 'session', scope: 'session', defaultChord: 'mod+shift+k' }),
  entry({ id: 'git-push', label: 'Git: Push', category: 'session', scope: 'session', defaultChord: 'mod+shift+u' }),
  entry({ id: 'git-soft-reset', label: 'Git: Undo Last Commit', category: 'session', scope: 'session', defaultChord: 'mod+alt+z' }),
  entry({ id: 'git-pull', label: 'Git: Pull', category: 'session', scope: 'session', defaultChord: 'mod+shift+l' }),
  entry({ id: 'git-rebase-from-main', label: 'Git: Rebase from Main', category: 'session', scope: 'session', defaultChord: 'mod+shift+r' }),
  entry({ id: 'git-merge-to-main', label: 'Git: Merge to Main', category: 'session', scope: 'session', defaultChord: 'mod+shift+m' }),
  entry({ id: 'cycle-session-next-0', label: 'Next Pane', category: 'session', scope: 'app', defaultChord: 'mod+Tab', releaseInTui: true }),
  entry({ id: 'cycle-session-prev-0', label: 'Previous Pane', category: 'session', scope: 'app', defaultChord: 'mod+shift+Tab', releaseInTui: true }),
  entry({ id: 'cycle-sidebar-session-next', label: 'Next Pane in Sidebar', category: 'session', scope: 'app', defaultChord: 'mod+ArrowDown' }),
  entry({ id: 'cycle-sidebar-session-prev', label: 'Previous Pane in Sidebar', category: 'session', scope: 'app', defaultChord: 'mod+ArrowUp' }),
  entry({ id: 'toggle-terminal', label: 'Toggle Terminal', category: 'view', scope: 'session', defaultChord: 'mod+`' }),
  entry({ id: 'toggle-detail-panel', label: 'Toggle Detail Panel', category: 'view', scope: 'session', defaultChord: 'mod+shift+b' }),
];

const SCROLL_ENTRIES: readonly ShortcutCatalogEntry[] = [
  entry({ id: 'scroll-focused-surface-up', label: 'Scroll focused surface up', category: 'view', scope: 'app', defaultChord: 'shift+ArrowUp' }),
  entry({ id: 'scroll-focused-surface-down', label: 'Scroll focused surface down', category: 'view', scope: 'app', defaultChord: 'shift+ArrowDown' }),
  entry({ id: 'page-focused-surface-up', label: 'Page focused surface up', category: 'view', scope: 'app', defaultChord: 'shift+PageUp' }),
  entry({ id: 'page-focused-surface-down', label: 'Page focused surface down', category: 'view', scope: 'app', defaultChord: 'shift+PageDown' }),
];

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const panelEntries = digits.map(digit => entry({
  id: `panel-tab-${digit}`,
  label: `Switch to tab ${digit}`,
  category: 'tabs',
  scope: 'session',
  defaultChord: `mod+shift+${digit}`,
  releaseInTui: true,
}));
const switchEntries = digits.map(digit => entry({
  id: `switch-session-${digit}`,
  label: `Switch to pane ${digit}`,
  category: 'session',
  scope: 'app',
  defaultChord: `mod+${digit}`,
}));
const customSlots: readonly CustomSlot[] = ['0', '1', '2', '3'];
const customEntries = customSlots.map((slot, index) => entry({
  id: `add-tool-custom-${slot}`,
  label: `Add custom tool ${index + 1}`,
  category: 'tools',
  scope: 'session',
  defaultChord: `mod+alt+${index + 6}`,
  dynamicSlot: 'custom-command',
  releaseInTui: true,
}));

export const KEYBOARD_SHORTCUT_CATALOG = [
  ...APP_ENTRIES,
  ...SESSION_ENTRIES,
  ...SCROLL_ENTRIES,
  ...panelEntries,
  ...switchEntries,
  ...customEntries,
  entry({ id: 'open-add-tool', label: 'Open Add Tool menu', category: 'tabs', scope: 'session-panels', defaultChord: 'mod+t' }),
  entry({ id: 'run-dev-server', label: 'Run Dev Server', category: 'tools', scope: 'session-panels', defaultChord: 'mod+shift+d' }),
  entry({ id: 'usage-download', label: 'Download usage image', category: 'tools', scope: 'usage', defaultChord: 'mod+shift+d', forwardFromWebview: false }),
  entry({ id: 'usage-share', label: 'Share usage image', category: 'tools', scope: 'usage', defaultChord: 'mod+shift+s', releaseFromTerminal: false, forwardFromWebview: false }),
] satisfies readonly ShortcutCatalogEntry[];

const catalogById = new Map<string, ShortcutCatalogEntry>(
  KEYBOARD_SHORTCUT_CATALOG.map(catalogEntry => [catalogEntry.id, catalogEntry]),
);

export function getCatalogEntry(id: string): ShortcutCatalogEntry | undefined {
  return catalogById.get(id);
}

export function isDynamicShortcutId(id: string): id is `terminal-shortcut-${string}` {
  return id.startsWith('terminal-shortcut-');
}

export function scopesOverlap(left: ShortcutScope, right: ShortcutScope): boolean {
  return !(
    (left === 'session-panels' && right === 'usage')
    || (left === 'usage' && right === 'session-panels')
  );
}
