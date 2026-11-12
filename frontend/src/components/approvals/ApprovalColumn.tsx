import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, CircleAlert, FileText, GitPullRequest, Globe, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import type { NotifyAnswer, NotifyItem, NotifyLink } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { cn } from '../../utils/cn';
import { runNotify, sendNotify, useNotifyStore } from '../../stores/notifyStore';
import { leadingQn } from '../../../../shared/autopilotDecision';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { useApprovalColumnStore, type ApprovalSurface } from '../../stores/approvalColumnStore';
import { AutopilotDocument, AutopilotWebPage } from '../autopilot/AutopilotDocument';
import { isLightTheme, useTheme } from '../../contexts/ThemeContext';
import { sentenceStart } from '../../../../shared/approvalStatus';
import { readSummaryPage, type SummaryRead } from './summaryPage';
import { ItemCloseForm, NotifyCard } from '../notify/NotifyCard';
import { relayReadOnlyLine } from './approvalGroups';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import {
  askedBy, canSend, cardChip, replyBeingRead, cardTabs, dotTone, markedQuestions, previousVersion, questionsOf, recommendedPicks, replyLine,
  type CardChip, type CardQuestion, type CardTab, type ReplyLine,
} from './approvalCard';

/**
 * The approval column (P3, D-243): one tabbed column, shared by a Session, Autopilot and the
 * Approvals screen. Decide first, with the pager and one reply box; then Summary,
 * each reference, and the chat where it was asked.
 */
export interface ApprovalColumnProps {
  surface: ApprovalSurface;
  /** The approval shown. */
  itemId: string;
  /** What the pager walks, in order. */
  order: readonly string[];
  onSelect: (itemId: string) => void;
  /** "Doozy approvals", "Approvals", "Autopilot". */
  groupLabel: string;
  /** ✕'s words ("Back to doozy-overhaul", "Close split", "Back to the Stack"); none: no ✕. */
  closeLabel?: string;
  onClose?: () => void;
  /** The panel the person is already in: its origin tab is left out. */
  inChat?: string;
  /** The chat where it was asked, for the origin tab. */
  renderOrigin?: (item: NotifyItem) => ReactNode;
  /**
   * Beside a split (a Session's column): whether keyboard focus is in it. Its active tab then
   * carries the accent only while it has focus, like a split's (D-249, D-335). Unset: always.
   */
  focused?: boolean;
  /** The items to read instead of the Notify store's (tests). */
  items?: readonly NotifyItem[];
  /** After an accepted Send (P7, D-344): a chat's column closes; the Approvals screen stays on the approval. */
  onSent?: () => void;
}

const NO_PICKS: string[] = [];


/** Below this width the header keeps the pager and ✕, and drops the group's name, the dots and the chip. */
const NARROW_PX = 520;

/** Whether the column is narrow, measured as it is, since it takes the width of what it covers. */
function useNarrow(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, narrow];
}

const TONE_TEXT = {
  muted: 'text-text-secondary',
  success: 'text-status-success-on-tint',
  warning: 'text-status-warning-on-tint',
  info: 'text-status-info-on-tint',
} satisfies Record<ReplyLine['tone'], string>;
const TONE_BOX = {
  muted: 'bg-surface-tertiary',
  success: 'bg-status-success/10',
  warning: 'bg-status-warning/10',
  info: 'bg-status-info/10',
} satisfies Record<ReplyLine['tone'], string>;

export function ApprovalColumn({ surface, itemId, order, onSelect, groupLabel, closeLabel, onClose, inChat, renderOrigin, focused, items: given, onSent }: ApprovalColumnProps) {
  const stored = useNotifyStore((state) => state.snapshot?.items);
  const items = given ?? stored;
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const open = useApprovalColumnStore((state) => state.open[surface]);
  const setTab = useApprovalColumnStore((state) => state.setTab);
  const openNested = useApprovalColumnStore((state) => state.openNested);
  const item = byId.get(itemId);
  const nested = open?.itemId === itemId && open.nested ? byId.get(open.nested) : undefined;
  const tabs = useMemo(() => (item ? cardTabs(item, inChat) : []), [item, inChat]);
  const tab = tabs.find((candidate) => candidate.key === (open?.itemId === itemId ? open.tab : 'qa')) ?? tabs[0];
  const pager = order.includes(itemId) ? order : [...order, itemId];
  const index = pager.indexOf(itemId);
  const step = (direction: 1 | -1) => {
    if (pager.length < 2) return;
    onSelect(pager[(index + direction + pager.length) % pager.length]);
  };
  const [rootRef, narrow] = useNarrow();

  if (!item) {
    return (
      // No tabs to mark: a thin accent edge along the top says it has focus.
      <div className={cn('flex min-h-0 flex-1 flex-col bg-bg-primary', focused && 'shadow-[inset_0_2px_0_0_var(--color-interactive-primary)]')} data-testid="approval-column" data-focused={focused}>
        <ColumnHeader index={0} total={0} groupLabel={groupLabel} closeLabel={closeLabel} onClose={onClose} onStep={step} dots={[]} chip={null} />
        <p className="m-auto px-6 text-center text-[13px] text-text-tertiary">That approval is no longer here: it was answered or closed.</p>
      </div>
    );
  }

  return (
    // Focusable, so its ← → keys belong to it alone; clicking anywhere in it gives it focus.
    <div ref={rootRef} role="region" aria-label={`Approval: ${item.title}`} tabIndex={-1} data-focus-entry={focused !== undefined || undefined} onKeyDown={(event) => pagerKey(event, step)} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary outline-none" data-testid="approval-column" data-item-id={item.id} data-narrow={narrow || undefined}>
      <ColumnHeader
        narrow={narrow}
        index={index}
        total={pager.length}
        groupLabel={groupLabel}
        closeLabel={closeLabel}
        onClose={onClose}
        onStep={step}
        dots={pager.map((id) => dotTone(byId.get(id), id === itemId))}
        chip={cardChip(item)}
      />
      <TabBar tabs={tabs} active={tab?.key ?? 'qa'} focused={focused} onPick={(key) => setTab(surface, itemId, key)} />
      <div className="relative min-h-0 flex-1">
        {(tab?.kind ?? 'qa') === 'qa' && (
          nested
            ? <NestedApproval item={nested} onBack={() => openNested(surface, itemId, undefined)} />
            // A new version starts afresh: its options may have changed under the picks.
            : <QuestionsTab key={`${item.id}:${item.version ?? 1}`} item={item} onSent={onSent} tabs={tabs} onOpenTab={(key) => setTab(surface, itemId, key)} />
        )}
        {tab?.kind === 'summary' && <SummaryTab key={item.id} item={item} />}
        {tab?.kind === 'link' && <LinkTab item={item} link={tab.link} onOpenApproval={(id) => openNested(surface, itemId, resolveApproval(items ?? [], id))} />}
        {tab?.kind === 'origin' && (renderOrigin?.(item) ?? <p className="p-6 text-[13px] text-text-tertiary">Asked in {item.source.name}.</p>)}
      </div>
    </div>
  );
}

/** An approval link names an id, or a Q-n read as every other Q-n is (`leadingQn`). */
function resolveApproval(items: readonly NotifyItem[], ref: string): string | undefined {
  const wanted = ref.trim();
  return items.find((candidate) => candidate.id === wanted)?.id ?? items.find((candidate) => leadingQn(candidate.title) === wanted)?.id;
}

/**
 * ← → step the pager of the column that has focus, unless the person is typing or a page has it
 * (F-9): a covered Stack or another tiled Session's column never moves.
 */
function pagerKey(event: React.KeyboardEvent, step: (direction: 1 | -1) => void): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW'].includes(target.tagName) || target.closest('[role="menu"], [role="tablist"], .xterm'))) return;
  event.preventDefault();
  event.stopPropagation();
  step(event.key === 'ArrowLeft' ? -1 : 1);
}

function Chip({ chip, testId }: { chip: NonNullable<CardChip>; testId?: string }) {
  const tone = chip.tone === 'info' ? 'bg-status-info/10 text-status-info-on-tint' : chip.tone === 'warning' ? 'bg-status-warning/10 text-status-warning-on-tint' : chip.tone === 'success' ? 'bg-status-success/10 text-status-success-on-tint' : 'bg-surface-tertiary text-text-secondary';
  const Icon = chip.tone === 'info' ? Sparkles : chip.tone === 'warning' ? Loader2 : chip.tone === 'success' ? Check : Loader2;
  return (
    <span className={cn('inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium', tone)} data-testid={testId ?? 'approval-chip'} data-tone={chip.tone}>
      <span className="flex h-3 w-3 items-center justify-center" aria-hidden="true"><Icon className="h-3 w-3" /></span>
      {chip.text}
    </span>
  );
}

export { Chip as ApprovalChip };

function ColumnHeader({ index, total, groupLabel, closeLabel, onClose, onStep, dots, chip, narrow = false }: {
  index: number; total: number; groupLabel: string; closeLabel?: string; onClose?: () => void; onStep: (direction: 1 | -1) => void;
  dots: ReturnType<typeof dotTone>[]; chip: CardChip; narrow?: boolean;
}) {
  const stepButton = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-secondary text-text-secondary hover:bg-surface-hover disabled:opacity-40';
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-primary px-3 text-[13px]" data-testid="approval-column-header">
      <button type="button" className={stepButton} aria-label="Previous approval" disabled={total < 2} onClick={() => onStep(-1)}><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
      <span className="shrink-0 font-semibold tabular-nums text-text-primary" data-testid="approval-pager">{total > 0 ? `${index + 1} of ${total}` : '0 of 0'}</span>
      <button type="button" className={stepButton} aria-label="Next approval" disabled={total < 2} onClick={() => onStep(1)}><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
      {!narrow && <span className="min-w-0 truncate text-text-tertiary">{groupLabel}</span>}
      <span className={cn('shrink-0 items-center gap-1', narrow ? 'hidden' : 'flex')} aria-hidden="true" data-testid="approval-dots">
        {dots.map((tone, at) => (
          // Fixed box: a dot swaps colour, never size.
          <span key={at} className="flex h-2 w-2 items-center justify-center" data-tone={tone}>
            <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'current' ? 'bg-text-primary' : tone === 'info' ? 'bg-status-info' : tone === 'warning' ? 'bg-status-warning' : 'bg-border-hover')} />
          </span>
        ))}
      </span>
      {/* Narrow, the Decide tab says it's ready again; the header keeps to the pager and ✕. */}
      {chip && chip.tone !== 'success' && !narrow && <Chip chip={chip} />}
      {onClose && closeLabel && (
        <button type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}
          className="ml-auto inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="approval-column-close">
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {!narrow && <span className="max-w-[220px] truncate">{closeLabel}</span>}
        </button>
      )}
    </div>
  );
}

function tabIcon(tab: CardTab) {
  if (tab.kind === 'summary') return BookOpen;
  if (tab.kind === 'origin') return MessageSquare;
  if (tab.kind === 'link') {
    if ('approval' in tab.link) return CircleAlert;
    if ('url' in tab.link) return /\/pull\/\d+/.test(tab.link.url) ? GitPullRequest : Globe;
    return FileText;
  }
  return null;
}

function TabBar({ tabs, active, focused, onPick }: { tabs: CardTab[]; active: string; focused?: boolean; onPick: (key: string) => void }) {
  return (
    // Tabs wrap onto a second row rather than scroll out of sight in a narrow column.
    <div role="tablist" aria-label="Approval" className="flex min-h-10 shrink-0 flex-wrap items-stretch border-b border-border-primary" data-testid="approval-tabs">
      {tabs.map((tab) => {
        const Icon = tabIcon(tab);
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onPick(tab.key)}
            className={cn('-mb-px inline-flex h-10 min-w-0 items-center gap-1.5 border-b-2 px-3 text-[13px]', selected ? cn('font-semibold text-text-primary', focused === false ? 'border-transparent' : 'border-interactive') : 'border-transparent text-text-secondary hover:text-text-primary')}
            data-testid="approval-tab"
            data-approval-tab
            data-focused={selected && focused !== undefined ? focused : undefined}
          >
            {tab.kind === 'qa'
              ? <span className="flex h-2 w-2 items-center justify-center" aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full bg-status-warning" /></span>
              : Icon && <Icon className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
            <span className="max-w-[180px] truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Decide: who asks, the question, how it changed, its options and the one reply box. */
function QuestionsTab({ item, onSent, tabs, onOpenTab }: { item: NotifyItem; onSent?: () => void; tabs: CardTab[]; onOpenTab: (key: string) => void }) {
  const now = useNow();
  const questions = useMemo(() => markedQuestions(item), [item]);
  // The draft lives in the store, so it survives paging away and a refused Send (F-4).
  const draftKey = `${item.id}:${item.version ?? 1}`;
  const draft = useApprovalColumnStore((state) => state.drafts[draftKey]);
  const setDraft = useApprovalColumnStore((state) => state.setDraft);
  const clearSentDraft = useApprovalColumnStore((state) => state.clearSentDraft);
  // Recommended picks start selected (D-345); the person changes any before sending.
  const preselected = useMemo(() => recommendedPicks(item), [item]);
  const picks = draft?.picks ?? (item.state === 'waiting' ? preselected : NO_PICKS);
  const text = draft?.text ?? '';
  const setPicks = (update: (current: string[]) => string[]) => setDraft(draftKey, { picks: update(picks), text });
  const setText = (value: string) => setDraft(draftKey, { picks, text: value });
  const [sending, setSending] = useState(false);
  // Paged away while Send was pending: the column already shows something else, so nothing moves it (F-15).
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => { shown.current = false; };
  }, []);
  const waiting = item.state === 'waiting';
  // What the column has no form of its own for: a secret, a prompt the terminal now holds, an update.
  const plain = item.ui === 'secret' || item.ui === 'info' || item.agentPrompt?.inTerminal || item.relay;
  // Answered or closed: its receipt, Reopen and Override are the card's own.
  const ended = item.state === 'answered' || item.state === 'expired';
  const [closing, setClosing] = useState(false);
  const line = replyLine(item);
  const send = async () => {
    const typed = text.trim();
    if (sending || !canSend(item, picks, typed)) return;
    const padded = questionsOf(item).map((_, at) => picks[at] ?? '');
    const answer: NotifyAnswer = item.agentPrompt && picks[0] ? { choice: picks[0] } : typed ? { picks: padded, text: typed } : { picks };
    setSending(true);
    let accepted = false;
    try {
      accepted = await sendNotify({ type: 'answer', id: item.id, answer });
    } finally {
      setSending(false);
    }
    // Refused (machine offline, already answered, still reading): the words and picks stay.
    if (!accepted) return;
    // Only what was sent is cleared: words or picks changed while Send was pending stay in the box (F-15).
    if (!clearSentDraft(draftKey, { picks, text })) return;
    // Send closes a chat's column; the chat's status line says who reads it (P7, D-344).
    if (shown.current) onSent?.();
  };
  const before = previousVersion(item);
  const earlier = [...item.versions ?? []].reverse();
  const [showSent, setShowSent] = useState(false);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  useGrowingBox(replyBox, text);
  const references = tabs.filter((candidate): candidate is Extract<CardTab, { kind: 'link' }> => candidate.kind === 'link');
  const tidied = item.asSent;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="approval-qa">
        <p className="text-[13px] text-text-tertiary">{[...askedBy(item), relativeAge(item.createdAt, now)].join(' · ')}</p>
        <h2 className="mt-1.5 text-[19px] font-semibold leading-snug text-text-primary" data-testid="approval-title">{item.title}</h2>
        {tidied && (
          <div className="mt-2 rounded-lg bg-status-warning/10 px-3 py-2 text-[13px] text-status-warning-on-tint" data-testid="approval-tidied">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">Tidied by Pane: sent as one {[...tidied.title].length}-character question. Split by rule; every word is the sender’s.</span>
              <button type="button" className="shrink-0 font-medium hover:underline" aria-expanded={showSent} onClick={() => setShowSent((shown) => !shown)} data-testid="approval-show-as-sent">
                {showSent ? 'Hide' : 'Show as sent'}
              </button>
            </div>
            {showSent && (
              <div className="mt-2 rounded-md bg-surface-primary px-3 py-2 text-text-primary" data-testid="approval-as-sent">
                <p className="whitespace-pre-wrap font-semibold">{tidied.title}</p>
                {tidied.context && <p className="mt-1 whitespace-pre-wrap text-text-secondary">{tidied.context}</p>}
              </div>
            )}
          </div>
        )}
        {item.context && <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-text-secondary" data-testid="approval-subtitle">{item.context}</p>}
        {item.revision && waiting && (
          <section className="mt-4 rounded-xl border border-status-info/30 bg-status-info/10 p-4" data-testid="approval-revision">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
              <Sparkles className="h-4 w-4 text-status-info" aria-hidden="true" />
              <span className="min-w-0 flex-1">Updated after your question{item.readyAgain !== undefined ? ' · ready again' : ''}</span>
              <span className="rounded-full bg-surface-primary px-2 py-px text-[12px] font-semibold text-status-info-on-tint">v{item.version ?? 2}</span>
            </div>
            <blockquote className="mt-3 rounded-lg border-l-[3px] border-status-info bg-surface-primary px-3 py-2">
              <div className="text-[12px] text-text-tertiary">You asked</div>
              <div className="text-[14px] text-text-primary">“{item.revision.asked}”</div>
            </blockquote>
            <div className="mt-3 text-[13.5px] text-text-primary"><span className="font-semibold">What changed</span> · {item.revision.by}</div>
            <ul className="mt-1 list-disc pl-5 text-[13.5px] leading-relaxed text-text-primary" data-testid="approval-what-changed">
              {item.revision.whatChanged.map((change, at) => <li key={at}>{change}</li>)}
            </ul>
          </section>
        )}
        {item.relay ? (
          <p className="mt-4 text-[13px] text-text-tertiary" data-testid="approvals-read-only">{relayReadOnlyLine(item)}</p>
        ) : plain || ended ? (
          <div className="mt-4">
            <NotifyCard item={item} view={waiting ? 'question' : item.state === 'sent' ? 'sent' : item.state === 'expired' ? 'expired' : 'answered'} form="inbox" menuPlacement="below" onCommand={runNotify} />
          </div>
        ) : (
          <>
            {questions.map((question, at) => (
              <QuestionBlock
                key={`${at}:${question.title}`}
                question={question}
                label={questions.length > 1 ? `Question ${at + 1} of ${questions.length}` : 'Question'}
                noDetail={tidied ? 'No description was sent.' : undefined}
                picked={picks[at]}
                disabled={!waiting}
                onPick={(label) => setPicks((current) => { const next = [...current]; next[at] = current[at] === label ? '' : label; return next; })}
                showTitle={questions.length > 1 || question.title !== item.title}
              />
            ))}
            {item.ui === 'approve' && item.detail && (
              <details className="mt-3 rounded-lg border border-border-secondary">
                <summary className="cursor-pointer px-3 py-2 text-[13px] text-text-secondary">{item.detailLabel ?? 'Show details'}</summary>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border-secondary px-3 py-2 font-mono text-[12px] text-text-primary">{item.detail}</pre>
              </details>
            )}
            {item.ui === 'ask' && (item.suggestions?.length ?? 0) > 0 && waiting && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {item.suggestions?.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => setText(suggestion)} className="rounded-lg border border-border-secondary px-2.5 py-1 text-[13px] text-text-primary hover:bg-surface-hover">{suggestion}</button>
                ))}
              </div>
            )}
            {references.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-1.5" data-testid="approval-references">
                <span className="mr-1 text-[13px] text-text-tertiary">References</span>
                {references.map((reference) => {
                  const Icon = tabIcon(reference) ?? FileText;
                  return (
                    <button key={reference.key} type="button" onClick={() => onOpenTab(reference.key)}
                      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border-secondary px-2 py-1 text-[13px] text-interactive hover:bg-surface-hover">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                      <span className="truncate">{reference.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <button type="button" onClick={() => onOpenTab('summary')} className="mt-3 inline-flex items-center gap-0.5 text-left text-[13.5px] text-interactive hover:underline" data-testid="approval-read-summary">
              Read the Summary: what’s being decided, the trade-offs and where things stand <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {before && earlier.length > 0 && (
              <section className="mt-4 rounded-xl border border-border-secondary" data-testid="approval-earlier">
                {earlier.map((version) => (
                  <details key={version.version} className="border-b border-border-secondary last:border-b-0">
                    <summary className="cursor-pointer px-4 py-2.5 text-[13.5px] text-text-secondary">
                      Earlier version · v{version.version}{version.version === 1 ? ', as first asked' : ''}
                    </summary>
                    <div className="px-4 pb-3 text-[13.5px] text-text-primary">
                      {version.title !== item.title && <p className="font-semibold">{version.title}</p>}
                      {questionsOf({ ui: item.ui, title: version.title, choices: version.choices, questions: version.questions }).map((question, at) => (
                        <div key={at} className="mt-2">
                          <p className="font-semibold">{question.title}</p>
                          <ul className="mt-1 list-disc pl-5 leading-relaxed">
                            {question.choices.map((choice) => (
                              <li key={choice.label}><span className="font-semibold">{choice.label}</span>{choice.recommended ? ' (recommended)' : ''}{choice.detail ? `: ${choice.detail}` : ''}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {version.context && (<><p className="mt-2 font-semibold">Why it matters</p><p className="whitespace-pre-wrap text-text-secondary">{version.context}</p></>)}
                    </div>
                  </details>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      {ended && line && <div className="shrink-0 border-t border-border-primary px-5 pb-1 pt-3"><ReplyNotice item={item} /></div>}
      {!plain && !ended && (
        <div className="shrink-0 border-t border-border-primary px-5 pb-4 pt-3" data-testid="approval-reply">
          {line && <ReplyNotice item={item} />}
          {item.state === 'sent' && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-surface-tertiary px-3 py-2 text-[13px] text-text-secondary">
              <Check className="h-3.5 w-3.5" aria-hidden="true" /> <span className="min-w-0 flex-1">Sent: {item.answerSummary}</span>
              <button type="button" className="font-medium text-interactive hover:underline" onClick={() => runNotify({ type: 'undo', id: item.id })}>Undo</button>
            </div>
          )}
          {waiting && !item.agentPrompt && !item.optionsOnly && (
            <textarea
              ref={replyBox}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }}
              rows={2}
              aria-label="Reply"
              placeholder="Reply: pick above, add a note, answer in your own words, or ask about it…"
              className="w-full resize-none overflow-y-auto rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-[14px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
              data-testid="approval-reply-box"
            />
          )}
          {waiting && closing && <ItemCloseForm item={item} onCommand={(command) => { runNotify(command); setClosing(false); }} onCancel={() => setClosing(false)} className="mt-2" />}
          {waiting && !closing && (
            <div className="mt-2 flex items-center gap-3">
              <p className="min-w-0 flex-1 text-[12.5px] text-text-tertiary">
                {item.agentPrompt ? 'A permission prompt takes one of its options.' : item.optionsOnly ? 'This question takes one of its options.'
                  : replyBeingRead(item) ? `${sentenceStart(item.reply?.reader?.name ?? item.source.name)} is reading your last reply. You can send another once it says how it took it, or pick an option now.`
                    : preselected.some(Boolean) ? 'Recommended picks are pre-selected; change any before you send.' : 'Pick an option, or reply in your own words: an answer, or a question about it.'}
              </p>
              {!item.agentPrompt && (
                <button type="button" onClick={() => setClosing(true)} className="shrink-0 text-[12.5px] text-text-tertiary hover:text-text-primary" data-testid="approval-close-item">Close…</button>
              )}
              <button type="button" disabled={sending || !canSend(item, picks, text) || item.unreachable} onClick={() => void send()}
                className="inline-flex h-8 shrink-0 items-center rounded-lg bg-interactive px-4 text-[13.5px] font-medium text-text-on-interactive hover:bg-interactive-hover disabled:opacity-50" data-testid="approval-send">
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** How the reply on this approval was taken, with its one-click fix. Shown only on its own approval (Q-343.3). */
function ReplyNotice({ item }: { item: NotifyItem }) {
  const line = replyLine(item);
  if (!line) return null;
  const Icon = line.tone === 'success' ? Check : line.tone === 'warning' ? CircleAlert : Loader2;
  return (
    <div className={cn('mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', TONE_BOX[line.tone])} role="status" data-testid="approval-reply-line" data-tone={line.tone}>
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true"><Icon className={cn('h-3.5 w-3.5', TONE_TEXT[line.tone])} /></span>
      <span className={cn('min-w-0 flex-1 leading-snug', TONE_TEXT[line.tone])}>{line.text}</span>
      {line.fix && (
        <button type="button" className="shrink-0 font-medium text-interactive hover:underline" data-testid="approval-fix"
          onClick={() => runNotify({ type: 'fix-reply', id: item.id, as: line.fix?.as ?? 'answer' })}>
          {line.fix.label}
        </button>
      )}
    </div>
  );
}

function QuestionBlock({ question, label, picked, disabled, onPick, showTitle, noDetail }: { question: CardQuestion; label: string; picked?: string; disabled: boolean; onPick: (label: string) => void; showTitle: boolean; noDetail?: string }) {
  return (
    <section className="mt-4 rounded-xl border border-border-secondary p-4" data-testid="approval-question">
      <div className="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">{label}</div>
      {showTitle && <p className="mt-1 text-[15px] font-semibold text-text-primary">{question.title}</p>}
      {question.why && <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary" data-testid="approval-question-why">{question.why}</p>}
      <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label={question.title}>
        {question.choices.map((choice) => {
          const selected = picked === choice.label;
          return (
            <button
              key={choice.label}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onPick(choice.label)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent',
                selected ? 'border-interactive bg-interactive/5' : 'border-border-secondary',
                choice.mark === 'new' && 'border-l-[3px] border-l-status-success',
                choice.mark === 'reworded' && 'border-l-[3px] border-l-status-info',
              )}
              data-testid="approval-choice"
              data-mark={choice.mark}
            >
              {/* Fixed box: the radio swaps its fill, never its size. */}
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-border-hover" aria-hidden="true">
                <span className={cn('h-2 w-2 rounded-full', selected ? 'bg-interactive' : 'bg-transparent')} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-semibold text-text-primary">{choice.label}</span>
                  {choice.recommended && <span className="rounded bg-status-success/10 px-1.5 py-px text-[11.5px] font-medium text-status-success-on-tint">Recommended</span>}
                  {choice.mark === 'new' && <span className="rounded bg-status-success/10 px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-status-success-on-tint" data-testid="approval-mark">New</span>}
                  {choice.mark === 'reworded' && <span className="rounded bg-status-info/10 px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-status-info-on-tint" data-testid="approval-mark">Reworded</span>}
                </span>
                {choice.detail ? <span className="mt-0.5 block text-[13px] leading-relaxed text-text-secondary">{choice.detail}</span>
                  : noDetail && <span className="mt-0.5 block text-[13px] leading-relaxed text-text-tertiary">{noDetail}</span>}
                {choice.before && (
                  <span className="mt-1 block text-[12.5px] leading-relaxed text-text-tertiary line-through" data-testid="approval-was">
                    was: {choice.before.label !== choice.label ? `${choice.before.label}${choice.before.detail ? `: ${choice.before.detail}` : ''}` : choice.before.detail ?? ''}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {question.removed.map((removed) => (
          <div key={removed} className="flex items-center gap-3 rounded-lg border border-dashed border-border-secondary px-3 py-2.5 text-[14px] text-text-tertiary" data-testid="approval-removed">
            <span className="rounded bg-surface-tertiary px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide">Removed</span>
            <span className="line-through">{removed}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Summary (P4): one HTML page, the asker's own or the one Pane writes from the card, read from the
 * machine that holds the approval and shown with scripts and network off, as on the phone.
 */
function SummaryTab({ item }: { item: NotifyItem }) {
  const { theme } = useTheme();
  const dark = !isLightTheme(theme);
  const [page, setPage] = useState<SummaryRead | null>(null);
  useEffect(() => {
    let current = true;
    setPage(null);
    void readSummaryPage(item, dark ? 'dark' : 'light').then((read) => { if (current) setPage(read); });
    return () => { current = false; };
    // A new version rewrites the template; the item's other changes don't.
  }, [item.id, item.version, item.state, item.reply?.state, dark]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = page?.kind === 'page' ? baseName(page.path) : 'Written by Pane';
  return (
    <div className="absolute inset-0 flex flex-col p-3" data-testid="approval-summary">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-secondary">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-secondary bg-surface-tertiary px-3 text-[12.5px] text-text-tertiary">
          <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-text-secondary" data-testid="approval-summary-source">{label}</span>
          <span className="shrink-0">· sandboxed, no scripts</span>
        </div>
        {page === null && <p className="m-auto text-[13px] text-text-tertiary">Loading the Summary…</p>}
        {page?.kind === 'failed' && <p className="m-auto px-6 text-center text-[13px] text-text-secondary">{page.message}</p>}
        {(page?.kind === 'page' || page?.kind === 'template') && (
          // sandbox with no allowances: no scripts, no forms, no navigation; the page's own policy blocks the network.
          <iframe title={`Summary: ${item.title}`} sandbox="" srcDoc={page.html} className="min-h-0 w-full flex-1 border-0 bg-surface-primary" data-testid="approval-summary-frame" />
        )}
      </div>
    </div>
  );
}

function baseName(file: string): string {
  return file.replace(/#.*$/u, '').split(/[\\/]/u).pop() ?? file;
}

/** A reference: a file in the document viewer, a URL in the in-app browser, another approval in place. */
function LinkTab({ item, link, onOpenApproval }: { item: NotifyItem; link: NotifyLink; onOpenApproval: (id: string) => void }) {
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const here = (item.machineId ?? LOCAL_MACHINE_ID) === LOCAL_MACHINE_ID && activeMachineId === LOCAL_MACHINE_ID;
  if ('approval' in link) {
    return (
      <div className="p-6 text-[13.5px] text-text-secondary">
        <p>{link.label} is another approval.</p>
        <button type="button" onClick={() => onOpenApproval(link.approval)} className="mt-2 font-medium text-interactive hover:underline">Open it here</button>
      </div>
    );
  }
  if ('url' in link) return <div className="absolute inset-0 flex flex-col"><AutopilotWebPage key={link.url} src={link.url} title={link.label} /></div>;
  if (!here) return <p className="p-6 text-[13.5px] text-text-secondary">{link.label} is a file on {item.machine ?? 'the asking machine'}: open it there.</p>;
  return <div className="absolute inset-0 flex flex-col overflow-y-auto"><AutopilotDocument key={link.path} path={link.path} label={link.label} /></div>;
}

/** Another approval opened from a link, in place, with Back. */
function NestedApproval({ item, onBack }: { item: NotifyItem; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <button type="button" onClick={onBack} className="inline-flex shrink-0 items-center gap-1.5 px-6 pt-4 text-[13px] font-medium text-interactive hover:underline" data-testid="approval-back">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
      </button>
      <div className="min-h-0 flex-1">
        <QuestionsTab item={item} tabs={[]} onOpenTab={() => undefined} />
      </div>
    </div>
  );
}

/** The reply box grows with what's typed, up to half the column, then scrolls (P6). */
function useGrowingBox(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const column = box.closest('[data-testid="approval-column"]');
    const limit = Math.max(64, (column?.clientHeight ?? 600) / 2);
    box.style.height = 'auto';
    box.style.height = `${Math.min(Math.max(box.scrollHeight, 64), limit)}px`;
  }, [ref, value]);
}
