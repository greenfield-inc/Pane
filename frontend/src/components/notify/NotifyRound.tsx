import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CornerDownLeft, X } from 'lucide-react';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { NOTIFY_KIND_DOT, NOTIFY_KIND_LABEL, relativeAge } from './notifyFormat';
import { ShortcutCap } from './NotifyCard';
import { useNow } from './useNow';

interface NotifyRoundProps {
  snapshot: NotifySnapshot;
  /** The question the round was opened on; it starts there when it is still queued. */
  startId?: string;
  onCommand: (command: NotifyCommand) => void;
}

/**
 * Answer all: a centered, keyboard-first panel that walks the queue. Number keys
 * or arrows choose, ↵ sends, → skips, Tab opens a note and Esc closes.
 */
export function NotifyRound({ snapshot, startId, onCommand }: NotifyRoundProps) {
  const [pinnedId, setPinnedId] = useState(startId);
  const currentId = pinnedId && snapshot.queue.includes(pinnedId) ? pinnedId : snapshot.queue[0];
  const item = snapshot.items.find((candidate) => candidate.id === currentId);
  const empty = snapshot.queue.length === 0;
  const closedRef = useRef(false);

  // The window is reused, so each batch of questions gets one close when it empties.
  useEffect(() => {
    if (!empty) {
      closedRef.current = false;
      return;
    }
    if (closedRef.current) return;
    closedRef.current = true;
    onCommand({ type: 'close-round' });
  }, [empty, onCommand]);

  if (!item) return null;
  const position = snapshot.queue.indexOf(item.id) + 1;
  return (
    <RoundPanel
      key={item.id}
      item={item}
      position={position}
      total={snapshot.queue.length}
      onCommand={(command) => {
        if (command.type === 'answer' || command.type === 'skip') setPinnedId(undefined);
        onCommand(command);
      }}
    />
  );
}

interface RoundPanelProps {
  item: NotifyItem;
  position: number;
  total: number;
  onCommand: (command: NotifyCommand) => void;
}

interface RoundRow {
  key: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

function rowsFor(item: NotifyItem): RoundRow[] {
  if (item.ui === 'approve') {
    return [
      { key: 'Y', label: 'Approve' },
      { key: 'N', label: 'Deny', detail: 'You can add a reason' },
    ];
  }
  if (item.ui === 'ask') {
    return (item.suggestions ?? []).map((suggestion, index) => ({ key: String(index + 1), label: suggestion }));
  }
  return (item.choices ?? []).map((choice, index) => ({
    key: String(index + 1),
    label: choice.label,
    detail: choice.detail,
    recommended: choice.recommended,
  }));
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function RoundPanel({ item, position, total, onCommand }: RoundPanelProps) {
  const now = useNow();
  const rows = rowsFor(item);
  const approval = item.ui === 'approve';
  const ask = item.ui === 'ask';
  // Approvals start with nothing chosen: Y or N is required.
  const [selected, setSelected] = useState(() => (approval || ask) ? -1 : Math.max(0, rows.findIndex((row) => row.recommended)));
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const noteRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (ask) textRef.current?.focus(); }, [ask]);
  useEffect(() => { if (noteOpen) noteRef.current?.focus(); }, [noteOpen]);

  const send = (index = selected) => {
    const trimmedNote = note.trim();
    if (ask) {
      const answer = (index >= 0 ? rows[index]?.label : text)?.trim();
      if (answer) onCommand({ type: 'answer', id: item.id, answer: { text: answer } });
      return;
    }
    if (index < 0) return;
    if (approval) {
      const approved = index === 0;
      onCommand({ type: 'answer', id: item.id, answer: trimmedNote ? { approved, note: trimmedNote } : { approved } });
      return;
    }
    const label = rows[index]?.label;
    if (label) onCommand({ type: 'answer', id: item.id, answer: trimmedNote ? { choice: label, note: trimmedNote } : { choice: label } });
  };

  // Read the latest state from the key handler without re-binding it each render.
  const sendRef = useRef(send);
  const stateRef = useRef({ selected, noteOpen });
  useLayoutEffect(() => {
    sendRef.current = send;
    stateRef.current = { selected, noteOpen };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = isTextInput(event.target);
      if (event.key === 'Escape') {
        event.preventDefault();
        onCommand({ type: 'close-round' });
        return;
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        sendRef.current();
        return;
      }
      if (event.key === 'Tab' && !ask) {
        event.preventDefault();
        setNoteOpen((open) => !open);
        return;
      }
      if (typing) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onCommand({ type: 'skip', id: item.id });
        return;
      }
      if (approval) {
        if (event.key === 'y' || event.key === 'Y') setSelected(0);
        if (event.key === 'n' || event.key === 'N') setSelected(1);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const current = stateRef.current.selected;
        setSelected(current < 0 ? 0 : (current + step + rows.length) % rows.length);
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (digit >= 1 && digit <= rows.length) setSelected(digit - 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [approval, ask, item.id, onCommand, rows.length]);

  const canSend = ask ? text.trim().length > 0 : selected >= 0;
  const action = approval && selected < 0 ? 'Press Y or N' : `Send to ${item.source.agent}`;

  return (
    <div className="w-[700px] overflow-hidden rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary" data-testid="notify-round">
      <div className="flex items-start gap-2.5 pb-1 pl-[26px] pr-[22px] pt-[22px]">
        <h1 className="flex-1 text-[22px] font-semibold leading-[1.3] tracking-[-0.02em] text-text-primary">{item.title}</h1>
        <button
          type="button"
          aria-label="Close"
          onClick={() => onCommand({ type: 'close-round' })}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 px-[26px] text-[13px] text-text-tertiary">
        <span className="inline-flex items-center gap-[7px] font-medium text-text-secondary">
          <span className={cn('h-[7px] w-[7px] rounded-full', NOTIFY_KIND_DOT[item.ui])} aria-hidden="true" />
          {NOTIFY_KIND_LABEL[item.ui]}
        </span>
        <span className="truncate">{item.source.name} · {item.source.agent} · {relativeAge(item.createdAt, now)}</span>
      </div>
      {item.context && <div className="px-[26px] py-1.5 text-[14.5px] text-text-tertiary">{item.context}</div>}
      {item.ui === 'approve' && item.detail && (
        <pre className="mx-[26px] mb-1 mt-1.5 max-h-40 overflow-auto rounded-xl bg-surface-tertiary px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-text-secondary">{item.detail}</pre>
      )}

      <div className="mt-2.5 border-t border-border-secondary px-[26px] pb-1.5 pt-3.5 text-[13px] text-text-tertiary">
        {ask ? 'Your answer' : 'Choose one'}
      </div>
      {ask && (
        <div className="px-[26px] pb-2">
          <input
            ref={textRef}
            value={text}
            onChange={(event) => { setText(event.target.value); setSelected(-1); }}
            placeholder="Type your answer"
            aria-label="Your answer"
            className="h-[46px] w-full rounded-xl bg-surface-tertiary px-3.5 text-[16px] text-text-primary outline-none placeholder:text-text-muted focus:ring-[1.5px] focus:ring-inset focus:ring-border-hover"
          />
        </div>
      )}
      {rows.length > 0 && (
        <div className="px-3 pb-3" role="listbox" aria-label={ask ? 'Suggestions' : 'Choices'}>
          {rows.map((row, index) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={index === selected}
              onClick={() => {
                if (!ask) {
                  setSelected(index);
                  return;
                }
                // A suggestion fills the field; ↵ sends it.
                setText(row.label);
                setSelected(-1);
                textRef.current?.focus();
              }}
              onDoubleClick={() => { if (!ask) send(index); }}
              className={cn(
                'flex h-[50px] w-full items-center gap-3.5 rounded-xl px-3.5 text-left text-[16px]',
                index === selected ? 'bg-surface-tertiary' : 'hover:bg-surface-hover',
              )}
            >
              <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md border border-border-primary font-mono text-[11px] font-medium text-text-tertiary">{row.key}</span>
              <span className="text-text-primary">{row.label}</span>
              {row.detail && <span className="min-w-0 truncate text-[14px] text-text-muted">{row.detail}</span>}
              {row.recommended && <span className="ml-auto shrink-0 text-[13px] text-text-tertiary">Recommended</span>}
              {/* The return icon keeps its box on every row so selection never shifts the text. */}
              <CornerDownLeft className={cn('h-4 w-4 shrink-0 text-text-tertiary', !row.recommended && 'ml-auto', index !== selected && 'invisible')} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {noteOpen && !ask && (
        <div className="px-[26px] pb-3">
          <input
            ref={noteRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={approval ? `Reason for ${item.source.agent} (optional)` : `Add a note for ${item.source.agent} (optional)`}
            aria-label="Note"
            className="h-[42px] w-full rounded-xl bg-surface-tertiary px-3.5 text-[14.5px] text-text-primary outline-none placeholder:text-text-muted focus:ring-[1.5px] focus:ring-inset focus:ring-border-hover"
          />
        </div>
      )}

      <div className="flex items-center gap-[22px] border-t border-border-secondary px-[26px] py-3.5 text-[13.5px] text-text-tertiary">
        <FooterKey label="Close" cap="Esc" onClick={() => onCommand({ type: 'close-round' })} />
        <FooterKey label="Skip" cap={<ArrowRight className="inline h-3 w-3" />} onClick={() => onCommand({ type: 'skip', id: item.id })} />
        {!ask && <FooterKey label="Note" cap="Tab" onClick={() => setNoteOpen((open) => !open)} />}
        <div className="ml-auto flex items-center gap-[22px]">
          <span className="tabular-nums">{position} of {total}</span>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => send()}
            className="inline-flex items-center gap-[7px] font-medium text-text-primary disabled:cursor-default"
          >
            {action}
            {!(approval && selected < 0) && <ShortcutCap><CornerDownLeft className="inline h-3 w-3" /></ShortcutCap>}
          </button>
        </div>
      </div>
    </div>
  );
}

function FooterKey({ label, cap, onClick }: { label: string; cap: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-[7px] hover:text-text-primary">
      {label} <ShortcutCap>{cap}</ShortcutCap>
    </button>
  );
}
