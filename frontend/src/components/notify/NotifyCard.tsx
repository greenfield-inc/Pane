import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { ArrowUp, Bell, Check, Clock, ExternalLink, Info, ShieldCheck, X } from 'lucide-react';
import type { NotifyChoice, NotifyCommand, NotifyItem, NotifyRemindAfter } from '../../../../shared/types/notify';
import { showActionError } from '../../stores/errorStore';
import { canClose, canCopyAnswer, canOverride, canReopen, decisionLine, originLine, receiptLine } from '../../../../shared/approvalReceipts';
import { cn } from '../../utils/cn';
import { askedBy, NOTIFY_KIND_DOT, NOTIFY_KIND_LABEL, relativeAge, SECRET_KEPT_OUT, secretSavesAs, unreachableText } from './notifyFormat';
import { useNow } from './useNow';
import { SecretValueInput } from '../ui/SecretValueInput';
import { ClampedText } from './ClampedText';

/** The compact strip shows this many choices, then More. */
const COMPACT_CHOICE_LIMIT = 4;

export interface NotifyQueuePosition {
  /** 1-based place of this question in the queue. */
  index: number;
  total: number;
  next?: NotifyItem;
}

type NotifyCardView = 'question' | 'sent' | 'expired' | 'answered' | 'info';

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
  /** Strip: open with details shown. Showing or hiding them sends `show-details`. */
  showDetails?: boolean;
  /** Top right: a narrower strip whose chips wrap. */
  narrow?: boolean;
  /** Which side of the card the "Answer later" menu opens on. */
  menuPlacement?: 'above' | 'below';
  /** The floating strip can't take key focus until asked; called before a field focuses. */
  onFieldFocusRequest?: () => Promise<void>;
  /** Opens an update's link. */
  onOpenUrl?: (url: string) => void;
  /** Inbox: the asking machine's mark, shown before its name. */
  machineMark?: ReactNode;
  /** Approvals: the card's related links, shown under its context. */
  related?: ReactNode;
  /** Approvals: what Open in Pane does there (the card already sits in Pane). */
  onOpenInPane?: () => void;
  className?: string;
}

/** One card for every Notify surface: four looks, plus sent, expired, answered and the update line. */
export function NotifyCard(props: NotifyCardProps) {
  switch (props.view) {
    case 'sent':
      return <SentLine {...props} />;
    case 'info':
      return <InfoLine {...props} />;
    case 'expired':
      return <ExpiredCard {...props} />;
    case 'answered':
      return <AnsweredCard key={props.item.id} {...props} />;
    case 'question':
      // The agent stopped waiting on Pane; its terminal still asks, and answering there clears this.
      if (props.item.agentPrompt?.inTerminal) return <InTerminalCard {...props} />;
      return <QuestionCard key={props.item.id} {...props} />;
  }
}

// --- Shared pieces ---

function cardShell(form: NotifyCardForm, narrow?: boolean, className?: string): string {
  if (form === 'inbox') return cn('relative w-full rounded-[18px] bg-surface-primary shadow-card ring-1 ring-border-secondary', className);
  if (form === 'docked') return cn('relative w-full rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary', className);
  return cn('relative rounded-[24px] bg-surface-primary shadow-modal ring-1 ring-border-secondary', narrow ? 'w-[504px]' : 'w-[768px]', className);
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
      · {askedBy(item)} · {relativeAge(item.createdAt, now)}
    </span>
  );
}

const LATER_OPTIONS: Array<{ after: NotifyRemindAfter; label: string; icon: typeof Clock }> = [
  { after: '10m', label: 'In 10 minutes', icon: Clock },
  { after: '1h', label: 'In 1 hour', icon: Clock },
  { after: 'pane', label: 'When I switch to Pane', icon: Bell },
];

const SNOOZE_OPTIONS: Array<{ after: NotifyRemindAfter; label: string }> = [
  { after: '3m', label: '3 minutes' },
  { after: '5m', label: '5 minutes' },
  { after: '15m', label: '15 minutes' },
];

const LONG_PRESS_MS = 500;

/** Closes an open card menu on a click outside it or Escape. */
function useMenuDismiss(menuOpen: boolean, setMenuOpen: (open: boolean) => void, rootRef: RefObject<HTMLDivElement | null>) {
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
  }, [menuOpen, setMenuOpen, rootRef]);
}

function CardMenu({ label, placement, children }: { label: string; placement: 'above' | 'below'; children: ReactNode }) {
  return (
    <div
      role="menu"
      aria-label={label}
      data-notify-menu=""
      className={cn(
        'absolute right-0 z-20 w-[250px] rounded-2xl bg-surface-primary p-1.5 text-[13px] text-text-primary shadow-modal ring-1 ring-border-secondary',
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
      )}
    >
      <div className="px-2.5 pb-0.5 pt-1.5 text-[11.5px] text-text-tertiary">{label}</div>
      {children}
    </div>
  );
}

function CardMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-[9px] px-2.5 py-[7px] text-left hover:bg-surface-hover" onClick={onClick}>
      {children}
    </button>
  );
}

function KeepsWaiting({ item }: { item: NotifyItem }) {
  return (
    <>
      <div className="mx-1.5 my-1 h-px bg-border-secondary" />
      <div className="px-2.5 py-[7px] text-text-tertiary">{item.source.agent} keeps waiting meanwhile</div>
    </>
  );
}

/** ✕ hides the question; right-click or a long press offers a reminder instead. */
function CloseButton({ item, onCommand, menuPlacement = 'above' }: Pick<NotifyCardProps, 'item' | 'onCommand' | 'menuPlacement'>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const openedByPress = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(menuOpen, setMenuOpen, rootRef);

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
        <CardMenu label="Answer later" placement={menuPlacement}>
          {LATER_OPTIONS.map(({ after, label, icon: Icon }) => (
            <CardMenuItem
              key={after}
              onClick={() => {
                setMenuOpen(false);
                onCommand({ type: 'remind', id: item.id, after });
              }}
            >
              <Icon className="h-3.5 w-3.5 text-text-secondary" />
              {label}
            </CardMenuItem>
          ))}
          <KeepsWaiting item={item} />
        </CardMenu>
      )}
    </div>
  );
}

/** The footer's clock: hides the question for a few minutes, then it comes back in its place. */
function SnoozeButton({ item, onCommand, menuPlacement = 'above' }: Pick<NotifyCardProps, 'item' | 'onCommand' | 'menuPlacement'>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(menuOpen, setMenuOpen, rootRef);
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Snooze"
        title="Snooze"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      >
        <Clock className="h-4 w-4" />
      </button>
      {menuOpen && (
        <CardMenu label="Snooze" placement={menuPlacement}>
          {SNOOZE_OPTIONS.map(({ after, label }) => (
            <CardMenuItem
              key={after}
              onClick={() => {
                setMenuOpen(false);
                onCommand({ type: 'remind', id: item.id, after });
              }}
            >
              {label}
            </CardMenuItem>
          ))}
          <KeepsWaiting item={item} />
        </CardMenu>
      )}
    </div>
  );
}

/** "Back at 3:42 PM": when a snoozed question returns to the strip. */
function snoozedLabel(until: number): string {
  return `Back at ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function CardHeader({ item, form, queue, onCommand, menuPlacement, machineMark }: Pick<NotifyCardProps, 'item' | 'form' | 'queue' | 'onCommand' | 'menuPlacement' | 'machineMark'>) {
  const now = useNow();
  if (form === 'inbox') {
    return (
      <div className="flex items-center gap-2 px-3.5 pt-3 text-[12px] text-text-tertiary">
        <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-text-primary text-[10px] font-bold text-bg-primary" aria-hidden="true">P</span>
        {/* The origin line, with the machine apart so it keeps its mark. */}
        <span className="truncate font-medium text-text-secondary" data-testid="notify-card-origin">{originLine(item, '')}</span>
        {item.machine && (
          <span className="inline-flex min-w-0 shrink items-center gap-1" data-testid="notify-card-machine">
            · {machineMark}<span className="truncate">{item.machine}</span>
          </span>
        )}
        {/* The same time as the item's row in the list: when it ended, else when it was asked. */}
        <span className="ml-auto shrink-0">{relativeAge(item.resolvedAt ?? item.createdAt, now)}</span>
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
  /** A secret: a password field that keeps a pasted value's line breaks. */
  masked?: boolean;
}

function TextField({ value, onChange, onSubmit, placeholder, onFieldFocusRequest, autoFocus, sendLabel, focusKey = 0, masked }: TextFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const field = () => inputRef.current ?? secretRef.current;
  useEffect(() => {
    if (autoFocus || focusKey > 0) focusAfterRequest(field(), onFieldFocusRequest);
    // Focus when the field appears (autoFocus) and whenever focusKey asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  const hasText = value.trim().length > 0;
  const fieldProps = {
    value,
    placeholder,
    'aria-label': placeholder,
    className: 'h-full min-w-0 flex-1 bg-transparent text-[14.5px] text-text-primary outline-none placeholder:text-text-muted',
    onMouseDown: (event: ReactMouseEvent) => {
      if (!onFieldFocusRequest || document.activeElement === field()) return;
      // The floating strip can't take keys yet: ask for focus first, then focus the field.
      event.preventDefault();
      focusAfterRequest(field(), onFieldFocusRequest);
    },
  };
  return (
    <div className="flex h-[42px] items-center gap-2 rounded-xl bg-surface-tertiary pl-3.5 pr-2 focus-within:ring-[1.5px] focus-within:ring-inset focus-within:ring-border-hover">
      {masked ? (
        <SecretValueInput
          ref={secretRef}
          appearance="bare"
          {...fieldProps}
          onValueChange={onChange}
          onEnter={onSubmit}
        />
      ) : (
        <input
          ref={inputRef}
          {...fieldProps}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
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
      title={tall ? undefined : label}
      className={cn(
        'inline-flex min-w-0 max-w-full rounded-xl text-left text-text-secondary hover:bg-surface-hover',
        tall ? 'items-start gap-2.5 px-3.5 py-3' : 'h-[42px] items-center gap-2.5 whitespace-nowrap pl-3 pr-4',
        inbox ? 'text-[14.5px]' : 'text-[15px]',
        shaded && 'bg-surface-tertiary font-medium text-text-primary hover:bg-surface-tertiary',
      )}
    >
      <KeyCap className={tall ? 'mt-px' : undefined}>{keyLabel}</KeyCap>
      {tall ? (
        <span className="min-w-0">
          <span className="block [overflow-wrap:anywhere]">{label}</span>
          {detail && <span className="block text-[12px] font-normal leading-snug text-text-tertiary">{detail}</span>}
        </span>
      ) : <span className="min-w-0 truncate">{label}</span>}
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

/**
 * Keys for the card the person is acting on: the pointer is over it, or (the floating strip) it
 * was clicked and its window has the keyboard. Runs before the page's own handlers, such as a
 * terminal's, and ignores keys typed into the card's fields and chords with modifiers.
 */
function useCardKeys(rootRef: RefObject<HTMLDivElement | null>, floating: boolean, onKey: (key: string) => boolean): void {
  const handler = useRef(onKey);
  useEffect(() => {
    handler.current = onKey;
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Only a pointer moved onto the card counts: a card that appears under a resting pointer
    // must not catch what the person is typing elsewhere.
    let hovering = false;
    // The floating strip: clicked, and its window still has the keyboard.
    let clicked = false;
    const enter = () => { hovering = true; };
    const leave = () => { hovering = false; };
    const press = () => { clicked = floating; };
    const blur = () => { clicked = false; };
    const keydown = (event: KeyboardEvent) => {
      if (!hovering && !clicked) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLElement && root.contains(target) && target.closest('input, textarea')) return;
      if (!handler.current(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    root.addEventListener('pointermove', enter);
    root.addEventListener('pointerleave', leave);
    root.addEventListener('pointerdown', press);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', keydown, true);
    return () => {
      root.removeEventListener('pointermove', enter);
      root.removeEventListener('pointerleave', leave);
      root.removeEventListener('pointerdown', press);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', keydown, true);
    };
  }, [rootRef, floating]);
}

function recommendedIndex(choices: NotifyChoice[]): number {
  return choices.findIndex((choice) => choice.recommended);
}

function QuestionCard({
  item, form, queue, shortcutHint, showDetails, narrow, menuPlacement, onCommand, onFieldFocusRequest, machineMark, related, onOpenInPane, className, onCancelOverride,
}: NotifyCardProps & { onCancelOverride?: () => void }) {
  // Details: the choices with notes, or an approval's detail.
  const [expanded, setExpanded] = useState(form === 'docked' || (form === 'strip' && Boolean(showDetails)));
  const choices = item.choices ?? [];
  const [selected, setSelected] = useState(() => recommendedIndex(choices));
  const [note, setNote] = useState('');
  const [denying, setDenying] = useState(false);
  const [text, setText] = useState('');
  const [textFocusKey, setTextFocusKey] = useState(0);
  const [closing, setClosing] = useState(false);
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
  // A secret is sent as typed, and leaves this card's state at once.
  const saveSecret = () => {
    if (!text) return;
    onCommand({ type: 'answer', id: item.id, answer: { text } });
    setText('');
  };
  const showDetailsChange = (shown: boolean) => {
    setExpanded(shown);
    if (form === 'strip') onCommand({ type: 'show-details', shown });
  };
  const rootRef = useRef<HTMLDivElement>(null);
  // The card's own keys, matching the key on each chip.
  useCardKeys(rootRef, Boolean(onFieldFocusRequest), (key) => {
    const index = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    if (item.ui === 'options') {
      if (index >= 0 && index < (expanded || onCancelOverride ? choices.length : Math.min(choices.length, COMPACT_CHOICE_LIMIT))) {
        if (expanded) setSelected(index);
        else answerChoice(index);
        return true;
      }
      if (key === 'Enter' && expanded && selected >= 0) {
        answerChoice(selected, note);
        return true;
      }
      return false;
    }
    if (item.ui === 'approve' && !denying) {
      if (key.toLowerCase() === 'y') answerApproval(true);
      else if (key.toLowerCase() === 'n') setDenying(true);
      else return false;
      return true;
    }
    if (item.ui === 'ask') {
      const suggestion = index >= 0 ? item.suggestions?.[index] : undefined;
      if (suggestion === undefined && key.length !== 1) return false;
      // A suggestion fills the field, as a click does; any other character starts the answer.
      setText((current) => suggestion ?? current + key);
      setTextFocusKey((focusKey) => focusKey + 1);
      return true;
    }
    return false;
  });
  // Autopilot's own items live in its hidden owner Pane; only a surface that knows where Autopilot is offers to open it.
  const openInPane = item.source.paneId && !item.elsewhere && !item.source.autopilot && form === 'strip'
    ? () => onCommand({ type: 'open-in-pane', id: item.id })
    : undefined;

  const showContext = Boolean(item.context) && (expanded || item.ui === 'approve' || item.ui === 'secret' || form === 'inbox');
  const recommended = recommendedIndex(choices);

  let body: ReactNode = null;
  if (item.ui === 'options' && expanded) {
    body = (
      <>
        <div className={cn('grid gap-x-3 gap-y-2.5 px-3.5 pb-4 pt-3', narrow ? 'grid-cols-2' : 'grid-cols-3')}>
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
    // An Override can't open the round (the item no longer waits), so every choice shows.
    const visible = onCancelOverride ? choices : choices.slice(0, COMPACT_CHOICE_LIMIT);
    body = (
      <div className={cn('flex flex-wrap items-center gap-2', actionsClass)}>
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
        {choices.length > visible.length && (
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
          <div className={cn('flex flex-wrap items-center gap-2', actionsClass)}>
            <Chip keyLabel="N" label="Deny" inbox={form === 'inbox'} onClick={() => setDenying(true)} />
            <Chip keyLabel="Y" label="Approve" shaded inbox={form === 'inbox'} onClick={() => answerApproval(true)} />
            {item.detail && (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => showDetailsChange(!expanded)}
                className="ml-auto pr-2 text-[13px] text-text-tertiary hover:text-text-primary"
              >
                {expanded ? 'Hide details' : item.detailLabel?.trim() || 'Show details'}
              </button>
            )}
          </div>
        )}
        {item.detail && expanded && (
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
          <div className={cn('flex flex-wrap items-center gap-2', form === 'inbox' ? 'px-2 pt-2.5' : 'px-3.5 pt-3')}>
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
  } else if (item.ui === 'secret') {
    body = (
      <div className={cn(fieldPad, 'space-y-2.5')}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              masked
              value={text}
              onChange={setText}
              onSubmit={saveSecret}
              placeholder={form === 'strip' ? 'Click to type the secret' : 'Type the secret'}
              onFieldFocusRequest={onFieldFocusRequest}
            />
          </div>
          <button
            type="button"
            disabled={!text}
            onClick={saveSecret}
            className="h-[42px] shrink-0 rounded-xl bg-interactive px-4 text-[14px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50"
          >
            Save securely
          </button>
        </div>
        {/* A failed save swaps in for the destination line, in the same one-line box. */}
        {item.secretError ? (
          <div className="h-[18px] truncate text-[12.5px] leading-[18px] text-status-error" role="alert" title={item.secretError} data-testid="notify-secret-error">{item.secretError}</div>
        ) : (
          <div className="h-[18px] truncate text-[12.5px] leading-[18px] text-text-tertiary" title={secretSavesAs(item)} data-testid="notify-secret-target">{secretSavesAs(item)}</div>
        )}
        <div className="flex items-center gap-2 text-[12.5px] text-text-tertiary">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{SECRET_KEPT_OUT}</span>
          <button
            type="button"
            onClick={() => { setText(''); answerApproval(false); }}
            className="h-[30px] shrink-0 rounded-[10px] px-2.5 text-[12.5px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  const queued = queue && queue.total > 1 ? queue : undefined;
  // Snooze hides a card from the strip, so a card docked in its terminal has none.
  const snooze = form === 'docked' ? null : <SnoozeButton item={item} onCommand={onCommand} menuPlacement={menuPlacement} />;
  let footer: ReactNode = null;
  if (form !== 'inbox' && item.ui === 'options' && expanded) {
    footer = (
      <CardFooter
        left={<span>Click a choice, then Send</span>}
        right={(
          <>
            <FooterLink onClick={() => showDetailsChange(false)}>Hide details</FooterLink>
            {openInPane && !narrow && <FooterLink onClick={openInPane}>Open in Pane</FooterLink>}
            <button
              type="button"
              disabled={selected < 0}
              onClick={() => answerChoice(selected, note)}
              className="h-[30px] rounded-[10px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50"
            >
              Send
            </button>
            {snooze}
          </>
        )}
      />
    );
  } else if (form === 'strip' || (form === 'docked' && (item.ui === 'options' || queued || shortcutHint))) {
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
            {item.ui === 'options' && <FooterLink onClick={() => showDetailsChange(true)}>Details</FooterLink>}
            {openInPane && !(narrow && item.ui === 'options') && <FooterLink onClick={openInPane}>Open in Pane</FooterLink>}
            {snooze}
          </>
        )}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={cardShell(form, narrow, className)}
      data-testid="notify-card"
      data-notify-ui={item.ui}
      // The floating strip takes the keyboard only when clicked, so typing elsewhere never answers it.
      onPointerDown={() => void onFieldFocusRequest?.()}
    >
      <CardHeader item={item} form={form} queue={queue} onCommand={onCommand} menuPlacement={menuPlacement} machineMark={machineMark} />
      <div className={cn(titleClass, !expanded && 'line-clamp-3')} title={item.title}>{item.title}</div>
      {/* An agent prompt's context is a command or a plan: its line breaks carry meaning. */}
      {/* An agent prompt's context is a command or plan to read whole; any other is clamped with Show more. */}
      {showContext && item.context && (item.agentPrompt
        ? <div className={cn(contextClass, 'max-h-[40vh] overflow-y-auto whitespace-pre-line')}>{item.context}</div>
        : <ClampedText text={item.context} className={contextClass} testId="notify-card-context" />)}
      {form === 'inbox' && (onCancelOverride
        ? <div className={contextClass} data-testid="notify-override-hint">Your answer goes to {item.source.agent} as a correction.</div>
        : <ReceiptLines item={item} className={contextClass} />)}
      {related}
      {body}
      {item.unreachable && <UnreachableNotice item={item} className={form === 'inbox' ? 'px-3.5 pb-3' : 'px-[22px] pb-3'} />}
      {form === 'inbox' && (onCancelOverride ? (
        <div className="flex items-center justify-end px-3.5 pb-3 text-[12.5px] text-text-tertiary">
          <FooterLink onClick={onCancelOverride}>Cancel</FooterLink>
        </div>
      ) : closing ? (
        <ItemCloseForm item={item} onCommand={onCommand} onCancel={() => setClosing(false)} className="px-3.5 pb-3.5" />
      ) : (
        <div className="flex items-center gap-3 px-3.5 pb-3 text-[12.5px] text-text-tertiary">
          {item.snoozedUntil !== undefined && <span className="min-w-0 truncate">{snoozedLabel(item.snoozedUntil)}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {item.source.paneId && !item.elsewhere && (!item.source.autopilot || onOpenInPane) && (
              <FooterLink onClick={onOpenInPane ?? (() => onCommand({ type: 'open-in-pane', id: item.id }))}>
                <ExternalLink className="h-3.5 w-3.5" /> Open in Pane
              </FooterLink>
            )}
            {canClose(item) && !item.unreachable && (
              <button type="button" onClick={() => setClosing(true)} data-testid="notify-close" title={`Close this: ${item.source.agent} is told`} className="whitespace-nowrap hover:text-text-primary">
                Close
              </button>
            )}
            {snooze}
          </div>
        </div>
      ))}
      {footer}
    </div>
  );
}

/** What happened to an item so far: its receipt and the decision it was recorded as. */
function ReceiptLines({ item, className }: { item: NotifyItem; className?: string }) {
  const lines = [receiptLine(item), decisionLine(item)].filter(Boolean);
  if (lines.length === 0) return null;
  return <div className={className} data-testid="notify-receipt">{lines.join(' · ')}</div>;
}

/** Close: an optional reason, then the item ends and its asker is told. Laid out as Deny's reason is. */
export function ItemCloseForm({ item, onCommand, onCancel, className }: { item: NotifyItem; onCommand: (command: NotifyCommand) => void; onCancel: () => void; className?: string }) {
  const [reason, setReason] = useState('');
  const close = () => {
    const trimmed = reason.trim();
    onCommand(trimmed ? { type: 'close', id: item.id, reason: trimmed } : { type: 'close', id: item.id });
  };
  return (
    <div className={cn('flex items-center gap-2', className)} data-testid="notify-close-form">
      <div className="min-w-0 flex-1">
        <TextField value={reason} onChange={setReason} onSubmit={close} placeholder="Reason (optional)" autoFocus />
      </div>
      <button type="button" onClick={onCancel} className="h-[30px] rounded-[10px] px-2.5 text-[12.5px] font-medium text-text-tertiary hover:text-text-primary">
        Cancel
      </button>
      <button type="button" onClick={close} className="h-[30px] rounded-[10px] bg-interactive px-3 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover">
        Close
      </button>
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
      <span className="shrink-0 text-[14px] font-semibold text-text-primary">{item.answeredOn ? `Answered on ${item.answeredOn}` : `Sent to ${item.source.agent}`}</span>
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

/** One line of status inside a card, in place of its answers. */
function NoticePill({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[9px] bg-surface-tertiary px-3 py-2.5 text-[13px] text-text-secondary" data-testid={testId}>
      <Info className="h-3.5 w-3.5 shrink-0" />
      {children}
    </div>
  );
}

/** The host that asked is out of reach: an answer now would not be sent. */
export function UnreachableNotice({ item, className }: { item: NotifyItem; className?: string }) {
  return (
    <div className={className}>
      <NoticePill testId="notify-unreachable">{unreachableText(item)}</NoticePill>
    </div>
  );
}

function InTerminalCard({ item, form, queue, narrow, onCommand, menuPlacement, machineMark, className }: NotifyCardProps) {
  const inbox = form === 'inbox';
  return (
    <div className={cardShell(form, narrow, className)} data-testid="notify-card" data-notify-ui={item.ui} data-notify-view="in-terminal">
      <CardHeader item={item} form={form} queue={queue} onCommand={onCommand} menuPlacement={menuPlacement} machineMark={machineMark} />
      <div
        className={cn(inbox ? 'px-3.5 pt-1 text-[14.5px] font-semibold leading-snug' : 'px-[22px] pt-1.5 text-[18px] font-semibold leading-[1.35] tracking-[-0.015em]', 'line-clamp-3 text-text-primary')}
        title={item.title}
      >
        {item.title}
      </div>
      <div className={inbox ? 'px-3.5 pb-3.5 pt-3' : 'px-[22px] pb-[18px] pt-3'}>
        <NoticePill testId="notify-in-terminal">
          <span className="min-w-0 flex-1">{item.source.agent} is asking in the terminal now.</span>
          {item.source.paneId && !item.elsewhere && (
            <FooterLink onClick={() => onCommand({ type: 'open-in-pane', id: item.id })}>Open</FooterLink>
          )}
        </NoticePill>
      </div>
    </div>
  );
}

function ExpiredCard({ item, form, narrow, onCommand, menuPlacement, machineMark, related, className }: NotifyCardProps) {
  const reopen = form === 'inbox' && canReopen(item) && !item.unreachable;
  return (
    <div className={cardShell(form, narrow, className)} data-testid="notify-card" data-notify-view="expired">
      <CardHeader item={item} form={form} onCommand={onCommand} menuPlacement={menuPlacement} machineMark={machineMark} />
      {/* On Approvals, the same type and inset as the answered and waiting cards beside it. */}
      <div className={form === 'inbox' ? 'line-clamp-3 px-3.5 pt-1 text-[14.5px] font-semibold leading-snug text-text-tertiary' : 'line-clamp-3 px-[22px] pt-1.5 text-[18px] font-semibold leading-[1.35] tracking-[-0.015em] text-text-tertiary'}>{item.title}</div>
      <div className={form === 'inbox' ? 'px-3.5 pb-3 pt-2.5' : 'px-[22px] pb-[18px] pt-3'}>
        <NoticePill testId="notify-receipt">{receiptLine(item) ?? `${item.source.agent} stopped waiting. Nothing to answer.`}</NoticePill>
      </div>
      {related}
      {reopen && (
        <div className="flex items-center justify-end px-3.5 pb-3 text-[12.5px] text-text-tertiary">
          <FooterLink onClick={() => onCommand({ type: 'reopen', id: item.id })}>Reopen</FooterLink>
        </div>
      )}
    </div>
  );
}

/** An item already answered, opened on Approvals: its receipt, and an Override with the card's own answers. */
function AnsweredCard(props: NotifyCardProps) {
  const { item, form, narrow, onCommand, menuPlacement, machineMark, related, className } = props;
  const [overriding, setOverriding] = useState(false);
  const [copied, setCopied] = useState(false);
  if (overriding) {
    return (
      <QuestionCard
        {...props}
        view="question"
        // The same controls as when it waited: what they answer goes out as a correction.
        item={{ ...item, state: 'waiting' }}
        onCommand={(command) => {
          if (command.type !== 'answer') return;
          setOverriding(false);
          onCommand({ type: 'override', id: item.id, answer: command.answer });
        }}
        onCancelOverride={() => setOverriding(false)}
      />
    );
  }
  const correction = item.corrections?.at(-1);
  return (
    <div className={cardShell(form, narrow, className)} data-testid="notify-card" data-notify-view="answered">
      <CardHeader item={item} form={form} onCommand={onCommand} menuPlacement={menuPlacement} machineMark={machineMark} />
      <div className="px-3.5 pt-1 text-[14.5px] font-semibold leading-snug text-text-tertiary">{item.title}</div>
      <div className="px-3.5 pb-3 pt-2.5">
        <NoticePill testId="notify-receipt">
          <span className="min-w-0">
            {[item.answerSummary, receiptLine(item) ?? (item.answeredOn ? `Answered on ${item.answeredOn}` : 'Answered'), decisionLine(item)].filter(Boolean).join(' · ')}
            {correction && <span className="block" data-testid="notify-correction">You corrected it: {correction.summary}</span>}
          </span>
        </NoticePill>
      </div>
      {related}
      {((canOverride(item) && !item.unreachable) || canCopyAnswer(item)) && (
        <div className="flex items-center justify-end gap-4 px-3.5 pb-3 text-[12.5px] text-text-tertiary">
          {canCopyAnswer(item) && (
            <FooterLink onClick={() => {
              void navigator.clipboard.writeText(item.answerSummary ?? '').then(() => setCopied(true)).catch(cause => showActionError('Could not copy the answer', cause));
            }}>
              {/* One box for both labels, so Copied doesn't shift Override. */}
              <span className="inline-block w-[5.5rem] text-right">{copied ? 'Copied' : 'Copy answer'}</span>
            </FooterLink>
          )}
          {canOverride(item) && !item.unreachable && <FooterLink onClick={() => setOverriding(true)}>Override</FooterLink>}
        </div>
      )}
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
