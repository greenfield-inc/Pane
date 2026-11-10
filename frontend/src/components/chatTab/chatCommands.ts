import type { ChatTabCommand } from '../../../../shared/types/chatTab';

/** The commands matching a draft that is only "/name" so far, best match first. */
export function matchingCommands(draft: string, commands: readonly ChatTabCommand[]): ChatTabCommand[] {
  const match = /^\/(\S*)$/.exec(draft);
  if (!match) return [];
  const query = match[1].toLowerCase();
  return commands
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
