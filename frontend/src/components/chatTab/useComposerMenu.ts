import { useId, useState, type KeyboardEvent, type RefObject } from 'react';
import { applyPick, COMPOSER_MENU_TEXT, commandRows, commandText, fileReference, isMidMessageSlash, matchedParts, messageReferences, moveMarks, type ComposerMark, type ComposerTrigger } from '../../../../shared/composerMentions';
import type { ChatTabClient, ChatTabView } from '../../../../shared/types/chatTab';
import type { ChatMenuCommand } from './chatCommands';
import { rowId, type ComposerMenu, type ComposerRow } from './composerRows';
import { useComposerTrigger } from './useComposerTrigger';
import { useFileSearch, type FileSearch } from './useFileSearch';

function fileMenu(trigger: ComposerTrigger, search: FileSearch): ComposerMenu {
  const status = search.status === 'searching' || search.query !== trigger.query ? COMPOSER_MENU_TEXT.searchingFiles : search.status === 'failed' ? COMPOSER_MENU_TEXT.filesFailed : COMPOSER_MENU_TEXT.noFiles;
  // Rows of the query before, while this one's search runs: only those it still matches.
  const rows = search.query === trigger.query ? search.rows : search.rows.filter(file => matchedParts(file.path, trigger.query).some(part => part.matched));
  return { trigger, rows: rows.map(file => ({ id: `file:${file.path}`, file })), status };
}

function commandMenu(trigger: ComposerTrigger, commands: readonly ChatMenuCommand[], view: ChatTabView | undefined): ComposerMenu | undefined {
  const rows = commandRows(trigger, commands, view?.mentions);
  if (!rows) return undefined;
  return {
    trigger, rows: rows.map(command => ({ id: `${command.source ?? 'agent'}:${command.name}`, command })),
    status: !view || (view.status === 'starting' && !view.commands.length) ? COMPOSER_MENU_TEXT.loadingSkills : COMPOSER_MENU_TEXT.noSkills,
  };
}

/** The message box's @, $ and / menu and its highlighted references. */
export function useComposerMenu({ client, panelId, view, draft, commands, skills, input, setText, runPaneCommand }: {
  client: ChatTabClient; panelId: string; view: ChatTabView | undefined; draft: string;
  commands: readonly ChatMenuCommand[]; skills: ReadonlySet<string>; input: RefObject<HTMLTextAreaElement | null>;
  setText: (text: string) => void;
  /** Runs one of Pane's own commands, picked as a row. */
  runPaneCommand: (command: ChatMenuCommand) => void;
}) {
  const id = useId();
  const state = useComposerTrigger(draft);
  const { trigger } = state;
  const search = useFileSearch(client, panelId, trigger?.kind === 'file' && view?.mentions?.files ? trigger.query : undefined);
  const menu = !trigger ? undefined : trigger.kind !== 'file' ? commandMenu(trigger, commands, view) : view?.mentions?.files ? fileMenu(trigger, search) : undefined;
  /** The row chosen by key or pointer, for as long as the same word is searched. */
  const [chosen, setChosen] = useState<{ search: string; id: string }>();
  const searchKey = trigger ? `${trigger.kind}:${trigger.rangeStart}:${trigger.query}` : '';
  const midMessage = !!trigger && isMidMessageSlash(trigger);
  const chosenRow = chosen?.search === searchKey ? menu?.rows.find(row => row.id === chosen.id) : undefined;
  const active = chosenRow ?? (midMessage ? undefined : menu?.rows[0]);
  const choose = (row: ComposerRow) => setChosen({ search: searchKey, id: row.id });

  /** Picked references, for the text they are in; text from elsewhere (a restored draft) marks what reads as one. */
  const [picked, setPicked] = useState<{ text: string; marks: ComposerMark[] }>({ text: '', marks: [] });
  const marksOf = (text: string) => picked.text === text ? picked.marks : messageReferences(text, skills);

  const pick = (row: ComposerRow) => {
    if (!trigger) return;
    if ('command' in row && row.command.source === 'pane') { runPaneCommand(row.command); return; }
    const reference = 'file' in row ? fileReference(row.file) : commandText(row.command);
    const next = applyPick(draft, trigger, reference);
    const isReference = 'file' in row || !!row.command.skill;
    const marks = [...moveMarks(marksOf(draft), draft, next.text), ...(isReference ? [next.mark] : [])].sort((a, b) => a.start - b.start);
    setPicked({ text: next.text, marks });
    setText(next.text);
    const box = input.current;
    if (!box) return;
    // Set here, not on React's next render, so the text and caret show in the same frame.
    box.value = next.text;
    box.focus({ preventScroll: true });
    box.setSelectionRange(next.cursor, next.cursor);
  };

  return {
    menu, active, pick,
    hover: (row: ComposerRow) => { if (!midMessage && row !== active) choose(row); },
    marks: marksOf(draft),
    listId: id,
    /** Names the list and the chosen row to a screen reader. */
    inputProps: {
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
      'aria-controls': menu?.rows.length ? id : undefined,
      'aria-activedescendant': menu && active ? rowId(id, active, menu.rows) : undefined,
    },
    changed: (box: HTMLTextAreaElement, pasted: boolean) => {
      setPicked({ text: box.value, marks: moveMarks(marksOf(draft), draft, box.value) });
      state.edited(box.value, box.selectionStart, pasted);
    },
    caretMoved: (box: HTMLTextAreaElement) => {
      if (box.value === draft) state.caretMoved(box.value, box.selectionStart, box.selectionEnd);
    },
    /** Handles a key the open menu takes; true when it did. */
    keyDown: (event: KeyboardEvent): boolean => {
      if (!menu) return false;
      if (event.key === 'Escape') { event.preventDefault(); state.dismiss(); return true; }
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !menu.rows.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const from = active ? menu.rows.indexOf(active) : step > 0 ? -1 : menu.rows.length;
        choose(menu.rows[(from + step + menu.rows.length) % menu.rows.length]);
        return true;
      }
      const target = event.key === 'Tab' ? active ?? menu.rows[0] : event.key === 'Enter' ? active : undefined;
      if (!target) return false;
      // A command typed in full is sent, as without a menu.
      if (event.key === 'Enter' && 'command' in target && !target.command.skill && draft === commandText(target.command)) return false;
      event.preventDefault();
      pick(target);
      return true;
    },
  };
}
