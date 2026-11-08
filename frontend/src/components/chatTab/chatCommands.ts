import type { ChatTabCommand } from '../../../../shared/types/chatTab';

/** A composer menu entry: the agent's own command, or one Pane handles itself (`source: 'pane'`), labelled "Pane". */
export type ChatMenuCommand = ChatTabCommand & { source?: 'pane' };

/** Pane's /resume (D-277): opens the picker of the folder's past conversations; never sent to the agent. */
export const RESUME_COMMAND: ChatMenuCommand = { name: 'resume', description: 'Continue a past conversation in this folder', source: 'pane' };

const PANE_COMMANDS: readonly ChatMenuCommand[] = [RESUME_COMMAND];

/** The commands matching a draft that is only "/name" so far, best match first. Pane's own replace an agent command of the same name. */
export function matchingCommands(draft: string, commands: readonly ChatTabCommand[]): ChatMenuCommand[] {
  const match = /^\/(\S*)$/.exec(draft);
  if (!match) return [];
  const query = match[1].toLowerCase();
  const pane = new Set(PANE_COMMANDS.map(command => command.name));
  return [...PANE_COMMANDS, ...commands.filter(command => !pane.has(command.name))]
    .filter(command => command.name.toLowerCase().includes(query))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name))
    .slice(0, 12);
}

/** Pane's own /clear (D-211): a fresh conversation in the same tab, with the same agent and settings. Never sent to the agent. */
export const CLEAR_COMMAND: ChatTabCommand = { name: 'clear', description: 'Start a fresh conversation in this tab' };

/** The agent's commands with Pane's own; an agent's /clear is replaced by Pane's, which works the same for every agent. */
export function withPaneCommands(commands: readonly ChatTabCommand[]): ChatTabCommand[] {
  return [CLEAR_COMMAND, ...commands.filter(command => command.name !== CLEAR_COMMAND.name)];
}

/** The draft is the /clear command alone. */
export function isClearCommand(draft: string): boolean { return draft.trim() === `/${CLEAR_COMMAND.name}`; }

/** A message that is exactly /resume: Pane opens its picker instead of sending it. */
export function isResumeCommand(text: string): boolean {
  return text.trim() === `/${RESUME_COMMAND.name}`;
}
