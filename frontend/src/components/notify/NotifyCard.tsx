import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Bell, Check, Clock, ExternalLink, Info, X } from 'lucide-react';
import type { NotifyChoice, NotifyCommand, NotifyItem, NotifyRemindAfter } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { NOTIFY_KIND_DOT, NOTIFY_KIND_LABEL, relativeAge } from './notifyFormat';
import { useNow } from './useNow';

/** The compact strip shows this many choices, then More. */
const COMPACT_CHOICE_LIMIT = 4;

export interface NotifyQueuePosition {
  /** 1-based place of this question in the queue. */
  index: number;
  total: number;
  next?: NotifyItem;
}

type NotifyCardView = 'question' | 'sent' | 'expired' | 'info';

/**
 * strip: the floating window and the in-Pane strip.
 * docked: under the asking terminal, expanded.
 * inbox: a card on the Notify page.
 */
type NotifyCardForm = 'strip' | 'docked' | 'inbox';

export interface NotifyCardProps {
  item: NotifyItem;
  view: NotifyCardView;
  form: NotifyCardForm;
  onCommand: (command: NotifyCommand) => void;
  queue?: NotifyQueuePosition;
  /** First-run footer hint; the answer-all shortcut as people read it. */
  shortcutHint?: string;
  /** Updates: when the line hides (epoch ms), or null while it is held open. */
  hideAt?: number | null;
  hideAfterMs?: number;
  /** Top right: a narrower strip whose chips wrap. */
  narrow?: boolean;
  /** Which side of the card the "Answer later" menu opens on. */
  menuPlacement?: 'above' | 'below';
  /** The floating strip can't take key focus until asked; called before a field focuses. */
  onFieldFocusRequest?: () => Promise<void>;
  /** Opens an update's link. */
  onOpenUrl?: (url: string) => void;
  className?: string;
}

/** One card for every Notify surface: four looks, plus sent, expired and the update line. */
export function NotifyCard(props: NotifyCardProps) {
  switch (props.view) {
    case 'sent':
      return <SentLine {...props} />;
    case 'info':
      return <InfoLine {...props} />;
    case 'expired':
      return <ExpiredCard {...props} />;
    case 'question':
      return <QuestionCard key={props.item.id} {...props} />;
  }
}

// --- Shared pieces ---

function cardShell(form: NotifyCardForm, narrow?: boolean, className?: string): string {
  if (form === 'inbox') return cn('relative w-full rounded-[18px] bg-surface-primary shadow-card ring-1 ring-border-secondary', className);
  if (form === 'docked') return cn('relative w-full rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary', className);
  return cn('relative rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary', narrow ? 'w-[420px]' : 'w-[640px]', className);
}

function KindLabel({ ui }: { ui: NotifyItem['ui'] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[7px] font-medium text-text-secondary">
      <span className={cn('h-[7px] w-[7px] rounded-full', NOTIFY_KIND_DOT[ui])} aria-hidden="true" />
      {NOTIFY_KIND_LABEL[ui]}
    </span>
  );
}

function KeyCap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-border-primary px-1 font-mono text-[11.5px] font-medium text-text-tertiary', className)}>
      {children}
    </span>
  );
}

export function ShortcutCap({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-md border border-border-primary px-1.5 font-mono text-[11px] leading-[19px] text-text-tertiary">
      {children}
    </span>
  );
}

function Meta({ item }: { item: NotifyItem }) {
  const now = useNow();
  return (
    <span className="min-w-0 truncate">
      · {item.source.name} · {item.source.agent} · {relativeAge(item.createdAt, now)}
    </span>
  );
}

const LATER_OPTIONS: Array<{ after: NotifyRemindAfter; label: string; icon: typeof Clock }> = [
  { after: '10m', label: 'In 10 minutes', icon: Clock },
  { after: '1h', label: 'In 1 hour', icon: Clock },
  { after: 'pane', label: 'When I switch to Pane', icon: Bell },
];

const LONG_PRESS_MS = 500;

/** ✕ hides the question; right-click or a long press offers a reminder instead. */
function CloseButton({ item, onCommand, menuPlacement = 'above' }: Pick<NotifyCardProps, 'item' | 'onCommand' | 'menuPlacement'>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const openedByPress = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  return (
    <div ref={rootRef} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="Close"
        title="Close (right-click to answer later)"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        onPointerDown={() => {
          openedByPress.current = false;
          cancelPress();
          pressTimer.current = window.setTimeout(() => {
            openedByPress.current = true;
            setMenuOpen(true);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={cancelPress}
        onPointerLeave={cancelPress}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelPress();
          setMenuOpen(true);
        }}
        onClick={() => {
          if (openedByPress.current) return;
          onCommand({ type: 'dismiss', id: item.id });
        }}
      >
        <X className="h-4 w-4" />
      </button>
      {menuOpen && (
        <div
          role="menu"
          aria-label="Answer later"
          data-notify-menu=""
          className={cn(
            'absolute right-0 z-20 w-[250px] rounded-2xl bg-surface-primary p-1.5 text-[13px] text-text-primary shadow-modal ring-1 ring-border-secondary',
            menuPlacement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          <div className="px-2.5 pb-0.5 pt-1.5 text-[11.5px] text-text-tertiary">Answer later</div>
          {LATER_OPTIONS.map(({ after, label, icon: Icon }) => (
            <button
              key={after}
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-left hover:bg-surface-hover"
              onClick={() => {
                setMenuOpen(false);
                onCommand({ type: 'remind', id: item.id, after });
              }}
            >
              <Icon className="h-3.5 w-3.5 text-text-secondary" />
              {label}
            </button>
          ))}
          <div className="mx-1.5 my-1 h-px bg-border-secondary" />
          <div className="px-2.5 py-[7px] text-text-tertiary">{item.source.agent} keeps waiting meanwhile</div>
        </div>
      )}
    </div>
  );
}

function CardHeader({ item, form, queue, onCommand, menuPlacement }: Pick<NotifyCardProps, 'item' | 'form' | 'queue' | 'onCommand' | 'menuPlacement'>) {
  const now = useNow();
  if (form === 'inbox') {
    return (
      <div className="flex items-center gap-2 px-3.5 pt-3 text-[12px] text-text-tertiary">
        <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-text-primary text-[10px] font-bold text-bg-primary" aria-hidden="true">P</span>
        <span className="truncate font-medium text-text-secondary">{item.source.name}</span>
        <span className="shrink-0">· {item.source.agent}</span>
        <span className="ml-auto shrink-0">{relativeAge(item.createdAt, now)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 pl-[22px] pr-4 pt-4 text-[13px] text-text-tertiary">
      <KindLabel ui={item.ui} />
      <Meta item={item} />
      {queue && queue.total > 1 && <span className="ml-auto shrink-0 tabular-nums">{queue.index} of {queue.total}</span>}
      <CloseButton item={item} onCommand={onCommand} menuPlacement={menuPlacement} />
    </div>
  );
}

function focusAfterRequest(input: HTMLInputElement | null, request?: () => Promise<void>) {
  if (!input) return;
  if (!request) {
    input.focus();
    return;
  }
  void request().finally(() => input.focus());
}

interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  onFieldFocusRequest?: () => Promise<void>;
  autoFocus?: boolean;
  /** Shows the send arrow, lit once there is text. */
  sendLabel?: string;
  /** Focuses the field each time it changes, such as after a suggestion fills it. */
  focusKey?: number;
}

function TextField({ value, onChange, onSubmit, placeholder, onFieldFocusRequest, autoFocus, sendLabel, focusKey = 0 }: TextFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus || focusKey > 0) focusAfterRequest(inputRef.current, onFieldFocusRequest);
    // Focus when the field appears (autoFocus) and whenever focusKey asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  const hasText = value.trim().length > 0;
  return (
    <div className="flex h-[42px] items-center gap-2 rounded-xl bg-surface-tertiary pl-3.5 pr-2 focus-within:ring-[1.5px] focus-within:ring-inset focus-within:ring-border-hover">
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-text-primary outline-none placeholder:text-text-muted"
        onMouseDown={(event) => {
          if (!onFieldFocusRequest || document.activeElement === inputRef.current) return;
          // The floating strip can't take keys yet: ask for focus first, then focus the field.
          event.preventDefault();
          focusAfterRequest(inputRef.current, onFieldFocusRequest);
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {sendLabel && (
        <button
          type="button"
          aria-label={sendLabel}
          disabled={!hasText}
          onClick={onSubmit}
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-interactive text-text-on-interactive transition-opacity',
            !hasText && 'opacity-35',
          )}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

interface ChipProps {
  keyLabel: string;
  label: string;
  detail?: string;
  shaded?: boolean;
  onClick: () => void;
  tall?: boolean;
  inbox?: boolean;
}

function Chip({ keyLabel, label, detail, shaded, onClick, tall, inbox }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={tall ? shaded : undefined}
      className={cn(
        'inline-flex rounded-xl text-left text-text-secondary hover:bg-surface-hover',
        tall ? 'items-start gap-2.5 px-3 py-2.5' : 'h-[42px] items-center gap-2.5 whitespace-nowrap pl-2.5 pr-3.5',
        inbox ? 'text-[14.5px]' : 'text-[15px]',
        shaded && 'bg-surface-tertiary font-medium text-text-primary hover:bg-surface-tertiary',
      )}
    >
      <KeyCap className={tall ? 'mt-px' : undefined}>{keyLabel}</KeyCap>
      {tall ? (
        <span className="min-w-0">
          <span className="block">{label}</span>
          {detail && <span className="block text-[12px] font-normal leading-snug text-text-tertiary">{detail}</span>}
        </span>
      ) : label}
    </button>
  );
}

function FooterLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 whitespace-nowrap hover:text-text-primary">
      {children}
    </button>
  );
}

function QueueSegments({ queue }: { queue: NotifyQueuePosition }) {
  return (
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      {Array.from({ length: queue.total }, (_, index) => (
        <i
          key={index}
          className={cn(
            'block h-1 w-5 rounded-sm',
            index + 1 === queue.index ? 'bg-status-info' : index + 1 < queue.index ? 'bg-text-muted' : 'bg-border-primary',
          )}
        />
      ))}
    </span>
  );
}

// --- The question card ---

function recommendedIndex(choices: NotifyChoice[]): number {
  return choices.findIndex((choice) => choice.recommended);
}

function QuestionCard({
  item, form, queue, shortcutHint, narrow, menuPlacement, onCommand, onFieldFocusRequest, className,
}: NotifyCardProps) {
  const [expanded, setExpanded] = useState(form === 'docked');
  const choices = item.choices ?? [];
  const [selected, setSelected] = useState(() => recommendedIndex(choices));
  const [note, setNote] = useState('');
  const [denying, setDenying] = useState(false);
  const [showDetail, setShowDetail] = useState(form === 'docked');
  const [text, setText] = useState('');
  const [textFocusKey, setTextFocusKey] = useState(0);
  const titleClass = form === 'inbox'
    ? 'px-3.5 pt-1 text-[14.5px] font-semibold leading-snug text-text-primary'
    : 'px-[22px] pt-1.5 text-[18px] font-semibold leading-[1.35] tracking-[-0.015em] text-text-primary';
  const contextClass = form === 'inbox'
    ? 'px-3.5 pt-0.5 text-[13px] text-text-tertiary'
    : 'px-[22px] pt-1 text-[14px] text-text-tertiary';
  const actionsClass = form === 'inbox' ? 'px-2 pb-3 pt-2.5' : 'px-3.5 py-3';
  const fieldPad = form === 'inbox' ? 'px-3.5 pb-3.5 pt-3' : 'px-[22px] pb-[18px] pt-3';

  const answerChoice = (index: number, withNote?: string) => {
    const choice = choices[index];
    if (!choice) return;
    const trimmed = withNote?.trim();
    onCommand({ type: 'answer', id: item.id, answer: trimmed ? { choice: choice.label, note: trimmed } : { choice: choice.label } });
  };
  const answerApproval = (approved: boolean, reason?: string) => {
    const trimmed = reason?.trim();
    onCommand({ type: 'answer', id: item.id, answer: trimmed ? { approved, note: trimmed } : { approved } });
  };
  const answerText = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) onCommand({ type: 'answer', id: item.id, answer: { text: trimmed } });
  };
  const openInPane = item.source.paneId && form === 'strip'
    ? () => onCommand({ type: 'open-in-pane', id: item.id })
    : undefined;

  const showContext = Boolean(item.context) && (expanded || item.ui === 'approve' || form === 'inbox');
  const recommended = recommendedIndex(choices);

  let body: ReactNode = null;
  if (item.ui === 'options' && expanded) {
    body = (
      <>
        <div className={cn('grid gap-1 px-3.5 pb-3 pt-3', narrow ? 'grid-cols-2' : 'grid-cols-3')}>
          {choices.map((choice, index) => (
            <Chip
              key={choice.label}
              tall
              keyLabel={String(index + 1)}
              label={choice.label}
              detail={choice.detail}
              shaded={index === selected}
              onClick={() => setSelected(index)}
            />
          ))}
        </div>
        <div className="px-4 pb-3.5">
          <TextField
            value={note}
            onChange={setNote}
            onSubmit={() => { if (selected >= 0) answerChoice(selected, note); }}
            placeholder={`Add a note for ${item.source.agent} (optional)`}
            onFieldFocusRequest={onFieldFocusRequest}
          />
        </div>
      </>
    );
  } else if (item.ui === 'options') {
    const visible = choices.slice(0, COMPACT_CHOICE_LIMIT);
    body = (
      <div className={cn('flex flex-wrap items-center gap-1', actionsClass)}>
        {visible.map((choice, index) => (
          <Chip
            key={choice.label}
            keyLabel={String(index + 1)}
            label={choice.label}
            shaded={choice.recommended}
            inbox={form === 'inbox'}
            onClick={() => answerChoice(index)}
          />
        ))}
        {choices.length > COMPACT_CHOICE_LIMIT && (
          <button
            type="button"
            onClick={() => onCommand({ type: 'open-round', id: item.id })}
            className="inline-flex h-[42px] items-center rounded-xl px-3.5 text-[15px] text-text-secondary hover:bg-surface-hover"
          >
            More
          </button>
        )}
        {recommended >= 0 && form !== 'inbox' && (
          <span className="ml-auto pr-2 text-[13px] text-text-tertiary">{recommended + 1} is recommended</span>
        )}
      </div>
    );
  } else if (item.ui === 'approve') {
    body = (
      <>
        {denying ? (
          <div className={cn('flex items-center gap-2', fieldPad)}>
            <div className="min-w-0 flex-1">
              <TextField
                value={note}
                onChange={setNote}
                onSubmit={() => answerApproval(false, note)}
                placeholder={`Reason for ${item.source.agent} (optional)`}
                onFieldFocusRequest={onFieldFocusRequest}
                autoFocus
              />
            </div>
            <button type="button" onClick={() => { setDenying(false); setNote(''); }} className="h-[30px] rounded-[10px] px-2.5 text-[12.5px] font-medium text-text-tertiary hover:text-text-primary">
              Cancel
            </button>
            <button type="button" onClick={() => answerApproval(false, note)} className="h-[30px] rounded-[10px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover">
              Deny
            </button>
          </div>
        ) : (
          <div className={cn('flex flex-wrap items-center gap-1', actionsClass)}>
            <Chip keyLabel="N" label="Deny" inbox={form === 'inbox'} onClick={() => setDenying(true)} />
            <Chip keyLabel="Y" label="Approve" shaded inbox={form === 'inbox'} onClick={() => answerApproval(true)} />
            {item.detail && (
              <button
                type="button"
                aria-expanded={showDetail}
                onClick={() => setShowDetail((shown) => !shown)}
                className="ml-auto pr-2 text-[13px] text-text-tertiary hover:text-text-primary"
              >
                {showDetail ? 'Hide details' : item.detailLabel?.trim() || 'Show details'}
              </button>
            )}
          </div>
        )}
        {item.detail && showDetail && (
          <pre className={cn('mb-3.5 max-h-48 overflow-auto rounded-xl bg-surface-tertiary px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-text-secondary', form === 'inbox' ? 'mx-3.5' : 'mx-[22px]')}>
            {item.detail}
          </pre>
        )}
      </>
    );
  } else if (item.ui === 'ask') {
    const suggestions = item.suggestions ?? [];
    body = (
      <>
        {suggestions.length > 0 && (
          <div className={cn('flex flex-wrap items-center gap-1', form === 'inbox' ? 'px-2 pt-2.5' : 'px-3.5 pt-3')}>
            {suggestions.map((suggestion, index) => (
              <Chip key={suggestion} keyLabel={String(index + 1)} label={suggestion} inbox={form === 'inbox'} onClick={() => {
                // A suggestion is a starting point: it fills the field, and Send or ↵ answers.
                setText(suggestion);
                setTextFocusKey((key) => key + 1);
              }} />
            ))}
          </div>
        )}
        <div className={suggestions.length > 0 ? cn(fieldPad, 'pt-2') : fieldPad}>
          <TextField
            value={text}
            onChange={setText}
            onSubmit={() => answerText(text)}
            placeholder={form === 'strip' ? 'Click to type your answer' : 'Type your answer'}
            onFieldFocusRequest={onFieldFocusRequest}
            sendLabel={`Send to ${item.source.agent}`}
            focusKey={textFocusKey}
          />
        </div>
      </>
    );
  }

  const queued = queue && queue.total > 1 ? queue : undefined;
  let footer: ReactNode = null;
  if (form !== 'inbox' && item.ui === 'options' && expanded) {
    footer = (
      <CardFooter
        left={<span>Click a choice, then Send</span>}
        right={(
          <>
            <FooterLink onClick={() => setExpanded(false)}>Hide details</FooterLink>
            {openInPane && !narrow && <FooterLink onClick={openInPane}>Open in Pane</FooterLink>}
            <button
              type="button"
              disabled={selected < 0}
              onClick={() => answerChoice(selected, note)}
              className="h-[30px] rounded-[10px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50"
            >
              Send
            </button>
          </>
        )}
      />
    );
  } else if (form !== 'inbox' && (item.ui === 'options' || queued || shortcutHint)) {
    const left = queued ? (
      <>
        <QueueSegments queue={queued} />
        {queued.next && <span className="min-w-0 truncate">Next: {queued.next.title} · {queued.next.source.name}</span>}
      </>
    ) : shortcutHint ? (
      <span className="min-w-0 truncate">Click to answer · <ShortcutCap>{shortcutHint}</ShortcutCap> to use keys</span>
    ) : null;
    footer = (
      <CardFooter
        left={left}
        right={(
          <>
            {item.ui === 'options' && <FooterLink onClick={() => setExpanded(true)}>Details</FooterLink>}
            {openInPane && !(narrow && item.ui === 'options') && <FooterLink onClick={openInPane}>Open in Pane</FooterLink>}
          </>
        )}
      />
    );
  }

  return (
    <div className={cardShell(form, narrow, className)} data-testid="notify-card" data-notify-ui={item.ui}>
      <CardHeader item={item} form={form} queue={queue} onCommand={onCommand} menuPlacement={menuPlacement} />
      <div className={cn(titleClass, !(expanded || showDetail) && 'line-clamp-3')} title={item.title}>{item.title}</div>
      {showContext && <div className={contextClass}>{item.context}</div>}
      {body}
      {form === 'inbox' && item.source.paneId && (
        <div className="flex justify-end px-3.5 pb-3 text-[12.5px] text-text-tertiary">
          <FooterLink onClick={() => onCommand({ type: 'open-in-pane', id: item.id })}>
            <ExternalLink className="h-3.5 w-3.5" /> Open in Pane
          </FooterLink>
        </div>
      )}
      {footer}
    </div>
  );
}

function CardFooter({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 border-t border-border-secondary px-[22px] py-3 text-[13px] text-text-tertiary">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{left}</div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}

// --- Sent, expired and the update line ---

function SentLine({ item, onCommand }: NotifyCardProps) {
  return (
    <div className="flex w-max min-w-[360px] max-w-[560px] items-center gap-2 rounded-[24px] bg-surface-primary py-3 pl-4 pr-3.5 text-[13px] text-text-tertiary shadow-modal ring-1 ring-border-secondary" data-testid="notify-card" data-notify-view="sent">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status-success text-text-on-status-success" aria-hidden="true">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className="shrink-0 text-[14px] font-semibold text-text-primary">Sent to {item.source.agent}</span>
      {item.answerSummary && <span className="min-w-0 truncate">· {item.answerSummary}</span>}
      <button
        type="button"
        onClick={() => onCommand({ type: 'undo', id: item.id })}
        className="ml-auto h-[30px] shrink-0 rounded-[10px] px-2.5 text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      >
        Undo
      </button>
    </div>
  );
}

function ExpiredCard({ item, form, narrow, onCommand, menuPlacement, className }: NotifyCardProps) {
  return (
    <div className={cardShell(form, narrow, className)} data-testid="notify-card" data-notify-view="expired">
      <CardHeader item={item} form={form === 'inbox' ? 'strip' : form} onCommand={onCommand} menuPlacement={menuPlacement} />
      <div className="line-clamp-3 px-[22px] pt-1.5 text-[18px] font-semibold leading-[1.35] tracking-[-0.015em] text-text-tertiary">{item.title}</div>
      <div className="px-[22px] pb-[18px] pt-3">
        <div className="flex items-center gap-2 rounded-[9px] bg-surface-tertiary px-3 py-2.5 text-[13px] text-text-secondary">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {item.source.agent} stopped waiting. Nothing to answer.
        </div>
      </div>
    </div>
  );
}

/** The countdown line under an update: runs to hideAt, holds still while hideAt is null. */
function Countdown({ hideAt, hideAfterMs }: { hideAt: number | null; hideAfterMs: number }) {
  const heldFraction = useRef(1);
  const remaining = hideAt === null ? 0 : Math.max(0, hideAt - Date.now());
  const fraction = hideAt === null ? heldFraction.current : Math.min(1, remaining / hideAfterMs);
  useEffect(() => {
    if (hideAt === null) return;
    // Remember where the line will be if a hover holds it.
    const timer = window.setInterval(() => {
      heldFraction.current = Math.min(1, Math.max(0, hideAt - Date.now()) / hideAfterMs);
    }, 100);
    return () => window.clearInterval(timer);
  }, [hideAt, hideAfterMs]);
  return (
    <div className="h-0.5 overflow-hidden rounded-b-[24px]" aria-hidden="true">
      <i
        key={hideAt ?? 'held'}
        className="block h-0.5 w-full origin-left bg-border-hover"
        style={hideAt === null
          ? { transform: `scaleX(${fraction})` }
          : { transform: `scaleX(${fraction})`, animation: `pane-notify-countdown ${remaining}ms linear forwards` }}
      />
    </div>
  );
}

function InfoLine({ item, onCommand, hideAt = null, hideAfterMs = 6000, onOpenUrl }: NotifyCardProps) {
  const action = item.action;
  return (
    <div
      className="w-max min-w-[360px] max-w-[560px] overflow-hidden rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary"
      data-testid="notify-card"
      data-notify-view="info"
      onMouseEnter={() => onCommand({ type: 'hover-info', id: item.id, hovering: true })}
      onMouseLeave={() => onCommand({ type: 'hover-info', id: item.id, hovering: false })}
    >
      <div className="flex items-center gap-2 py-3 pl-4 pr-3.5 text-[13px] text-text-tertiary">
        <KindLabel ui="info" />
        <span className="min-w-0 truncate text-[14px] font-semibold text-text-primary">{item.title}</span>
        <span className="shrink-0">· {item.source.name}</span>
        {action && (
          <button
            type="button"
            onClick={() => onOpenUrl?.(action.url)}
            className="ml-auto h-[30px] shrink-0 rounded-[10px] bg-surface-tertiary px-2.5 text-[12.5px] font-medium text-text-primary hover:bg-surface-hover"
          >
            {action.label}
          </button>
        )}
      </div>
      <Countdown hideAt={hideAt} hideAfterMs={hideAfterMs} />
    </div>
  );
}
