import { useState } from 'react';
import { ArrowUp, ChevronRight, CircleCheck, CircleHelp, Hourglass, Navigation, PanelRight, ShieldAlert } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { decisionModel, type DecisionModel } from '../../../../shared/autopilotDecision';
import { cn } from '../../utils/cn';
import { runNotify } from '../../stores/notifyStore';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';

function KindIcon({ model }: { model: DecisionModel }) {
  const className = 'h-4 w-4 shrink-0';
  if (model.byAutopilot) return <Navigation className={cn(className, 'text-autopilot')} aria-hidden="true" />;
  if (model.kind === 'Stuck') return <Hourglass className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  if (model.kind === 'Permission') return <ShieldAlert className={cn(className, 'text-status-error')} aria-hidden="true" />;
  if (model.kind === 'Approval') return <CircleCheck className={cn(className, 'text-status-warning')} aria-hidden="true" />;
  return <CircleHelp className={cn(className, 'text-status-warning')} aria-hidden="true" />;
}

function Meta({ model, now }: { model: DecisionModel; now: number }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-text-tertiary">
      <KindIcon model={model} />
      <span className={cn('shrink-0 font-semibold', model.byAutopilot ? 'text-autopilot-on-tint' : 'text-text-secondary')}>{model.kind}</span>
      {model.qn && <span className="shrink-0">· {model.qn}</span>}
      {model.byAutopilot ? <span>· its own</span> : model.session && <span className="min-w-0 truncate">· {model.session}</span>}
      {!model.byAutopilot && <span className="min-w-0 truncate">· {model.who}</span>}
      <span className="ml-auto shrink-0 tabular-nums">{relativeAge(model.createdAt, now)}</span>
    </div>
  );
}

/** A typed answer to an open question. */
function TextAnswer({ id }: { id: string }) {
  const [text, setText] = useState('');
  const send = () => { if (text.trim()) runNotify({ type: 'answer', id, answer: { text: text.trim() } }); };
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

/**
 * Autopilot's decision card in its chat (D-91, the phone's card, D-75/D-77): the question, its why,
 * and the options with the recommended one first. Choosing an option answers it. The current card
 * is the one whose context fills the right side; any other card opens as current when clicked.
 */
export function AutopilotDecisionCard({ item, current, onMakeCurrent }: { item: NotifyItem; current: boolean; onMakeCurrent?: () => void }) {
  const now = useNow();
  const model = decisionModel(item);

  if (model.state === 'answered' || model.state === 'expired' || model.state === 'info') {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl px-3.5 py-2.5 ring-1 ring-border-secondary" data-testid="autopilot-decision" data-state={model.state}>
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-text-tertiary">{model.kind}{model.qn ? ` · ${model.qn}` : ''}{model.session ? ` · ${model.session}` : ''}</span>
          <span className="block truncate text-[13.5px] text-text-secondary">{model.title}</span>
          <span className="block text-[12.5px] text-text-tertiary">
            {model.state === 'expired' ? 'The agent stopped asking.' : <><b className="font-medium text-text-secondary">{model.answerSummary ?? 'Answered'}</b>{item.answeredOn ? ` · on ${item.answeredOn}` : ' · by you'}{model.session ? ` · ${model.session} recorded it` : ''}</>}
          </span>
        </span>
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
          <span className="block truncate text-[12px] text-text-tertiary">{model.qn ? `${model.qn} · ` : ''}{model.byAutopilot ? 'written by Autopilot' : model.who}</span>
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
        <Meta model={model} now={now} />
        <h3 className="mt-1 text-[15px] font-semibold leading-snug text-text-primary">{model.title}</h3>
        {model.why && <p className="mt-1 text-[13.5px] leading-relaxed text-text-secondary">{model.why}</p>}
      </div>
      {model.state === 'sent' ? (
        <div className="flex items-center gap-2 border-t border-border-primary px-3.5 py-2.5 text-[13px]" role="status" data-testid="autopilot-decision-sent">
          <CircleCheck className="h-4 w-4 shrink-0 text-status-success" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-text-primary"><b className="font-semibold">{model.answerSummary ?? 'Answered'}</b> · by you</span>
          <button type="button" onClick={() => runNotify({ type: 'undo', id: item.id })} className="shrink-0 font-medium text-text-secondary underline hover:text-text-primary">Undo</button>
        </div>
      ) : !model.answerable ? (
        <p className="border-t border-border-primary px-3.5 py-2.5 text-[13px] text-text-tertiary">Its orchestrator hasn&rsquo;t picked this up yet; it&rsquo;s answered in that Session&rsquo;s tab.</p>
      ) : (
        <>
          {model.options.length > 0 && (
            <div role="group" aria-label={`Answer: ${model.title}`} className="border-t border-border-primary">
              {model.options.map((option) => (
                <button key={option.key} type="button" onClick={() => runNotify({ type: 'answer', id: item.id, answer: option.answer })} data-testid="autopilot-decision-option"
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
          {model.freeText && <TextAnswer id={item.id} />}
        </>
      )}
      <div className="flex items-center gap-1.5 border-t border-border-primary px-3.5 py-2 text-[12.5px] text-text-tertiary">
        <PanelRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {current ? <span>{model.contextLabel} and related docs are on the right</span>
          : <button type="button" onClick={onMakeCurrent} className="hover:text-text-primary">{model.contextLabel} and related docs ›</button>}
      </div>
    </div>
  );
}
