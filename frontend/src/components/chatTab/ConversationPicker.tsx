import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { CHAT_CONVERSATION_LIMIT, type ChatTabConversation } from '../../../../shared/types/chatTab';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { canPick, conversationTime, conversationTitle, enterOpens, filterConversations, firstPickable, stepPickable } from './pickerRows';

export interface ConversationPickerViewProps {
  /** Undefined while loading. */
  rows: ChatTabConversation[] | undefined;
  filter: string;
  /** Index into the rows the filter leaves. */
  selected: number;
  busy: boolean;
  /** Why listing or opening failed (such as a refusal mid-turn), shown inline. */
  error?: string;
  now?: Date;
  onFilter: (filter: string) => void;
  onSelect: (index: number) => void;
  onOpen: () => void;
  onCancel: () => void;
  onKey: (event: KeyboardEvent) => void;
  /** The live picker opens it as a modal; a static render leaves it closed. */
  dialogRef?: Ref<HTMLDialogElement>;
}

/** The picker as drawn (picker-v3): header, filter, rows, keys and buttons. */
export function ConversationPickerView({ rows, filter, selected, busy, error, now, onFilter, onSelect, onOpen, onCancel, onKey, dialogRef }: ConversationPickerViewProps) {
  const shown = rows ? filterConversations(rows, filter) : [];
  const chosen = shown[selected];
  return <dialog ref={dialogRef} aria-label="Continue a past conversation" className="chat-picker" onKeyDown={onKey}
    onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="chat-picker-head">
      <p className="chat-picker-title">Continue a past conversation</p>
      <p className="chat-picker-subline">Conversations in this folder, newest first. Picking one reloads this chat on it.</p>
      <input type="text" className="chat-picker-filter" aria-label="Filter by title" placeholder="Filter by title" value={filter} autoFocus onChange={event => onFilter(event.target.value)} />
    </div>
    {error && <p role="alert" className="chat-picker-error">{error}</p>}
    {!rows
      ? <p role="status" className="chat-picker-empty">Loading conversations…</p>
      : !shown.length
        // A list that failed says why above; an empty state under it would contradict it (QA F3).
        ? error ? null : <p className="chat-picker-empty">{filter.trim() ? `No conversation matches “${filter.trim()}”.` : 'No past conversations in this folder yet.'}</p>
        : <ul role="listbox" aria-label="Past conversations" className="chat-picker-list">
          {shown.map((row, index) => {
            const time = conversationTime(row.updatedAt, now);
            return <li key={row.sessionId} role="option" aria-selected={index === selected} aria-disabled={!canPick(row) || undefined}
              className="chat-picker-row" data-open-elsewhere={row.openIn ? true : undefined}
              onMouseDown={event => { event.preventDefault(); if (canPick(row)) onSelect(index); }}
              onDoubleClick={() => { if (canPick(row)) onOpen(); }}>
              <span className="chat-picker-row-title">{conversationTitle(row)}</span>
              {row.openIn && <span className="chat-picker-tag">Open in tab “{row.openIn.title}”</span>}
              <span className="chat-picker-row-meta">{[time, row.current ? 'open here' : ''].filter(Boolean).join(' · ')}</span>
            </li>;
          })}
        </ul>}
    {rows && rows.length >= CHAT_CONVERSATION_LIMIT && <p className="chat-picker-subline">Pane lists the newest {CHAT_CONVERSATION_LIMIT.toLocaleString('en-US')} conversations, so older ones aren't shown here. To continue an older one, resume it from a terminal tab.</p>}
    <div className="chat-picker-foot">
      <span className="chat-picker-keys" aria-hidden="true">
        <kbd><ArrowUp /></kbd><kbd><ArrowDown /></kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close
      </span>
      <button type="button" className="chat-button chat-button-outline" onClick={onCancel}>Cancel</button>
      <button type="button" className="chat-button chat-button-primary" disabled={busy || !chosen || !canPick(chosen)} onClick={onOpen}>Open</button>
    </div>
  </dialog>;
}

/**
 * "Continue a past conversation" (D-277): the folder's conversations, from /resume or the
 * Switch to chat banner's "Pick another". Picking one reloads the chat on it; a conversation
 * open in another Pane tab can't be picked, and a refusal (mid-turn) shows here.
 */
export function ConversationPicker({ load, onResume, onClose }: {
  load: () => Promise<ChatTabConversation[]>;
  onResume: (sessionId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ChatTabConversation[]>();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const found = await load();
        if (!live) return;
        setRows(found);
        setSelected(Math.max(0, firstPickable(found)));
      } catch (failure) {
        if (!live) return;
        setRows([]);
        setError(ipcErrorMessage(failure, 'Pane could not list this folder\'s conversations.'));
      }
    })();
    return () => { live = false; };
  }, [load]);
  const shown = useMemo(() => rows ? filterConversations(rows, filter) : [], [rows, filter]);
  // A modal dialog (focus stays in it, Esc closes it) drawn over this chat's column, as designed:
  // the layer marks the column, and the dialog is placed on it and follows its size.
  const layer = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    const column = layer.current;
    if (!element || !column) return;
    const place = () => {
      const rect = column.getBoundingClientRect();
      const width = Math.min(rect.width - 32, parseFloat(getComputedStyle(element).maxWidth) || rect.width - 32);
      element.style.top = `${rect.top + 12}px`;
      element.style.left = `${rect.left + (rect.width - width) / 2}px`;
      element.style.width = `${width}px`;
      element.style.maxHeight = `${Math.max(160, rect.height - 24)}px`;
    };
    place();
    if (!element.open) element.showModal();
    const observer = new ResizeObserver(place);
    observer.observe(column);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); if (element.open) element.close(); };
  }, []);

  const open = async () => {
    const row = shown[selected];
    if (!row || !canPick(row) || busy) return;
    // The chat is already on it: nothing to reload.
    if (row.current) { onClose(); return; }
    setBusy(true);
    setError(undefined);
    try {
      await onResume(row.sessionId);
      onClose();
    } catch (failure) {
      setError(ipcErrorMessage(failure, 'Pane did not say why.'));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // Enter opens from the filter or the list; on a focused button it presses that button (Cancel cancels, review F-5).
    if (event.key === 'Enter') {
      if (!enterOpens(event.target instanceof HTMLElement ? event.target.tagName : undefined)) return;
      event.preventDefault(); void open(); return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown.length) {
      event.preventDefault();
      setSelected(index => stepPickable(shown, index, event.key === 'ArrowDown' ? 1 : -1));
    }
  };
  // The layer dims this chat under the picker; a click outside the picker reaches the dialog's backdrop and closes it.
  return <div ref={layer} aria-hidden="true" className="chat-picker-layer">
    <ConversationPickerView rows={rows} filter={filter} selected={selected} busy={busy} error={error}
      onFilter={value => { setFilter(value); setSelected(Math.max(0, firstPickable(rows ? filterConversations(rows, value) : []))); }}
      onSelect={setSelected} onOpen={() => void open()} onCancel={onClose} onKey={onKey} dialogRef={dialog} />
  </div>;
}
