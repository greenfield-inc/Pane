import type { ComposerTrigger } from '../../../../shared/composerMentions';
import type { ChatTabFile } from '../../../../shared/types/chatTab';
import type { ChatMenuCommand } from './chatCommands';

export type ComposerRow = { id: string } & ({ file: ChatTabFile } | { command: ChatMenuCommand });

/** The open menu: its rows, or why there are none. */
export interface ComposerMenu { trigger: ComposerTrigger; rows: ComposerRow[]; status?: string }

/** A row's element id, for the message box's aria-activedescendant. */
export function rowId(id: string, row: ComposerRow, rows: readonly ComposerRow[]): string {
  return `${id}-${rows.indexOf(row)}`;
}
