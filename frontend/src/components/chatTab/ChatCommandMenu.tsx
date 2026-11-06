import type { ChatTabCommand } from '../../../../shared/types/chatTab';

/** The agent's own commands and skills, from its available_commands update. */
export function ChatCommandMenu({ commands, active, onPick }: { commands: ChatTabCommand[]; active: number; onPick: (command: ChatTabCommand) => void }) {
  if (!commands.length) return null;
  // Arrow keys and Enter stay in the composer; a pointer picks a row directly.
  return <ul role="listbox" aria-label="Agent commands" className="chat-commands">
    {commands.map((command, index) => <li key={command.name} role="option" aria-selected={index === active} onMouseDown={event => { event.preventDefault(); onPick(command); }}>
      <span className="chat-command-name">/{command.name}</span>
      {command.description && <span className="chat-command-description">{command.description}</span>}
    </li>)}
  </ul>;
}
