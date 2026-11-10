/**
 * The command catalog: every Pane key binding, its default on each platform,
 * and how the terminal and browser tabs treat it. The hotkey store, the
 * terminal, main's browser-tab forwarding, the palette, Help and Settings ›
 * Keyboard Shortcuts all read their keys from here (plus the person's
 * overrides), so a command registered with `useHotkey` must have a row.
 *
 * Defaults follow VS Code (D-236). `defaultChord` is the macOS key and, unless
 * `defaultChordOther` says otherwise, Windows and Linux use the same key with
 * `ctrl` folded into `mod` (see keyboardChords.ts).
 */
import { chordForPlatform, parseChord, type KeyPlatform } from '../utils/keyboardChords';

export type ShortcutScope = 'app' | 'session' | 'session-panels' | 'usage';
export type ShortcutCategory =
  | 'navigation'
  | 'session'
  | 'tabs'
  | 'view'
  | 'tools'
  | 'machines'
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
  'open-shortcut-settings', 'new-session', 'new-orchestration-session', 'new-project',
  'cycle-tab-prev-a', 'cycle-tab-next-d', 'add-tool-terminal', 'add-tool-explorer',
  'add-tool-terminal-claude', 'add-tool-terminal-codex', 'add-tool-terminal-cursor',
  'add-tool-terminal-opencode',
  'close-active-tab', 'archive-active-session', 'split-right', 'split-down',
  'focus-group-left', 'focus-group-right', 'focus-group-up', 'focus-group-down',
  'focus-next-region', 'focus-previous-region',
  'zoom-toggle', 'minimize-region',
  'git-commit', 'git-push', 'git-soft-reset', 'git-pull',
  'git-rebase-from-main', 'git-merge-to-main', 'cycle-session-next-0',
  'cycle-session-prev-0', 'cycle-sidebar-session-next', 'cycle-sidebar-session-prev',
  'toggle-terminal', 'toggle-detail-panel', 'open-add-tool', 'run-dev-server',
  'usage-download', 'usage-share', 'scroll-focused-surface-up',
  'scroll-focused-surface-down', 'page-focused-surface-up',
  'page-focused-surface-down',
  'focus-session-tile-left', 'focus-session-tile-right', 'focus-session-tile-up',
  'focus-session-tile-down', 'close-session-tile',
  'find-in-tab', 'find-next', 'find-previous',
  'switch-to-chat-pane', 'switch-to-chat-session',
  'open-machine-switcher', 'next-machine', 'previous-machine', 'toggle-all-machines',
] as const;

export type StaticKeyboardShortcutId = typeof STATIC_SHORTCUT_IDS[number];
export type KeyboardShortcutId = StaticKeyboardShortcutId | PanelTabId | SwitchSessionId | CustomCommandId;
export type HotkeyId = KeyboardShortcutId | `terminal-shortcut-${string}`;

export interface ShortcutCatalogEntry {
  id: KeyboardShortcutId;
  label: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  /** macOS default; also Windows and Linux unless `defaultChordOther` is set. */
  defaultChord: string | null;
  /** Windows and Linux default when it differs from the macOS one. */
  defaultChordOther?: string | null;
  platforms?: readonly string[];
  dynamicSlot?: 'custom-command';
  /** In a plain shell, the key leaves the terminal for Pane while its command is enabled. */
  releaseFromTerminal: boolean;
  /** The key leaves a full-screen terminal program (vim, an agent's interface) for Pane. */
  releaseInTui: boolean;
  /** The key is taken from a focused browser-tab page and sent to Pane. */
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

/** A navigation key: it reaches Pane from a full-screen terminal program and from browser pages. */
function nav(input: EntryInput): ShortcutCatalogEntry {
  return entry({ releaseInTui: true, forwardFromWebview: true, ...input });
}

const APP_ENTRIES: readonly ShortcutCatalogEntry[] = [
  nav({ id: 'open-command-palette', label: 'Open Search', category: 'navigation', scope: 'app', defaultChord: 'mod+shift+p' }),
  entry({ id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'view', scope: 'app', defaultChord: 'mod+b' }),
  entry({ id: 'open-settings', label: 'Open Settings', category: 'navigation', scope: 'app', defaultChord: 'mod+,' }),
  nav({ id: 'focus-sidebar', label: 'Focus Sidebar', category: 'navigation', scope: 'app', defaultChord: 'mod+0' }),
  nav({ id: 'open-shortcut-settings', label: 'Open Keyboard Shortcuts', category: 'shortcuts', scope: 'app', defaultChord: 'mod+k mod+s' }),
  entry({ id: 'new-session', label: 'New Pane', category: 'session', scope: 'app', defaultChord: 'mod+n' }),
  entry({ id: 'new-orchestration-session', label: 'New Session', category: 'session', scope: 'app', defaultChord: null }),
  entry({ id: 'new-project', label: 'New Project', category: 'navigation', scope: 'app', defaultChord: 'mod+shift+n' }),
  entry({ id: 'focus-session-tile-left', label: 'Focus Session Left', category: 'view', scope: 'app', defaultChord: null }),
  entry({ id: 'focus-session-tile-right', label: 'Focus Session Right', category: 'view', scope: 'app', defaultChord: null }),
  entry({ id: 'focus-session-tile-up', label: 'Focus Session Up', category: 'view', scope: 'app', defaultChord: null }),
  entry({ id: 'focus-session-tile-down', label: 'Focus Session Down', category: 'view', scope: 'app', defaultChord: null }),
  entry({ id: 'close-session-tile', label: 'Stop tiling this Session', category: 'view', scope: 'app', defaultChord: null }),
  nav({ id: 'focus-group-left', label: 'Focus Left', category: 'navigation', scope: 'app', defaultChord: 'mod+alt+ArrowLeft' }),
  nav({ id: 'focus-group-right', label: 'Focus Right', category: 'navigation', scope: 'app', defaultChord: 'mod+alt+ArrowRight' }),
  nav({ id: 'focus-group-up', label: 'Focus Up', category: 'navigation', scope: 'app', defaultChord: 'mod+alt+ArrowUp' }),
  nav({ id: 'focus-group-down', label: 'Focus Down', category: 'navigation', scope: 'app', defaultChord: 'mod+alt+ArrowDown' }),
  nav({ id: 'focus-next-region', label: 'Focus Next Region', category: 'navigation', scope: 'app', defaultChord: 'F6' }),
  nav({ id: 'focus-previous-region', label: 'Focus Previous Region', category: 'navigation', scope: 'app', defaultChord: 'shift+F6' }),
  nav({ id: 'zoom-toggle', label: 'Maximize or Restore Focused Region', category: 'view', scope: 'app', defaultChord: 'mod+k mod+m' }),
  nav({ id: 'minimize-region', label: 'Minimize Focused Side Region', category: 'view', scope: 'app', defaultChord: 'mod+shift+m' }),
  nav({ id: 'open-machine-switcher', label: 'Open Machine Switcher', category: 'machines', scope: 'app', defaultChord: 'mod+alt+o' }),
  nav({ id: 'next-machine', label: 'Next Machine', category: 'machines', scope: 'app', defaultChord: 'mod+ctrl+]', defaultChordOther: 'mod+alt+shift+]' }),
  nav({ id: 'previous-machine', label: 'Previous Machine', category: 'machines', scope: 'app', defaultChord: 'mod+ctrl+[', defaultChordOther: 'mod+alt+shift+[' }),
  nav({ id: 'toggle-all-machines', label: 'Toggle All Machines and Last Machine', category: 'machines', scope: 'app', defaultChord: 'mod+ctrl+0', defaultChordOther: 'mod+alt+shift+0' }),
  // Find keys reach Pane from browser tabs through their own rule
  // (webviewKeyForwarding.ts), and from the terminal through terminalKeyHandling.
  entry({ id: 'find-in-tab', label: 'Find', category: 'tabs', scope: 'app', defaultChord: 'mod+f', forwardFromWebview: false }),
  entry({ id: 'find-next', label: 'Find Next', category: 'tabs', scope: 'app', defaultChord: 'mod+g', forwardFromWebview: false }),
  entry({ id: 'find-previous', label: 'Find Previous', category: 'tabs', scope: 'app', defaultChord: 'mod+shift+g', forwardFromWebview: false }),
  entry({ id: 'switch-to-chat-pane', label: 'Switch to chat', category: 'tabs', scope: 'app', defaultChord: null }),
  entry({ id: 'switch-to-chat-session', label: 'Switch to chat (Session)', category: 'tabs', scope: 'app', defaultChord: null }),
];

const SESSION_ENTRIES: readonly ShortcutCatalogEntry[] = [
  nav({ id: 'cycle-tab-prev-a', label: 'Previous Tab', category: 'tabs', scope: 'app', defaultChord: 'mod+shift+[', defaultChordOther: 'mod+PageUp' }),
  nav({ id: 'cycle-tab-next-d', label: 'Next Tab', category: 'tabs', scope: 'app', defaultChord: 'mod+shift+]', defaultChordOther: 'mod+PageDown' }),
  entry({ id: 'add-tool-terminal', label: 'Add Terminal', category: 'tools', scope: 'session', defaultChord: 'mod+alt+1', releaseInTui: true }),
  entry({ id: 'add-tool-explorer', label: 'Show Files', category: 'tools', scope: 'session', defaultChord: 'mod+alt+2', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-claude', label: 'Add Claude Code', category: 'tools', scope: 'session', defaultChord: 'mod+alt+3', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-codex', label: 'Add Codex', category: 'tools', scope: 'session', defaultChord: 'mod+alt+4', releaseInTui: true }),
  entry({ id: 'add-tool-terminal-cursor', label: 'Add Cursor', category: 'tools', scope: 'session', defaultChord: 'mod+alt+5', platforms: ['darwin', 'linux', 'wsl'], releaseInTui: true }),
  entry({ id: 'add-tool-terminal-opencode', label: 'Add OpenCode', category: 'tools', scope: 'session', defaultChord: 'mod+alt+6', releaseInTui: true }),
  entry({ id: 'close-active-tab', label: 'Close active tab', category: 'tabs', scope: 'session', defaultChord: 'mod+w' }),
  entry({ id: 'archive-active-session', label: 'Archive Pane', category: 'session', scope: 'session', defaultChord: 'mod+shift+w' }),
  entry({ id: 'split-right', label: 'Split Right', category: 'tabs', scope: 'session', defaultChord: 'mod+\\', releaseInTui: true, forwardFromWebview: false }),
  entry({ id: 'split-down', label: 'Split Down', category: 'tabs', scope: 'session', defaultChord: 'mod+shift+\\', releaseInTui: true, forwardFromWebview: false }),
  entry({ id: 'git-commit', label: 'Git: Commit', category: 'session', scope: 'session', defaultChord: 'mod+shift+k' }),
  entry({ id: 'git-push', label: 'Git: Push', category: 'session', scope: 'session', defaultChord: 'mod+shift+u' }),
  entry({ id: 'git-soft-reset', label: 'Git: Undo Last Commit', category: 'session', scope: 'session', defaultChord: 'mod+alt+z' }),
  entry({ id: 'git-pull', label: 'Git: Pull', category: 'session', scope: 'session', defaultChord: 'mod+shift+l' }),
  entry({ id: 'git-rebase-from-main', label: 'Git: Rebase from Main', category: 'session', scope: 'session', defaultChord: 'mod+shift+r' }),
  entry({ id: 'git-merge-to-main', label: 'Git: Merge to Main', category: 'session', scope: 'session', defaultChord: 'mod+alt+shift+m' }),
  entry({ id: 'cycle-session-next-0', label: 'Next Pane', category: 'session', scope: 'app', defaultChord: 'mod+Tab', releaseInTui: true }),
  entry({ id: 'cycle-session-prev-0', label: 'Previous Pane', category: 'session', scope: 'app', defaultChord: 'mod+shift+Tab', releaseInTui: true }),
  nav({ id: 'cycle-sidebar-session-next', label: 'Next Pane in Sidebar', category: 'session', scope: 'app', defaultChord: 'mod+ArrowDown' }),
  nav({ id: 'cycle-sidebar-session-prev', label: 'Previous Pane in Sidebar', category: 'session', scope: 'app', defaultChord: 'mod+ArrowUp' }),
  nav({ id: 'toggle-terminal', label: 'Toggle Terminal', category: 'view', scope: 'app', defaultChord: 'ctrl+`' }),
  nav({ id: 'toggle-detail-panel', label: 'Toggle Right Panel', category: 'view', scope: 'app', defaultChord: 'mod+alt+b' }),
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
const switchEntries = digits.map(digit => nav({
  id: `switch-session-${digit}`,
  label: `Switch to pane ${digit}`,
  category: 'session',
  scope: 'app',
  defaultChord: `mod+${digit}`,
}));
/** Custom commands take mod+alt+7, 8, 9 and 0; 3 to 6 belong to the built-in agents. */
export const CUSTOM_COMMAND_KEYS = ['7', '8', '9', '0'] as const;
const customSlots: readonly CustomSlot[] = ['0', '1', '2', '3'];
const customEntries = customSlots.map((slot, index) => entry({
  id: `add-tool-custom-${slot}`,
  label: `Add custom tool ${index + 1}`,
  category: 'tools',
  scope: 'session',
  defaultChord: `mod+alt+${CUSTOM_COMMAND_KEYS[index]}`,
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
  entry({ id: 'usage-download', label: 'Download usage image', category: 'tools', scope: 'usage', defaultChord: 'mod+s', forwardFromWebview: false }),
  entry({ id: 'usage-share', label: 'Share usage image', category: 'tools', scope: 'usage', defaultChord: 'mod+shift+s', releaseFromTerminal: false, forwardFromWebview: false }),
] satisfies readonly ShortcutCatalogEntry[];

/**
 * Defaults that changed in the VS Code keymap (D-236), named in the one-time
 * notice existing users see. `before` is the old default (one chord on every
 * platform, since the old keymap had no per-platform keys).
 */
export const MOVED_DEFAULT_KEYS: ReadonlyArray<{ ids: readonly KeyboardShortcutId[]; label: string; before: readonly string[] }> = [
  { ids: ['cycle-tab-prev-a', 'cycle-tab-next-d'], label: 'Previous / next tab', before: ['mod+a', 'mod+d'] },
  { ids: ['toggle-detail-panel'], label: 'Toggle right panel', before: ['mod+shift+b'] },
  { ids: ['zoom-toggle'], label: 'Maximize (was Zoom)', before: ['mod+shift+z'] },
  { ids: ['focus-sidebar'], label: 'Focus sidebar', before: ['mod+shift+e'] },
  { ids: ['open-shortcut-settings'], label: 'Keyboard Shortcuts', before: ['mod+alt+/'] },
  { ids: ['git-merge-to-main'], label: 'Git: Merge to Main', before: ['mod+shift+m'] },
];

const catalogById = new Map<string, ShortcutCatalogEntry>(
  KEYBOARD_SHORTCUT_CATALOG.map(catalogEntry => [catalogEntry.id, catalogEntry]),
);

export function getCatalogEntry(id: string): ShortcutCatalogEntry | undefined {
  return catalogById.get(id);
}

/** The entry's default binding on `platform`, canonical, or null when it has none. */
export function defaultChordFor(
  catalogEntry: Pick<ShortcutCatalogEntry, 'defaultChord' | 'defaultChordOther'>,
  platform: KeyPlatform,
): string | null {
  const raw = platform === 'other' && catalogEntry.defaultChordOther !== undefined
    ? catalogEntry.defaultChordOther
    : catalogEntry.defaultChord;
  if (raw === null) return null;
  const parsed = parseChord(raw);
  return parsed.ok ? chordForPlatform(parsed.chord, platform) : null;
}

/**
 * Maps a project environment (`macos` | `windows` | `linux` | `wsl`) or a
 * Node `process.platform` value onto the platform ids used by `platforms`.
 */
export function normalizeEnvironmentPlatform(platform: string): string {
  if (platform === 'macos') return 'darwin';
  if (platform === 'windows') return 'win32';
  return platform;
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
