import { isDeepStrictEqual } from 'node:util';
import type { AppConfig } from '../types/config';
import type { DetectedProjectConfig } from '../../../shared/types/projectConfig';
import { PaneError } from '../../../shared/paneError';
import { AGENT_LAUNCH_PRESETS } from '../../../shared/constants/agentLaunchPresets';
import { normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { isLightTheme, isTheme, normalizeAppearance, type DarkTheme, type Theme } from '../../../shared/types/appearance';
import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import { boundary, decodeBoundary, BoundaryDecodeError, formatBoundaryPath, type BoundarySchema, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import {
  SETUP_FILE_KIND,
  SETUP_FILE_VERSION,
  SETUP_PREFERENCE_KEYS,
  SETUP_SECTION_IDS,
  type SetupAgentPresets,
  type SetupApplyPayload,
  type SetupAppearance,
  type SetupCustomCommand,
  type SetupExportRow,
  type SetupFile,
  type SetupImportPreview,
  type SetupLeftOutItem,
  type SetupPreferenceKey,
  type SetupPreferences,
  type SetupPreviewItem,
  type SetupPreviewSection,
  type SetupRunScripts,
  type SetupSectionId,
  type SetupSections,
  type SetupSkills,
  type SetupTerminalShortcut,
} from '../../../shared/types/setupTransfer';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';

/** A saved repository as the setup file sees it. */
export interface SetupProject {
  id: number;
  name: string;
  build_script?: string | null;
  run_script?: string | null;
  archive_script?: string | null;
}

/** This computer's setup, and how to read what lives in each repository. */
export interface SetupSources {
  config: AppConfig;
  preferences: Partial<Record<SetupPreferenceKey, string>>;
  projects: SetupProject[];
  /** The repository's origin URL, or null when it has none or can't be read. */
  readOrigin(project: SetupProject): Promise<string | null>;
  /** Scripts the repository's own config file (pane.json and the others) provides. */
  detectConfig(project: SetupProject): Promise<DetectedProjectConfig | null>;
  home: string;
  platform: string;
  appVersion: string;
}

const SETUP_FILE_MAX_BYTES = 1024 * 1024;

const AGENT_PRESET_KEYS = [
  'defaultOrchestratorAgent', 'defaultAgentInterface', 'defaultSessionCommand', 'defaultSessionResume',
  'defaultSessionProfile', 'defaultSessionPinned', 'defaultPermissionMode', 'defaultModel',
] as const satisfies readonly (keyof SetupAgentPresets)[];

const APPEARANCE_KEYS = [
  'appearanceMode', 'theme', 'systemLightTheme', 'systemDarkTheme', 'highContrast', 'uiScale',
  'terminalFontFamily', 'terminalFontSize',
] as const satisfies readonly (keyof SetupAppearance)[];

const PREFERENCE_CONFIG_KEYS = [
  'notifications', 'keyboardShortcutsEnabled', 'commandPaletteShortcutEnabled', 'kittyKeyboardEnabled',
  'htmlFileOpenMode', 'enableCommitFooter', 'gitAttributionEnabled', 'autoCheckUpdates',
  'keepAwakeWhileSessionsActive', 'keepAwakeWhilePluggedIn', 'keepAwakeOnBattery', 'terminalPowerMode',
  'retention', 'voiceTranscriptionMode', 'missionControlEnabled', 'experimentalChatEnabled',
  'sessionCreationPreferences',
] as const satisfies readonly (keyof SetupPreferences)[];

const SCRIPT_FIELDS = [
  { key: 'build_script', label: 'Build Script', detected: 'setup' },
  { key: 'run_script', label: 'Run Commands', detected: 'run' },
  { key: 'archive_script', label: 'Archive Script', detected: 'archive' },
] as const;

const SECTION_LABELS = {
  agentPresets: 'Agent presets',
  customCommands: 'Custom commands',
  runScripts: 'Run scripts',
  skills: 'Skills & MCP',
  terminalShortcuts: 'Terminal shortcuts',
  worktreeFileSync: 'Worktree file sync',
  appearance: 'Appearance',
  preferences: 'Preferences',
} satisfies Record<SetupSectionId, string>;

const FIELD_LABELS = {
  defaultOrchestratorAgent: 'Pane Chat agent',
  defaultAgentInterface: 'Agent interface',
  defaultSessionCommand: 'Session command',
  defaultSessionResume: 'Session resume',
  defaultSessionProfile: 'Session profile',
  defaultSessionPinned: 'Pin new Sessions',
  defaultPermissionMode: 'Permission mode',
  defaultModel: 'Model',
  appearanceMode: 'Appearance mode',
  theme: 'Theme',
  systemLightTheme: 'Light theme',
  systemDarkTheme: 'Dark theme',
  highContrast: 'High contrast',
  uiScale: 'UI scale',
  terminalFontFamily: 'Terminal font',
  terminalFontSize: 'Terminal font size',
  notifications: 'Notifications',
  keyboardShortcutsEnabled: 'Keyboard shortcuts',
  commandPaletteShortcutEnabled: 'Command Palette shortcut',
  kittyKeyboardEnabled: 'Kitty keyboard',
  htmlFileOpenMode: 'HTML files open as',
  enableCommitFooter: 'Commit footer',
  gitAttributionEnabled: 'Git attribution',
  autoCheckUpdates: 'Automatic updates',
  keepAwakeWhileSessionsActive: 'Keep awake',
  keepAwakeWhilePluggedIn: 'Keep awake when plugged in',
  keepAwakeOnBattery: 'Keep awake on battery',
  terminalPowerMode: 'Terminal power mode',
  retention: 'Session retention',
  voiceTranscriptionMode: 'Voice transcription',
  missionControlEnabled: 'Mission Control',
  experimentalChatEnabled: 'Chat interface',
  sessionCreationPreferences: 'New Pane defaults',
  auto_rename_sessions_to_pr: 'Rename Panes to their PR',
  sidebar_pane_row_layout: 'Sidebar Pane rows',
  sidebar_attention_inbox: 'Attention inbox',
  at_terminal_paste_mode: '@terminal paste mode',
  at_terminal_line_count: '@terminal line count',
  homeSkill: 'Pane skill',
  registerMcp: 'MCP registration',
  mcpToolsets: 'MCP toolsets',
} satisfies Record<keyof SetupAgentPresets | keyof SetupAppearance | keyof SetupPreferences | keyof SetupSkills, string>;

// ---------------------------------------------------------------- secret check and home folder

const SECRET_PATTERNS: readonly RegExp[] = [
  // A key assignment: API_TOKEN=abc, PGPASSWORD=x, password: x. A variable reference is not a secret.
  /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]*(?:token|passw(?:or)?d|secret|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?\s*[=:]\s*["']?(?![$%{\s"']|$)/i,
  // A flag with a value: --password x, --token=x. A flag naming a file (--token-file ./x) ends in another word.
  /(?:^|\s)--?(?:[a-z0-9]+-)*(?:token|passw(?:or)?d|secret|api-?key|access-?key)(?:=|\s+)(?![-$\s])\S/i,
  // An Authorization or Cookie header.
  /\b(?:proxy-)?authorization\s*:|\b(?:set-)?cookie\s*:/i,
  // Credentials in a URL, or a secret in its query.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /[?&](?:token|access_token|api_key|apikey|key|secret|password|sig|signature)=[^&\s]/i,
  // Well-known key prefixes.
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_\w{8,}|xox[abprs]-[\w-]{8,}|AKIA[0-9A-Z]{12,})/,
];

/** Best effort: true when free text looks like it holds a key, password or token. */
function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Writes the home folder as ~, ignoring case and slash style. */
function homeToTilde(text: string, home: string): string {
  const parts = home.replace(/[\\/]+$/, '').split(/[\\/]/);
  if (parts.join('') === '') return text;
  const pattern = new RegExp(`${parts.map(escapeRegExp).join('[\\\\/]')}(?![A-Za-z0-9._-])`, 'gi');
  return text.replace(pattern, '~');
}

/** Turns a ~/ or ~\ at the start of a word back into this computer's home folder. */
function tildeToHome(text: string, home: string): string {
  return text.replace(/(^|[\s"'=(;&|])~(?=[\\/])/g, (_match, lead: string) => `${lead}${home}`);
}

// ---------------------------------------------------------------- remotes

/** host/owner/repo for SSH and HTTPS remotes, lowercased, without .git; null when it isn't one. */
function normalizeRemote(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const standard = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const match = standard ?? scp;
  if (!match?.[1] || !match[2]) return null;
  const segments = match[2].split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return [match[1], ...segments.slice(-2)].join('/').toLowerCase();
}

// ---------------------------------------------------------------- export

function nonEmpty(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function pickDefined<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  // SAFETY: Every key copied above came from `keys`; absent keys stay optional like the source's.
  return picked as Pick<T, K>;
}

function agentTitle(command: string | undefined): string | undefined {
  const program = command?.trim().split(/\s+/)[0];
  return AGENT_LAUNCH_PRESETS.find(preset => preset.command.split(' ')[0] === program)?.title;
}

function exportAgentPresets(config: AppConfig, home: string, leftOut: SetupLeftOutItem[]): SetupAgentPresets {
  const presets: SetupAgentPresets = pickDefined(config, AGENT_PRESET_KEYS);
  const drop = (key: 'defaultSessionCommand' | 'defaultSessionProfile' | 'defaultSessionResume', text: string) => {
    if (looksSecret(text)) {
      delete presets[key];
      leftOut.push({ section: 'agentPresets', name: FIELD_LABELS[key] });
      return true;
    }
    return false;
  };
  if (presets.defaultSessionCommand !== undefined && !drop('defaultSessionCommand', presets.defaultSessionCommand)) {
    presets.defaultSessionCommand = homeToTilde(presets.defaultSessionCommand, home);
  }
  if (presets.defaultSessionProfile !== undefined && !drop('defaultSessionProfile', presets.defaultSessionProfile)) {
    presets.defaultSessionProfile = homeToTilde(presets.defaultSessionProfile, home);
  }
  const resume = presets.defaultSessionResume;
  if (resume && !drop('defaultSessionResume', `${resume.initialTemplate}\n${resume.resumeTemplate}`)) {
    presets.defaultSessionResume = {
      ...resume,
      initialTemplate: homeToTilde(resume.initialTemplate, home),
      resumeTemplate: homeToTilde(resume.resumeTemplate, home),
    };
  }
  return presets;
}

function exportCustomCommands(config: AppConfig, home: string, leftOut: SetupLeftOutItem[]): SetupCustomCommand[] {
  return (config.customCommands ?? []).flatMap((command) => {
    const text = [command.command, command.resume?.initialTemplate, command.resume?.resumeTemplate].join('\n');
    if (looksSecret(text)) {
      leftOut.push({ section: 'customCommands', name: command.name });
      return [];
    }
    const exported: SetupCustomCommand = { name: command.name, command: homeToTilde(command.command, home) };
    if (command.resume) {
      exported.resume = {
        ...command.resume,
        initialTemplate: homeToTilde(command.resume.initialTemplate, home),
        resumeTemplate: homeToTilde(command.resume.resumeTemplate, home),
      };
    }
    return [exported];
  });
}

async function exportRunScripts(sources: SetupSources, leftOut: SetupLeftOutItem[]): Promise<SetupRunScripts[]> {
  const withScripts = sources.projects.filter(project => SCRIPT_FIELDS.some(field => nonEmpty(project[field.key])));
  const remotes = await Promise.all(withScripts.map(project => sources.readOrigin(project).catch(() => null)));
  const seen = new Set<string>();
  return withScripts.flatMap((project, index) => {
    const remote = normalizeRemote(remotes[index] ?? null);
    const identity = remote ?? `name:${project.name}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const repo: SetupRunScripts = { name: project.name, remote };
    for (const field of SCRIPT_FIELDS) {
      const script = project[field.key];
      if (!nonEmpty(script)) continue;
      if (looksSecret(script)) leftOut.push({ section: 'runScripts', name: `${project.name} ${field.label}` });
      else repo[field.key] = homeToTilde(script, sources.home);
    }
    return SCRIPT_FIELDS.some(field => repo[field.key] !== undefined) ? [repo] : [];
  });
}

function exportSkills(config: AppConfig): SetupSkills {
  const skills: SetupSkills = {
    homeSkill: config.agentContext?.homeSkill !== false,
    registerMcp: config.agentContext?.registerMcp !== false,
  };
  if (config.agentContext?.mcpToolsets) skills.mcpToolsets = [...config.agentContext.mcpToolsets];
  return skills;
}

function exportTerminalShortcuts(config: AppConfig, home: string, leftOut: SetupLeftOutItem[]): SetupTerminalShortcut[] {
  return (config.terminalShortcuts ?? []).flatMap((shortcut) => {
    if (looksSecret(shortcut.text)) {
      leftOut.push({ section: 'terminalShortcuts', name: shortcut.label });
      return [];
    }
    return [{ id: shortcut.id, label: shortcut.label, key: shortcut.key, text: homeToTilde(shortcut.text, home), enabled: shortcut.enabled }];
  });
}

function isRelativePath(value: string): boolean {
  return !/^(?:[\\/~]|[A-Za-z]:)/.test(value.trim());
}

function exportPreferences(sources: SetupSources): SetupPreferences {
  const preferences: SetupPreferences = pickDefined(sources.config, PREFERENCE_CONFIG_KEYS);
  if (preferences.sessionCreationPreferences) {
    const portable = { ...sources.config.sessionCreationPreferences };
    delete portable.baseBranch;
    if (Object.keys(portable).length > 0) preferences.sessionCreationPreferences = portable;
    else delete preferences.sessionCreationPreferences;
  }
  for (const key of SETUP_PREFERENCE_KEYS) {
    const value = sources.preferences[key];
    if (value !== undefined) preferences[key] = value;
  }
  return preferences;
}

/**
 * Builds the setup file from this computer's setup: only allowlisted settings, the home
 * folder written as ~, and anything that looks like a secret left out and named.
 */
export async function exportSetup(
  sources: SetupSources,
  sections: readonly SetupSectionId[],
  now: Date,
): Promise<{ file: SetupFile; rows: SetupExportRow[]; leftOut: SetupLeftOutItem[] }> {
  const { config, home } = sources;
  const leftOut: SetupLeftOutItem[] = [];
  const included = new Set(sections);
  const built: SetupSections = {};
  if (included.has('agentPresets')) built.agentPresets = exportAgentPresets(config, home, leftOut);
  if (included.has('customCommands')) built.customCommands = exportCustomCommands(config, home, leftOut);
  if (included.has('runScripts')) built.runScripts = await exportRunScripts(sources, leftOut);
  if (included.has('skills')) built.skills = exportSkills(config);
  if (included.has('terminalShortcuts')) built.terminalShortcuts = exportTerminalShortcuts(config, home, leftOut);
  if (included.has('worktreeFileSync')) {
    built.worktreeFileSync = (config.worktreeFileSync ?? []).filter(entry => isRelativePath(entry.path)).map(entry => ({ ...entry }));
  }
  if (included.has('appearance')) built.appearance = pickDefined(config, APPEARANCE_KEYS);
  if (included.has('preferences')) built.preferences = exportPreferences(sources);

  const sectionsInOrder: SetupSections = {};
  for (const id of SETUP_SECTION_IDS) {
    if (built[id] !== undefined) Object.assign(sectionsInOrder, { [id]: built[id] });
  }
  const file: SetupFile = {
    kind: SETUP_FILE_KIND,
    version: SETUP_FILE_VERSION,
    exportedAt: now.toISOString(),
    appVersion: sources.appVersion,
    platform: sources.platform,
    sections: sectionsInOrder,
  };
  return { file, rows: exportRows(sources, built, leftOut), leftOut };
}

function exportRows(sources: SetupSources, built: SetupSections, leftOut: SetupLeftOutItem[]): SetupExportRow[] {
  return SETUP_SECTION_IDS.filter(id => built[id] !== undefined).map((id): SetupExportRow => {
    const row: SetupExportRow = { id, count: sectionCount(built, id), leftOut: leftOut.filter(item => item.section === id) };
    if (id === 'agentPresets') {
      const orchestrator = AGENT_LAUNCH_PRESETS.find(preset => preset.id === normalizePaneChatAgent(sources.config.defaultOrchestratorAgent))?.title;
      const sessionAgent = agentTitle(built.agentPresets?.defaultSessionCommand);
      row.agents = [...new Set([orchestrator, sessionAgent].filter((title): title is string => Boolean(title)))];
    }
    if (id === 'skills') row.skills = { homeSkill: built.skills?.homeSkill === true, registerMcp: built.skills?.registerMcp === true };
    if (id === 'appearance') {
      const { appearance } = normalizeAppearance(sources.config);
      row.appearance = { mode: appearance.appearanceMode, theme: appearance.theme, light: appearance.systemLightTheme, dark: appearance.systemDarkTheme };
    }
    return row;
  });
}

function sectionCount(sections: SetupSections, id: SetupSectionId): number {
  const section = sections[id];
  if (section === undefined) return 0;
  return Array.isArray(section) ? section.length : Object.keys(section).length;
}

// ---------------------------------------------------------------- reading a file

const booleanField = boundary.optional(boundary.boolean);
const stringField = boundary.optional(boundary.string);
function themeSchema<T extends Theme>(accepts: (theme: Theme) => theme is T, expected: string): BoundarySchema<T> {
  return {
    decode(current) {
      const value = boundary.string.decode(current);
      return isTheme(value) && accepts(value) ? value : current.fail(`expected ${expected}`);
    },
  };
}

const resumeField = boundary.optional(boundary.nullable(customCommandResumeSchema));

const sectionSchemas = {
  agentPresets: boundary.object({
    defaultOrchestratorAgent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
    defaultAgentInterface: boundary.optional(boundary.enumeration('terminal', 'chat')),
    defaultSessionCommand: stringField,
    defaultSessionResume: resumeField,
    defaultSessionProfile: stringField,
    defaultSessionPinned: booleanField,
    defaultPermissionMode: boundary.optional(boundary.enumeration('approve', 'ignore')),
    defaultModel: stringField,
  }),
  customCommands: boundary.array(boundary.object({
    name: boundary.nonEmptyString,
    command: boundary.string,
    resume: resumeField,
  })),
  runScripts: boundary.array(boundary.object({
    name: boundary.nonEmptyString,
    remote: boundary.nullable(boundary.string),
    build_script: stringField,
    run_script: stringField,
    archive_script: stringField,
  })),
  skills: boundary.object({
    homeSkill: booleanField,
    registerMcp: booleanField,
    mcpToolsets: boundary.optional(boundary.array(boundary.string)),
  }),
  terminalShortcuts: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    label: boundary.string,
    key: boundary.string,
    text: boundary.string,
    enabled: boundary.boolean,
  })),
  worktreeFileSync: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    path: boundary.refine(boundary.nonEmptyString, isRelativePath, 'expected a path relative to the repository'),
    enabled: boundary.boolean,
    recursive: boundary.boolean,
  })),
  appearance: boundary.object({
    appearanceMode: boundary.optional(boundary.enumeration('system', 'fixed')),
    theme: boundary.optional(themeSchema((theme): theme is Theme => true, 'a Pane theme')),
    systemLightTheme: boundary.optional(themeSchema(isLightTheme, 'a light theme')),
    systemDarkTheme: boundary.optional(themeSchema((theme): theme is DarkTheme => !isLightTheme(theme), 'a dark theme')),
    highContrast: booleanField,
    uiScale: boundary.optional(boundary.number),
    terminalFontFamily: stringField,
    terminalFontSize: boundary.optional(boundary.number),
  }),
  preferences: boundary.object({
    notifications: boundary.optional(boundary.object({ playSound: boundary.boolean, enabled: boundary.boolean })),
    keyboardShortcutsEnabled: booleanField,
    commandPaletteShortcutEnabled: booleanField,
    kittyKeyboardEnabled: booleanField,
    htmlFileOpenMode: boundary.optional(boundary.enumeration('preview', 'source')),
    enableCommitFooter: booleanField,
    gitAttributionEnabled: booleanField,
    autoCheckUpdates: booleanField,
    keepAwakeWhileSessionsActive: booleanField,
    keepAwakeWhilePluggedIn: booleanField,
    keepAwakeOnBattery: booleanField,
    terminalPowerMode: boundary.optional(boundary.enumeration('performance', 'batterySaver')),
    retention: boundary.optional(boundary.object({ sessionActivity: boundary.optional(boundary.number), sessionInbox: boundary.optional(boundary.number) })),
    voiceTranscriptionMode: boundary.optional(boundary.enumeration('recorded', 'streaming')),
    missionControlEnabled: booleanField,
    experimentalChatEnabled: booleanField,
    sessionCreationPreferences: boundary.optional(boundary.object({
      sessionCount: boundary.optional(boundary.number),
      toolType: boundary.optional(boundary.enumeration('claude', 'none')),
      selectedTools: boundary.optional(boundary.object({ claude: booleanField })),
      claudeConfig: boundary.optional(boundary.object({
        model: boundary.optional(boundary.enumeration('auto', 'sonnet', 'opus', 'haiku')),
        permissionMode: boundary.optional(boundary.enumeration('ignore', 'approve')),
        ultrathink: booleanField,
      })),
      showAdvanced: booleanField,
      startPinned: booleanField,
    })),
    auto_rename_sessions_to_pr: stringField,
    sidebar_pane_row_layout: stringField,
    sidebar_attention_inbox: stringField,
    at_terminal_paste_mode: stringField,
    at_terminal_line_count: stringField,
  }),
} satisfies { [K in SetupSectionId]: BoundarySchema<NonNullable<SetupSections[K]>> };

type SectionSchemas = { [Id in SetupSectionId]: BoundarySchema<NonNullable<SetupSections[Id]>> };

function decodeSection<K extends SetupSectionId>(id: K, raw: JsonValue, schemas: SectionSchemas = sectionSchemas): NonNullable<SetupSections[K]> {
  return decodeBoundary(raw, schemas[id]);
}

const CHOOSE_SETUP_FILE = 'Choose a file exported from Settings › Import & Export.';

/** Refuses a file over 1 MB before it is read. */
export function assertSetupFileSize(bytes: number, fileName: string): void {
  if (bytes > SETUP_FILE_MAX_BYTES) {
    throw new PaneError('ERR_SETUP_FILE_TOO_LARGE', `Couldn't import ${fileName}: it is larger than 1 MB, so it isn't a Pane setup file. Nothing changed.`, CHOOSE_SETUP_FILE);
  }
}

/** Validates a setup file's text. Unknown sections and keys are dropped; anything else wrong throws a PaneError. */
export function readSetupFile(text: string, fileName: string): SetupFile {
  assertSetupFileSize(Buffer.byteLength(text, 'utf8'), fileName);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PaneError('ERR_SETUP_FILE_NOT_JSON', `Couldn't import ${fileName}: it isn't a Pane setup file (the text isn't valid JSON). Nothing changed.`, CHOOSE_SETUP_FILE);
  }
  const envelope = decodeEnvelope(parsed);
  if (!envelope) {
    throw new PaneError('ERR_SETUP_FILE_WRONG_KIND', `Couldn't import ${fileName}: it isn't a Pane setup file. Nothing changed.`, CHOOSE_SETUP_FILE);
  }
  if (envelope.version > SETUP_FILE_VERSION) {
    throw new PaneError(
      'ERR_SETUP_FILE_NEWER_VERSION',
      `Couldn't import ${fileName}: it was written by a newer Pane (setup file version ${envelope.version}; this Pane reads version ${SETUP_FILE_VERSION}). Nothing changed.`,
      'Update Pane on this computer, then import the file again.',
    );
  }
  const sections: SetupSections = {};
  for (const id of SETUP_SECTION_IDS) {
    const raw = envelope.sections[id];
    if (raw === undefined) continue;
    try {
      Object.assign(sections, { [id]: decodeSection(id, raw) });
    } catch (error) {
      if (!(error instanceof BoundaryDecodeError)) throw error;
      const where = error.path.length > 0 ? `at ${formatBoundaryPath(error.path)}: ` : '';
      throw new PaneError(
        'ERR_SETUP_FILE_INVALID_SECTION',
        `Couldn't import ${fileName}: its ${SECTION_LABELS[id]} section is malformed (${where}${error.reason}). Nothing changed.`,
        'Export the file again from Settings › Import & Export on the other computer.',
      );
    }
  }
  return {
    kind: SETUP_FILE_KIND,
    version: SETUP_FILE_VERSION,
    exportedAt: envelope.exportedAt,
    appVersion: envelope.appVersion,
    platform: envelope.platform,
    sections,
  };
}

function decodeEnvelope(value: JsonValue) {
  try {
    return decodeBoundary(value, boundary.object({
      kind: boundary.literal(SETUP_FILE_KIND),
      version: boundary.refine(boundary.number, version => Number.isInteger(version) && version >= 1, 'expected a version number'),
      exportedAt: boundary.string,
      appVersion: boundary.string,
      platform: boundary.string,
      sections: boundary.jsonObject,
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- preview and merge

function emptySection(id: SetupSectionId): SetupPreviewSection {
  return { id, changes: 0, added: 0, replaced: 0, keyInUse: 0, items: [], apply: {} };
}

function count(section: SetupPreviewSection, item: SetupPreviewItem): void {
  section.items.push(item);
  if (item.kind === 'new') section.added += 1;
  if (item.kind === 'replaces') section.replaced += 1;
  if (item.kind !== 'skipped') section.changes += 1;
}

interface ValuesPreview<T> { section: SetupPreviewSection; changed: Partial<T> }
interface ListPreview<T> { section: SetupPreviewSection; merged: T[] }

/** Single values: the file's value replaces this computer's when they differ. */
function previewValues<T extends object>(
  id: SetupSectionId,
  incoming: T,
  local: Partial<T>,
): ValuesPreview<T> {
  const section = emptySection(id);
  const changed: Partial<T> = {};
  const display = (value: T[keyof T] | undefined) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preview text shows strings raw and every other setting value as JSON.
    if (typeof value === 'string') return value;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Switches read as on or off rather than true or false.
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    return JSON.stringify(value);
  };
  for (const key of Object.keys(incoming)) {
    // SAFETY: `key` comes from Object.keys of the decoded section, so it is one of T's fields.
    const field = key as keyof T & string;
    const next = incoming[field];
    if (next === undefined || isDeepStrictEqual(next, local[field])) continue;
    changed[field] = next;
    // SAFETY: The `in` check above confirms `field` is a FIELD_LABELS key.
    const name = field in FIELD_LABELS ? FIELD_LABELS[field as keyof typeof FIELD_LABELS] : field;
    count(section, local[field] === undefined
      ? { kind: 'new', name, text: display(next) }
      : { kind: 'replaces', name, text: display(next), was: display(local[field]) });
  }
  return { section, changed };
}

function expandResume<T extends { resume?: SetupCustomCommand['resume'] }>(value: T, home: string): T {
  if (!value.resume) return value;
  return { ...value, resume: { ...value.resume, initialTemplate: tildeToHome(value.resume.initialTemplate, home), resumeTemplate: tildeToHome(value.resume.resumeTemplate, home) } };
}

/** Lists merged by key: new keys are added, a different value replaces, local-only entries stay. */
function previewList<T>(
  id: SetupSectionId,
  local: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
  describe: (item: T) => { name: string; text: string },
  admit: (item: T, merged: readonly T[]) => { item: T; keyInUse: boolean } = item => ({ item, keyInUse: false }),
): ListPreview<T> {
  const section = emptySection(id);
  const merged = [...local];
  for (const candidate of incoming) {
    const index = merged.findIndex(entry => keyOf(entry) === keyOf(candidate));
    const { item, keyInUse } = admit(candidate, merged);
    if (index >= 0 && isDeepStrictEqual(merged[index], item)) continue;
    const { name, text } = describe(item);
    const extra = keyInUse ? { keyInUse: true } : {};
    if (keyInUse) section.keyInUse += 1;
    if (index < 0) {
      merged.push(item);
      count(section, { kind: 'new', name, text, ...extra });
    } else {
      count(section, { kind: 'replaces', name, text, was: describe(merged[index]).text, ...extra });
      merged[index] = item;
    }
  }
  return { section, merged };
}

async function previewRunScripts(repos: readonly SetupRunScripts[], sources: SetupSources): Promise<SetupPreviewSection> {
  const section = emptySection('runScripts');
  const origins = await Promise.all(sources.projects.map(project => sources.readOrigin(project).catch(() => null)));
  const localRemotes = origins.map(normalizeRemote);
  const updates = new Map<number, NonNullable<SetupApplyPayload['projects']>[number]>();
  let matchedRepos = 0;
  for (const repo of repos) {
    const remote = repo.remote?.toLowerCase() ?? null;
    let matches = remote
      ? sources.projects.filter((_project, index) => localRemotes[index] === remote)
      : sources.projects.filter(project => project.name === repo.name);
    if (!remote && matches.length > 1) {
      count(section, { kind: 'skipped', name: repo.name, reason: `more than one repository in Pane is named ${repo.name}`, cause: 'ambiguous' });
      matches = [];
      continue;
    }
    if (matches.length === 0) {
      count(section, { kind: 'skipped', name: repo.name, reason: 'not in Pane on this computer', cause: 'missing' });
      continue;
    }
    matchedRepos += 1;
    for (const project of matches) {
      const detected = await sources.detectConfig(project).catch(() => null);
      for (const field of SCRIPT_FIELDS) {
        const script = repo[field.key];
        if (!nonEmpty(script)) continue;
        if (nonEmpty(detected?.[field.detected])) {
          const source = detected?.source ?? 'pane.json';
          count(section, { kind: 'skipped', name: project.name, field: field.label, reason: `${source} already provides it`, cause: 'config-file', source });
          continue;
        }
        const text = tildeToHome(script, sources.home);
        const current = project[field.key];
        if (current === text) continue;
        count(section, nonEmpty(current)
          ? { kind: 'replaces', name: project.name, field: field.label, text, was: current }
          : { kind: 'new', name: project.name, field: field.label, text });
        const entry = updates.get(project.id) ?? { id: project.id, name: project.name, updates: {} };
        entry.updates[field.key] = text;
        updates.set(project.id, entry);
      }
    }
  }
  section.repositories = { matched: matchedRepos, total: repos.length };
  // Changes first, then what was skipped and why.
  section.items.sort((a, b) => Number(a.kind === 'skipped') - Number(b.kind === 'skipped'));
  if (updates.size > 0) section.apply = { projects: [...updates.values()] };
  return section;
}

function previewSkills(incoming: SetupSkills, config: AppConfig): SetupPreviewSection {
  const local = exportSkills(config);
  const { section, changed } = previewValues('skills', incoming, local);
  const effects: NonNullable<SetupPreviewSection['skills']> = [];
  if (changed.registerMcp !== undefined) effects.push(changed.registerMcp ? 'mcp-on' : 'mcp-off');
  if (changed.homeSkill !== undefined) effects.push(changed.homeSkill ? 'skill-on' : 'skill-off');
  if (changed.mcpToolsets !== undefined) effects.push('toolsets');
  section.skills = effects;
  if (section.changes > 0) section.apply = { config: { agentContext: changed } };
  return section;
}

function previewPreferences(incoming: SetupPreferences, sources: SetupSources): SetupPreviewSection {
  const { baseBranch, ...localSessionPreferences } = sources.config.sessionCreationPreferences ?? {};
  const local: SetupPreferences = { ...pickDefined(sources.config, PREFERENCE_CONFIG_KEYS), ...sources.preferences };
  if (sources.config.sessionCreationPreferences) local.sessionCreationPreferences = localSessionPreferences;
  const { section, changed } = previewValues('preferences', incoming, local);
  const config: NonNullable<SetupApplyPayload['config']> = {};
  const preferences: NonNullable<SetupApplyPayload['preferences']> = {};
  for (const key of Object.keys(changed)) {
    if (SETUP_PREFERENCE_KEYS.some(preferenceKey => preferenceKey === key)) {
      // SAFETY: The check above matched `key` against SETUP_PREFERENCE_KEYS.
      const preferenceKey = key as SetupPreferenceKey;
      const value = changed[preferenceKey];
      if (value !== undefined) preferences[preferenceKey] = value;
    } else {
      // SAFETY: `key` comes from Object.keys of `changed`, a Partial<SetupPreferences>.
      Object.assign(config, { [key]: changed[key as keyof SetupPreferences] });
    }
  }
  if (config.sessionCreationPreferences && baseBranch !== undefined) {
    config.sessionCreationPreferences = { ...config.sessionCreationPreferences, baseBranch };
  }
  if (Object.keys(config).length > 0) section.apply.config = config;
  if (Object.keys(preferences).length > 0) section.apply.preferences = preferences;
  return section;
}

/**
 * What importing `file` would change on this computer, per section, with the merged values to
 * save. Nothing is written; call again on confirm so the values reflect the current setup.
 */
export async function previewSetupImport(file: SetupFile, fileName: string, sources: SetupSources): Promise<SetupImportPreview> {
  const { config, home } = sources;
  const incoming = file.sections;
  const sections: SetupPreviewSection[] = [];

  if (incoming.agentPresets) {
    const presets: SetupAgentPresets = { ...incoming.agentPresets };
    if (presets.defaultSessionCommand !== undefined) presets.defaultSessionCommand = tildeToHome(presets.defaultSessionCommand, home);
    if (presets.defaultSessionProfile !== undefined) presets.defaultSessionProfile = tildeToHome(presets.defaultSessionProfile, home);
    const expanded = expandResume({ resume: presets.defaultSessionResume }, home).resume;
    if (expanded !== undefined) presets.defaultSessionResume = expanded;
    const { section, changed } = previewValues('agentPresets', presets, pickDefined(config, AGENT_PRESET_KEYS));
    if (section.changes > 0) section.apply = { config: changed };
    sections.push(section);
  }

  if (incoming.customCommands) {
    const commands = incoming.customCommands.map(command => expandResume({ ...command, command: tildeToHome(command.command, home) }, home));
    const local: SetupCustomCommand[] = (config.customCommands ?? []).map(command => ({ ...command }));
    const { section, merged } = previewList('customCommands', local, commands, command => command.name, command => ({ name: command.name, text: command.command }));
    if (section.changes > 0) section.apply = { config: { customCommands: merged } };
    sections.push(section);
  }

  if (incoming.runScripts) sections.push(await previewRunScripts(incoming.runScripts, sources));

  if (incoming.skills) sections.push(previewSkills(incoming.skills, config));

  if (incoming.terminalShortcuts) {
    const shortcuts = incoming.terminalShortcuts.map(shortcut => ({ ...shortcut, text: tildeToHome(shortcut.text, home) }));
    const { section, merged } = previewList(
      'terminalShortcuts',
      config.terminalShortcuts ?? [],
      shortcuts,
      shortcut => shortcut.id,
      shortcut => ({ name: shortcut.label, text: shortcut.text }),
      (shortcut, current) => {
        const taken = shortcut.enabled && current.some(other => other.id !== shortcut.id && other.enabled !== false && other.key.toLowerCase() === shortcut.key.toLowerCase());
        return taken ? { item: { ...shortcut, enabled: false }, keyInUse: true } : { item: shortcut, keyInUse: false };
      },
    );
    if (section.changes > 0) section.apply = { config: { terminalShortcuts: merged } };
    sections.push(section);
  }

  if (incoming.worktreeFileSync) {
    const local: WorktreeFileSyncEntry[] = config.worktreeFileSync ?? [];
    const takenIds = new Set(local.map(entry => entry.id));
    const entries = incoming.worktreeFileSync.map((entry) => {
      const existing = local.find(candidate => candidate.path === entry.path);
      if (existing) return { ...entry, id: existing.id };
      let id = entry.id;
      for (let suffix = 2; takenIds.has(id); suffix += 1) id = `${entry.id}-${suffix}`;
      takenIds.add(id);
      return { ...entry, id };
    });
    const { section, merged } = previewList('worktreeFileSync', local, entries, entry => entry.path, entry => ({
      name: entry.path,
      text: [entry.enabled ? 'on' : 'off', entry.recursive ? 'recursive' : null].filter(Boolean).join(', '),
    }));
    if (section.changes > 0) section.apply = { config: { worktreeFileSync: merged } };
    sections.push(section);
  }

  if (incoming.appearance) {
    const local: SetupAppearance = { ...pickDefined(config, APPEARANCE_KEYS), ...normalizeAppearance(config).appearance };
    const { section, changed } = previewValues('appearance', incoming.appearance, local);
    const mode = incoming.appearance.appearanceMode ?? local.appearanceMode;
    if (changed.theme && mode === 'fixed') section.theme = changed.theme;
    if (section.changes > 0) section.apply = { config: changed };
    sections.push(section);
  }

  if (incoming.preferences) sections.push(previewPreferences(incoming.preferences, sources));

  return {
    fileName,
    appVersion: file.appVersion,
    platform: file.platform,
    otherPlatform: file.platform !== sources.platform,
    file,
    sections,
  };
}
