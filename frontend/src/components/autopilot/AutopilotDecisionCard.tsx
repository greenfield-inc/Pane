import { useState } from 'react';
import { ArrowUp, ChevronRight, CircleCheck, CircleHelp, Navigation, PanelRight, ShieldAlert } from 'lucide-react';
import type { NotifyAnswer, NotifyItem } from '../../../../shared/types/notify';
import { canClose, canOverride, canReopen, decisionLine, receiptLine } from '../../../../shared/approvalReceipts';
import { decisionModel, type DecisionModel } from '../../../../shared/autopilotDecision';
import { cn } from '../../utils/cn';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { runNotify } from '../../stores/notifyStore';
import { shownStackEntry, useAutopilotStore } from '../../stores/autopilotStore';
import { relayReadOnlyLine } from '../approvals/approvalGroups';
import { ItemCloseForm } from '../notify/NotifyCard';
import { machineLabel, originOf, relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { ClampedText } from '../notify/ClampedText';

function KindIcon({ model }: { model: DecisionModel }) {
  const className = 'h-4 w-4 shrink-0';
  if (model.byAutopilot) return <Navigation className={cn(className, 'text-autopilot')} aria-hidden="true" />;
  if (model.kind === 'Permission') return <ShieldAlert className={cn(className, 'text-status-error')} aria-hidden="true" />;
  if (model.kind === 'Approval') return <CircleCheck className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  return <CircleHelp className={cn(className, 'text-status-warning')} aria-hidden="true" />;
}

function Meta({ model, origin, now }: { model: DecisionModel; origin: string; now: number }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-text-tertiary">
      <KindIcon model={model} />
      <span className={cn('shrink-0 font-semibold', model.byAutopilot ? 'text-autopilot-on-tint' : 'text-text-secondary')}>{model.kind}</span>
      {model.qn && <span className="shrink-0">· {model.qn}</span>}
      {origin === 'Autopilot' ? <span>· its own</span> : <span className="min-w-0 truncate" data-testid="autopilot-decision-origin">· {origin}</span>}
      <span className="ml-auto shrink-0 tabular-nums">{relativeAge(model.createdAt, now)}</span>
    </div>
  );
}

/** A typed answer to an open question. */
function TextAnswer({ onAnswer }: { onAnswer: (answer: NotifyAnswer) => void }) {
  const [text, setText] = useState('');
  const send = () => { if (text.trim()) onAnswer({ text: text.trim() }); };
  return (
    <form className="flex items-center gap-2 border-t border-border-primary px-3.5 py-2.5" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type your answer" aria-label="Your answer"
        className="h-8 min-w-0 flex-1 rounded-lg bg-surface-tertiary px-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle" />
      <button type="submit" disabled={!text.trim()} aria-label="Send answer" className="flex h-8 w-8 items-center justify-center rounded-full bg-interactive text-text-on-interactive disabled:opacity-40">
        <ArrowUp className="h-4 w-4" />
      </button>
    </form>
  );
}

/** The options and the typed answer, for answering and for an Override. */
function AnswerControls({ model, onAnswer }: { model: DecisionModel; onAnswer: (answer: NotifyAnswer) => void }) {
  return (
    <>
      {model.options.length > 0 && (
        <div role="group" aria-label={`Answer: ${model.title}`} className="border-t border-border-primary">
          {model.options.map((option) => (
            <button key={option.key} type="button" onClick={() => onAnswer(option.answer)} data-testid="autopilot-decision-option"
              className="flex w-full items-start gap-2.5 border-t border-border-primary px-3.5 py-2.5 text-left first:border-t-0 hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover">
              {/* A fixed-size ring: options never shift as one is hovered or chosen. */}
              <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', option.recommended ? 'border-text-primary' : 'border-border-secondary')} aria-hidden="true">
                <span className={cn('h-1.5 w-1.5 rounded-full bg-text-primary', !option.recommended && 'invisible')} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium text-text-primary">
                  {option.label}
                  {option.recommended && <span className="rounded-full bg-status-success/15 px-1.5 text-[11px] font-medium text-status-success-on-tint">Recommended</span>}
                </span>
                {option.detail && <span className="block text-[12.5px] text-text-tertiary">{option.detail}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {model.freeText && <TextAnswer onAnswer={onAnswer} />}
    </>
  );
}

/**
 * Autopilot's decision card in its chat (D-91, the phone's card, D-75/D-77): the question, its why,
 * and the options with the recommended one first. Choosing an option answers it. The current card
 * is the one whose context fills the right side; any other card opens as current when clicked.
 */
export function AutopilotDecisionCard({ item, current, onMakeCurrent }: { item: NotifyItem; current: boolean; onMakeCurrent?: () => void }) {
  const now = useNow();
  const machines = useAllMachinesStore((state) => state.entries);
  const [overriding, setOverriding] = useState(false);
  const [closing, setClosing] = useState(false);
  const model = decisionModel(item);
  const origin = originOf(item, machines);
  // The right side holds the shown entry's documents; with none, the card doesn't point there.
  const contextShown = useAutopilotStore((state) => !!shownStackEntry(state.snapshot)?.tabs.some((tab) => tab.kind !== 'item'));

  if (model.state === 'answered' || model.state === 'expired' || model.state === 'info') {
    const receipt = receiptLine(item);
    const decision = decisionLine(item);
    const correction = item.corrections?.at(-1);
    return (
      <div className="overflow-hidden rounded-2xl ring-1 ring-border-secondary" data-testid="autopilot-decision" data-state={model.state}>
        <div className="flex items-start gap-2.5 px-3.5 py-2.5">
          <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-text-tertiary">{model.kind}{model.qn ? ` · ${model.qn}` : ''} · {origin}</span>
            <span className="block truncate text-[13.5px] text-text-secondary">{model.title}</span>
            <span className="block text-[12.5px] text-text-tertiary" data-testid="autopilot-decision-receipt">
              {model.state === 'expired'
                ? receipt ?? 'The agent stopped asking.'
                : <><b className="font-medium text-text-secondary">{model.answerSummary ?? 'Answered'}</b> · {receipt ?? (item.answeredOn ? `on ${item.answeredOn}` : 'by you')}</>}
              {decision ? ` · ${decision}` : ''}
            </span>
            {correction && <span className="block text-[12.5px] text-text-tertiary">You corrected it: {correction.summary}</span>}
          </span>
          {canOverride(item) && !item.unreachable && (
            <button type="button" onClick={() => setOverriding((open) => !open)} aria-expanded={overriding} data-testid="autopilot-decision-override" className="shrink-0 text-[12.5px] font-medium text-text-secondary underline hover:text-text-primary">Override</button>
          )}
          {canReopen(item) && !item.unreachable && (
            <button type="button" onClick={() => runNotify({ type: 'reopen', id: item.id })} data-testid="autopilot-decision-reopen" className="shrink-0 text-[12.5px] font-medium text-text-secondary underline hover:text-text-primary">Reopen</button>
          )}
        </div>
        {overriding && canOverride(item) && (
          <AnswerControls model={model} onAnswer={(answer) => { setOverriding(false); runNotify({ type: 'override', id: item.id, answer }); }} />
        )}
      </div>
    );
  }

  if (!current && onMakeCurrent) {
    // Not the one in front of you: one line, and clicking it brings it up with its context.
    return (
      <button type="button" onClick={onMakeCurrent} data-testid="autopilot-decision" data-state="waiting" data-current="false"
        className="flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left ring-1 ring-border-secondary hover:bg-surface-hover">
        <KindIcon model={model} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] text-text-primary">{model.title}</span>
          <span className="block truncate text-[12px] text-text-tertiary">{model.qn ? `${model.qn} · ` : ''}{origin === 'Autopilot' ? 'written by Autopilot' : origin}</span>
        </span>
        <span className="shrink-0 text-[12px] text-text-tertiary">{model.state === 'sent' ? 'sent · Undo' : relativeAge(model.createdAt, now)}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      className={cn('overflow-hidden rounded-2xl bg-surface-primary shadow-card ring-1', model.byAutopilot ? 'ring-autopilot-border' : current ? 'ring-status-warning' : 'ring-border-secondary')}
      data-testid="autopilot-decision" data-state={model.state} data-current={current ? 'true' : 'false'} data-item-id={item.id}
    >
      <div className="px-3.5 pb-2.5 pt-3">
        <Meta model={model} origin={origin} now={now} />
        <h3 className="mt-1 text-[15px] font-semibold leading-snug text-text-primary">{model.title}</h3>
        {model.why && <ClampedText text={model.why} className="mt-1 text-[13.5px] leading-relaxed text-text-secondary" />}
        {receiptLine(item) && <p className="mt-1 text-[12.5px] text-text-tertiary" data-testid="autopilot-decision-receipt">{receiptLine(item)}</p>}
      </div>
      {model.state === 'sent' ? (
        <div className="flex items-center gap-2 border-t border-border-primary px-3.5 py-2.5 text-[13px]" role="status" data-testid="autopilot-decision-sent">
          <CircleCheck className="h-4 w-4 shrink-0 text-status-success" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-text-primary"><b className="font-semibold">{model.answerSummary ?? 'Answered'}</b> · by you</span>
          <button type="button" onClick={() => runNotify({ type: 'undo', id: item.id })} className="shrink-0 font-medium text-text-secondary underline hover:text-text-primary">Undo</button>
        </div>
      ) : !model.answerable ? (
        <p className="border-t border-border-primary px-3.5 py-2.5 text-[13px] text-text-tertiary">
          {item.relay ? relayReadOnlyLine({ ...item, machine: machineLabel(item, machines) }) : `${item.source.agent} is asking in the terminal now.`}
        </p>
      ) : (
        <AnswerControls model={model} onAnswer={(answer) => runNotify({ type: 'answer', id: item.id, answer })} />
      )}
      {closing ? (
        <ItemCloseForm item={item} onCommand={runNotify} onCancel={() => setClosing(false)} className="border-t border-border-primary px-3.5 py-2.5" />
      ) : (
        (!current || contextShown || (canClose(item) && !item.unreachable)) && <div className="flex items-center gap-1.5 border-t border-border-primary px-3.5 py-2 text-[12.5px] text-text-tertiary">
          {(!current || contextShown) && <PanelRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          {!current ? <button type="button" onClick={onMakeCurrent} className="min-w-0 truncate hover:text-text-primary">{model.contextLabel} and related docs ›</button>
            : contextShown && <span className="min-w-0 truncate">{model.contextLabel} and related docs are on the right</span>}
          {canClose(item) && !item.unreachable && (
            <button type="button" onClick={() => setClosing(true)} data-testid="autopilot-decision-close" className="ml-auto shrink-0 hover:text-text-primary">Close</button>
          )}
        </div>
      )}
    </div>
  );
}
