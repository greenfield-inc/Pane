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
