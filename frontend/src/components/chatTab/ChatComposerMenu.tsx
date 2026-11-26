import { useEffect, useRef, type ReactNode } from 'react';
import { File, Folder, Sparkle, SquareSlash } from 'lucide-react';
import { COMPOSER_MENU_TEXT, commandLabel, isMidMessageSlash, matchedParts, type ComposerTrigger } from '../../../../shared/composerMentions';
import { rowId, type ComposerMenu, type ComposerRow } from './composerRows';

const LISTS = { file: 'Files', skill: 'Skills', command: 'Agent commands' } as const;

function Matched({ text, query }: { text: string; query: string }) {
  return <>{matchedParts(text, query).map((part, index) => part.matched ? <b key={index}>{part.text}</b> : part.text)}</>;
}

function Row({ row, trigger }: { row: ComposerRow; trigger: ComposerTrigger }): ReactNode {
  if ('file' in row) {
    const { path, isDirectory, changed } = row.file;
    const slash = path.lastIndexOf('/');
    const Icon = isDirectory ? Folder : File;
    return <>
      <Icon className="chat-command-icon" aria-hidden />
      <span className="chat-command-name"><Matched text={path.slice(slash + 1)} query={trigger.query} />{isDirectory && '/'}</span>
      {slash > 0 && <span className="chat-command-description">{path.slice(0, slash)}</span>}
      {changed && <span className="chat-command-source">Changed</span>}
    </>;
  }
  const { command } = row;
  const label = commandLabel(trigger, command);
  const Icon = command.skill ? Sparkle : SquareSlash;
  return <>
    <Icon className="chat-command-icon" aria-hidden />
    <span className="chat-command-name">{label[0]}<Matched text={label.slice(1)} query={trigger.query} /></span>
    {command.description && <span className="chat-command-description">{command.description}</span>}
    {command.source === 'pane' && <span className="chat-command-source">Pane</span>}
  </>;
}

/**
 * The one menu of @ files, $ skills and / commands, above the message box. Arrow keys and Enter
 * stay in the composer; a pointer picks a row directly.
 */
export function ChatComposerMenu({ id, menu, active, onHover, onPick }: {
  id: string; menu: ComposerMenu; active: ComposerRow | undefined;
  onHover: (row: ComposerRow) => void; onPick: (row: ComposerRow) => void;
}) {
  const { trigger, rows, status } = menu;
  const list = useRef<HTMLUListElement>(null);
  const activeId = active?.id;
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  const hint = isMidMessageSlash(trigger) && !active;
  return <div className="chat-commands">
    {rows.length > 0 && <ul ref={list} id={id} role="listbox" aria-label={LISTS[trigger.kind]}>
      {rows.map(row => <li key={row.id} id={rowId(id, row, rows)} role="option" aria-selected={row.id === activeId}
        onMouseMove={() => onHover(row)} onMouseDown={event => { event.preventDefault(); onPick(row); }}><Row row={row} trigger={trigger} /></li>)}
    </ul>}
    {rows.length === 0 && status && <p className="chat-commands-status" role="status">{status}</p>}
    {hint && rows.length > 0 && <p className="chat-commands-hint">{COMPOSER_MENU_TEXT.midMessageHint}</p>}
  </div>;
}
