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

/** The agent's own commands and skills, from its available_commands update. */
export function ChatCommandMenu({ commands, active, onPick }: { commands: ChatTabCommand[]; active: number; onPick: (command: ChatTabCommand) => void }) {
  if (!commands.length) return null;
  return <ul role="listbox" aria-label="Agent commands" className="chat-commands">
    {commands.map((command, index) => <li key={command.name} role="option" aria-selected={index === active}>
      <button type="button" tabIndex={-1} onMouseDown={event => { event.preventDefault(); onPick(command); }}>
        <span className="chat-command-name">/{command.name}</span>
        {command.description && <span className="chat-command-description">{command.description}</span>}
      </button>
    </li>)}
  </ul>;
}
