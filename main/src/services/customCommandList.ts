import { PaneError } from '../../../shared/paneError';
import { validateCustomCommandResume, type CustomCommandResume } from '../../../shared/types/customCommandResume';
import type { CustomCommand } from '../types/config';

/**
 * Edits to a machine's ordered list of saved launch commands (`customCommands` in config.json).
 * `runpane custom-commands` selects an entry by its exact, case-sensitive name (D-8); the
 * desktop's row editor selects the row it showed, by position and contents, so a list changed
 * meanwhile can never redirect its save to another entry. Errors name entries, never their
 * command or template text, since those can hold anything the owner typed.
 */

/** The resume fields a caller supplied; omitted ones keep their saved (or default) values. */
export interface CustomCommandResumePatch {
  mode?: CustomCommandResume['mode'];
  initialTemplate?: string;
  resumeTemplate?: string;
}

export type CustomCommandEdit =
  | { kind: 'add'; name: string; command: string; resume?: CustomCommandResumePatch }
  | { kind: 'update'; name: string; newName?: string; command?: string; resume?: CustomCommandResumePatch | null }
  | { kind: 'remove'; name: string }
  | { kind: 'reorder'; name: string; position: number }
  /** The desktop row editor: replace (or, with `next: null`, remove) row `index`, only while it still holds `expected`. */
  | { kind: 'row'; index: number; expected: CustomCommand; next: CustomCommand | null };

/** What an edit did, without any command or template text. Positions are 1-based. */
export interface CustomCommandEditOutcome {
  action: 'added' | 'updated' | 'removed' | 'moved';
  name: string;
  /** Where the entry is now; null once removed. */
  position: number | null;
  previousPosition: number | null;
  /** False for a move to the position the entry already holds. */
  changed: boolean;
  count: number;
}

/** The resume templates the desktop form starts from, used when a caller names only a mode. */
const DEFAULT_RESUME: CustomCommandResume = {
  mode: 'reported',
  initialTemplate: '{command}',
  resumeTemplate: '{command} --resume {sessionId}',
};

const FIX_LIST = 'Run `runpane custom-commands list` to see the names on this machine.';

/** The list after an edit, and what the edit did. */
export interface CustomCommandEditResult {
  list: CustomCommand[];
  outcome: CustomCommandEditOutcome;
}

export function applyCustomCommandEdit(current: readonly CustomCommand[], edit: CustomCommandEdit): CustomCommandEditResult {
  const list = [...current];
  switch (edit.kind) {
    case 'add': {
      const name = newName(edit.name);
      refuseTaken(list, name);
      const entry: CustomCommand = { name, command: commandText(edit.command) };
      const resume = edit.resume === undefined ? undefined : mergeResume(undefined, edit.resume, name);
      if (resume) entry.resume = resume;
      list.push(entry);
      return { list, outcome: { action: 'added', name, position: list.length, previousPosition: null, changed: true, count: list.length } };
    }
    case 'update': {
      const index = selectByName(list, edit.name);
      const existing = list[index]!;
      const name = edit.newName === undefined ? existing.name : newName(edit.newName);
      if (name !== existing.name) refuseTaken(list, name);
      const next: CustomCommand = { ...existing, name };
      if (edit.command !== undefined) next.command = commandText(edit.command);
      if (edit.resume === null) delete next.resume;
      else if (edit.resume !== undefined) next.resume = mergeResume(existing.resume ?? undefined, edit.resume, name);
      list[index] = next;
      return { list, outcome: { action: 'updated', name, position: index + 1, previousPosition: index + 1, changed: true, count: list.length } };
    }
    case 'remove': {
      const index = selectByName(list, edit.name);
      list.splice(index, 1);
      return { list, outcome: { action: 'removed', name: edit.name, position: null, previousPosition: index + 1, changed: true, count: list.length } };
    }
    case 'reorder': {
      const index = selectByName(list, edit.name);
      if (!Number.isInteger(edit.position) || edit.position < 1 || edit.position > list.length) {
        throw new PaneError(
          'ERR_CUSTOM_COMMAND_INVALID',
          `Position ${edit.position} is outside the list of ${list.length} custom command${list.length === 1 ? '' : 's'}. Nothing was changed.`,
          `Pass --to with a whole number from 1 to ${list.length}.`,
        );
      }
      const [entry] = list.splice(index, 1);
      list.splice(edit.position - 1, 0, entry!);
      const changed = edit.position - 1 !== index;
      return { list, outcome: { action: 'moved', name: edit.name, position: edit.position, previousPosition: index + 1, changed, count: list.length } };
    }
    case 'row': {
      const row = list[edit.index];
      if (!row || !sameEntry(row, edit.expected)) {
        throw new PaneError(
          'ERR_CUSTOM_COMMAND_CHANGED',
          `The custom command "${edit.expected.name}" changed or moved on this machine while it was being edited. Nothing was saved.`,
          'Open the menu again and repeat the change on the current list.',
        );
      }
      if (edit.next === null) {
        list.splice(edit.index, 1);
        return { list, outcome: { action: 'removed', name: row.name, position: null, previousPosition: edit.index + 1, changed: true, count: list.length } };
      }
      const next: CustomCommand = { ...edit.next, name: newName(edit.next.name), command: commandText(edit.next.command) };
      if (next.resume) next.resume = validResume(next.resume, next.name);
      else delete next.resume;
      list[edit.index] = next;
      return { list, outcome: { action: 'updated', name: next.name, position: edit.index + 1, previousPosition: edit.index + 1, changed: true, count: list.length } };
    }
  }
}

/** The one entry with exactly this name; zero or several matches are refused. */
function selectByName(list: readonly CustomCommand[], name: string): number {
  const matches = list.flatMap((entry, index) => (entry.name === name ? [index] : []));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const otherCase = list.find(entry => entry.name.toLowerCase() === name.toLowerCase());
    throw new PaneError(
      'ERR_CUSTOM_COMMAND_NOT_FOUND',
      `No custom command is named "${name}" on this machine (names match exactly, including case). Nothing was changed.`,
      otherCase ? `Did you mean "${otherCase.name}"? ${FIX_LIST}` : FIX_LIST,
    );
  }
  throw new PaneError(
    'ERR_CUSTOM_COMMAND_AMBIGUOUS',
    `${matches.length} custom commands are named "${name}" (positions ${matches.map(index => index + 1).join(', ')}), so runpane cannot tell which one to change. Nothing was changed.`,
    'Rename or remove the extra entries in the desktop "+" menu (pencil or ×), then run the command again.',
  );
}

function refuseTaken(list: readonly CustomCommand[], name: string): void {
  if (!list.some(entry => entry.name === name)) return;
  throw new PaneError(
    'ERR_CUSTOM_COMMAND_EXISTS',
    `A custom command named "${name}" already exists on this machine. Nothing was changed.`,
    `Choose another name, or change the existing one with \`runpane custom-commands update "${name}" ...\`.`,
  );
}

function newName(value: string): string {
  const name = value.trim();
  if (!name) throw invalid('A custom command needs a name that is not blank.', 'Pass a name with --name.');
  return name;
}

function commandText(value: string): string {
  const command = value.trim();
  if (!command) throw invalid('A custom command needs a command that is not blank.', 'Pass the command line to run with --command.');
  return command;
}

function mergeResume(saved: CustomCommandResume | undefined, patch: CustomCommandResumePatch, name: string): CustomCommandResume {
  if (!saved && patch.mode === undefined) {
    throw invalid(
      `"${name}" has no resume settings, so a resume template needs --resume-mode too.`,
      'Add --resume-mode <reported|generated|claude|codex|cursor>, or leave the template flags out.',
    );
  }
  const base = saved ?? DEFAULT_RESUME;
  return validResume({
    mode: patch.mode ?? base.mode,
    initialTemplate: patch.initialTemplate ?? base.initialTemplate,
    resumeTemplate: patch.resumeTemplate ?? base.resumeTemplate,
  }, name);
}

function validResume(resume: CustomCommandResume, name: string): CustomCommandResume {
  try {
    return validateCustomCommandResume(resume);
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/\.+$/, '') : String(error);
    throw invalid(
      `The resume settings for "${name}" are not valid: ${reason}.`,
      'Templates use {command} for the command and {sessionId} for the ID; the resume template always needs {sessionId}, and so does the first launch template with --resume-mode generated or claude.',
    );
  }
}

function sameEntry(a: CustomCommand, b: CustomCommand): boolean {
  const resumeA = a.resume ?? null;
  const resumeB = b.resume ?? null;
  return a.name === b.name && a.command === b.command
    && (resumeA === resumeB || (resumeA !== null && resumeB !== null
      && resumeA.mode === resumeB.mode && resumeA.initialTemplate === resumeB.initialTemplate && resumeA.resumeTemplate === resumeB.resumeTemplate));
}

function invalid(message: string, next: string): PaneError {
  return new PaneError('ERR_CUSTOM_COMMAND_INVALID', `${message} Nothing was changed.`, next);
}
