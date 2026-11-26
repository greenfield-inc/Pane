import type { ChatTabCommand } from '../../../../shared/types/chatTab';

/** A composer menu entry: the agent's own command, or one Pane handles itself (`source: 'pane'`), labelled "Pane". */
export type ChatMenuCommand = ChatTabCommand & { source?: 'pane' };

/** Pane's /resume (D-277): opens the picker of the folder's past conversations; never sent to the agent. */
export const RESUME_COMMAND: ChatMenuCommand = { name: 'resume', description: 'Continue a past conversation in this folder', source: 'pane' };

/** Pane's own /clear (D-211): a fresh conversation in the same tab, with the same agent and settings. Never sent to the agent. */
export const CLEAR_COMMAND: ChatMenuCommand = { name: 'clear', description: 'Start a fresh conversation in this tab' };

/** The agent's commands with Pane's own, which replace an agent command of the same name. */
export function menuCommands(commands: readonly ChatTabCommand[], clearable: boolean): ChatMenuCommand[] {
  const pane = clearable ? [CLEAR_COMMAND, RESUME_COMMAND] : [RESUME_COMMAND];
  const names = new Set(pane.map(command => command.name));
  return [...pane, ...commands.filter(command => !names.has(command.name))];
}

/** The draft is the /clear command alone. */
export function isClearCommand(draft: string): boolean { return draft.trim() === `/${CLEAR_COMMAND.name}`; }

/** A message that is exactly /resume: Pane opens its picker instead of sending it. */
export function isResumeCommand(text: string): boolean {
  return text.trim() === `/${RESUME_COMMAND.name}`;
}
