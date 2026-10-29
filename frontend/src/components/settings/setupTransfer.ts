import type { IPCResponse } from '../../utils/api';
import type { AppConfig, UpdateConfigRequest } from '../../types/config';
import type { AnalyticsProperties } from '../../services/posthog';
import {
  SETUP_PREFERENCE_KEYS,
  SETUP_SECTION_IDS,
  type SetupFile,
  type SetupImportPreview,
  type SetupPreferenceKey,
  type SetupPreviewSection,
  type SetupRunScripts,
  type SetupSectionId,
} from '../../../../shared/types/setupTransfer';

export const SETUP_SECTION_LABELS = {
  agentPresets: 'Agent presets',
  customCommands: 'Custom commands',
  runScripts: 'Run scripts',
  skills: 'Skills & MCP',
  terminalShortcuts: 'Terminal shortcuts',
  worktreeFileSync: 'Worktree file sync',
  appearance: 'Appearance',
  preferences: 'Preferences',
} satisfies Record<SetupSectionId, string>;

/** "a", "a and b", "a, b and c". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Splits PaneError text ("<message> Next: <next>") into its two sentences. */
function splitPaneError(text: string) {
  const index = text.lastIndexOf(' Next: ');
  if (index === -1) return { message: text.trim(), next: null };
  return { message: text.slice(0, index).trim(), next: text.slice(index + ' Next: '.length).trim() };
}

/** PaneError text for display: the message, then the next step as its own sentence. */
export function setupErrorText(text: string): string {
  const { message, next } = splitPaneError(text);
  return next ? `${message} ${next}` : message;
}

export type SetupImportOutcome =
  | { kind: 'success'; message: string }
  | { kind: 'failure'; message: string };

export interface SetupImportDeps {
  preview: (file: SetupFile, fileName: string) => Promise<IPCResponse<SetupImportPreview>>;
  /** Throws when the save fails. */
  updateConfig: (patch: UpdateConfigRequest) => Promise<AppConfig>;
  savePreference: (key: SetupPreferenceKey, value: string) => Promise<boolean>;
  updateProject: (projectId: string, updates: Pick<SetupRunScripts, 'build_script' | 'run_script' | 'archive_script'>) => Promise<IPCResponse>;
  capture: (eventName: string, properties: AnalyticsProperties) => void;
}

function skippedSentence(sections: readonly SetupPreviewSection[]): string {
  const skipped = sections.flatMap((section) => section.items.flatMap((item) => {
    if (item.kind !== 'skipped') return [];
    if (item.cause === 'config-file') return [`${item.name}'s ${item.field ?? 'script'}, which its ${item.source ?? 'config file'} provides`];
    if (item.cause === 'ambiguous') return [`${item.name}, because more than one repository in Pane has that name`];
    return [`${item.name}, which isn't in Pane on this computer`];
  }));
  if (skipped.length === 0) return '';
  // Clauses with their own commas need a comma before the last "and" to stay readable.
  const list = skipped.some((clause) => clause.includes(','))
    ? `${skipped.slice(0, -1).join(', ')}${skipped.length > 1 ? ', and ' : ''}${skipped[skipped.length - 1]}`
    : joinNames(skipped);
  return ` Skipped ${list}.`;
}

const sectionCount = (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`;

/**
 * Applies the chosen sections of a previewed file through Settings' own save
 * paths: one config update, then each preference, then each project's scripts.
 * Main recomputes the preview first so values changed since it was shown are
 * not overwritten. Stops at the first failure.
 */
export async function applySetupImport(
  shown: SetupImportPreview,
  chosen: ReadonlySet<SetupSectionId>,
  deps: SetupImportDeps,
): Promise<SetupImportOutcome> {
  let fresh: IPCResponse<SetupImportPreview>;
  try {
    fresh = await deps.preview(shown.file, shown.fileName);
  } catch (error) {
    fresh = { success: false, error: error instanceof Error ? error.message : undefined };
  }
  if (!fresh.success || !fresh.data) {
    return { kind: 'failure', message: setupErrorText(fresh.error || 'Pane could not read the file again.') };
  }

  const sections = fresh.data.sections.filter((section) => chosen.has(section.id) && section.changes > 0);
  const done = new Set<SetupSectionId>();
  const completeWhere = (pending: (section: SetupPreviewSection) => boolean) => {
    for (const section of sections) if (!pending(section)) done.add(section.id);
  };
  let failing: readonly SetupPreviewSection[] = [];
  try {
    failing = sections.filter((section) => section.apply.config);
    if (failing.length) {
      const patch: UpdateConfigRequest = {};
      for (const section of failing) Object.assign(patch, section.apply.config);
      await deps.updateConfig(patch);
    }
    completeWhere((section) => Boolean(section.apply.preferences || section.apply.projects?.length));

    for (const section of sections) {
      failing = [section];
      for (const key of SETUP_PREFERENCE_KEYS) {
        const value = section.apply.preferences?.[key];
        if (value !== undefined && !(await deps.savePreference(key, value))) throw new Error(`Pane could not save ${key}`);
      }
    }
    completeWhere((section) => Boolean(section.apply.projects?.length));

    for (const section of sections) {
      failing = [section];
      for (const project of section.apply.projects ?? []) {
        const response = await deps.updateProject(String(project.id), project.updates);
        if (!response.success) throw new Error(response.error || `Pane could not save ${project.name}'s scripts`);
      }
    }
  } catch (error) {
    const names = joinNames(failing.map((section) => SETUP_SECTION_LABELS[section.id]));
    const cause = splitPaneError(error instanceof Error ? error.message : 'Pane could not save it').message.replace(/\.$/, '');
    return {
      kind: 'failure',
      message: `Imported ${done.size} of ${sectionCount(sections.length)}. ${names} failed: ${cause}. Nothing else changed. Import the file again to retry.`,
    };
  }

  const ids = SETUP_SECTION_IDS.filter((id) => sections.some((section) => section.id === id));
  deps.capture('setup_imported', {
    sections: ids,
    section_count: ids.length,
    changes: Object.fromEntries(sections.map((section) => [section.id, section.changes])),
  });
  return { kind: 'success', message: `Imported ${sectionCount(sections.length)}.${skippedSentence(sections)}` };
}
