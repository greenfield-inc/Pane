import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatTabAnswer, ChatTabQuestion } from '../../../../shared/types/chatTab';
import { questionAnswer, questionFields, questionSteps, steppedAnswer, stepSummary, unshownRequiredFields, type QuestionField } from '../../../../shared/chatTabQuestions';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** Typing in a box keeps its keys: digits are text there, and Enter is the box's own. */
const typing = (target: EventTarget) => target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number') || target instanceof HTMLTextAreaElement;

/**
 * An agent's question (ACP form elicitation), such as Claude's AskUserQuestion,
 * docked above the composer. The first answer from any surface wins. A form that asks
 * several questions takes them one at a time (D-230): "1 of 2", Back and Next, Skip
 * passes over one question, and the last step reviews the picks beside Answer.
 */
export function ChatQuestionCard({ question, disabled, onAnswer }: { question: ChatTabQuestion; disabled: boolean; onAnswer: (answer: ChatTabAnswer) => void }) {
  const fields = questionFields(question.schema);
  const steps = questionSteps(fields);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [index, setIndex] = useState(0);
  const set = (key: string, value: JsonValue) => setValues(current => ({ ...current, [key]: value }));
  const unshown = unshownRequiredFields(question.schema);
  const stepped = steps.length > 1 && !unshown.length;
  const answerFor = (given: Readonly<Record<string, JsonValue>>) => unshown.length ? undefined : stepped ? steppedAnswer(steps, given) : questionAnswer(fields, given);
  const content = answerFor(values);
  const submit = () => { if (content) onAnswer({ action: 'accept', content }); };
  const step = steps[index] ?? [];
  const last = index === steps.length - 1;
  const answered = !!stepSummary(step, values);
  const stepRef = useRef<HTMLDivElement>(null);
  /** Set when the person moves between questions, so the new one takes focus (and the card keeps its keys). */
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const box = stepRef.current;
    const target = box?.querySelector<HTMLElement>('input:checked:not(:disabled)') ?? box?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)');
    (target ?? box)?.focus();
  }, [index]);
  const go = (next: number) => {
    moved.current = true;
    setIndex(Math.max(0, Math.min(steps.length - 1, next)));
  };
  const next = () => {
    if (last) { submit(); return; }
    if (answered) go(index + 1);
  };
  /** Skip passes over this question only; skipping the last one answers the rest, or declines when nothing was given. */
  const skip = () => {
    const cleared = { ...values };
    for (const field of step) delete cleared[field.key];
    setValues(cleared);
    if (!last) { go(index + 1); return; }
    const rest = answerFor(cleared);
    onAnswer(rest ? { action: 'accept', content: rest } : { action: 'decline' });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || disabled) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); return; }
    if (!stepped) return;
    const choice = step.find(field => field.kind === 'single' || field.kind === 'multiple');
    if (/^[1-9]$/.test(event.key) && !typing(event.target) && choice && (choice.kind === 'single' || choice.kind === 'multiple')) {
      const picked = choice.choices[Number(event.key) - 1];
      if (!picked) return;
      event.preventDefault();
      if (choice.kind === 'single') set(choice.key, picked.value);
      else {
        const current = values[choice.key];
        const chosen = Array.isArray(current) ? current : [];
        set(choice.key, chosen.includes(picked.value) ? chosen.filter(entry => entry !== picked.value) : [...chosen, picked.value]);
      }
    } else if (event.key === 'Enter' && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      next();
    }
  };
  if (!stepped) {
    return <section aria-label="Agent question" className="chat-question" onKeyDown={onKeyDown}>
      <p className="chat-question-message">{question.message}</p>
      {fields.map(field => <Field key={field.key} field={field.title === question.message ? { ...field, title: '' } : field} value={values[field.key]} disabled={disabled} onChange={value => set(field.key, value)} />)}
      {unshown.length > 0 && <p className="chat-question-hint">Pane can't show {unshown.join(', ')}, so you can only skip this question.</p>}
      <div className="chat-question-actions">
        <button type="button" className="chat-button chat-button-primary" disabled={disabled || !content} onClick={submit}>Answer</button>
        <button type="button" className="chat-button chat-button-outline" disabled={disabled} onClick={() => onAnswer({ action: 'decline' })}>Skip</button>
      </div>
    </section>;
  }
  const [lead, ...rest] = step;
  return <section aria-label="Agent question" className="chat-question" onKeyDown={onKeyDown}>
    <div className="chat-question-head">
      <p className="chat-question-message">{question.message}</p>
      <span className="chat-question-count" aria-live="polite">{index + 1} of {steps.length}</span>
    </div>
    <div className="chat-question-step" key={index} ref={stepRef} tabIndex={-1}>
      {lead && <Field field={lead} heading value={values[lead.key]} disabled={disabled} onChange={value => set(lead.key, value)} />}
      {rest.map(field => <Field key={field.key} field={field} value={values[field.key]} disabled={disabled} onChange={value => set(field.key, value)} />)}
    </div>
    {last && <ol className="chat-question-review" aria-label="Your answers">
      {steps.slice(0, -1).map((earlier, position) => <li key={position}>
        <button type="button" className="chat-question-review-row" onClick={() => go(position)} title="Change this answer">
          <span className="chat-question-review-title">{earlier[0]?.title}</span>
          <span className="chat-question-review-pick">{stepSummary(earlier, values) ?? 'Skipped'}</span>
        </button>
      </li>)}
    </ol>}
    <div className="chat-question-actions">
      {last
        ? <button type="button" className="chat-button chat-button-primary" disabled={disabled || !content} onClick={submit}>Answer</button>
        : <button type="button" className="chat-button chat-button-primary" disabled={disabled || !answered} onClick={next}>Next</button>}
      <button type="button" className="chat-button chat-button-outline" disabled={disabled} onClick={skip} title="Skip this question">Skip</button>
      {index > 0 && <button type="button" className="chat-button chat-button-outline chat-question-back" disabled={disabled} onClick={() => go(index - 1)}>Back</button>}
      <span className="chat-question-keys" aria-hidden>{lead && (lead.kind === 'single' || lead.kind === 'multiple') ? '1–9 picks · ' : ''}Enter {last ? 'answers' : 'next'}</span>
    </div>
  </section>;
}

function Field({ field, value, disabled, onChange, heading = false }: { field: QuestionField; value: JsonValue | undefined; disabled: boolean; onChange: (value: JsonValue) => void; heading?: boolean }) {
  const label = <span className={heading ? 'chat-question-label chat-question-heading' : 'chat-question-label'} hidden={!field.title && !field.description}>{field.title}{field.description && <span className="chat-question-hint">{field.description}</span>}</span>;
  if (field.kind === 'single') {
    return <fieldset className="chat-question-field" disabled={disabled}><legend>{label}</legend>
      {field.choices.map(choice => <label key={choice.value} className="chat-question-choice">
        <input type="radio" name={field.key} checked={value === choice.value} onChange={() => onChange(choice.value)} />
        <span>{choice.title}{choice.description && <span className="chat-question-hint">{choice.description}</span>}</span>
      </label>)}
    </fieldset>;
  }
  if (field.kind === 'multiple') {
    const chosen = Array.isArray(value) ? value : [];
    const picked = new Set(chosen);
    return <fieldset className="chat-question-field" disabled={disabled}><legend>{label}</legend>
      {field.choices.map(choice => <label key={choice.value} className="chat-question-choice">
        <input type="checkbox" checked={picked.has(choice.value)} onChange={event => onChange(event.target.checked ? [...chosen, choice.value] : chosen.filter(entry => entry !== choice.value))} />
        <span>{choice.title}{choice.description && <span className="chat-question-hint">{choice.description}</span>}</span>
      </label>)}
    </fieldset>;
  }
  if (field.kind === 'boolean') {
    return <label className="chat-question-choice"><input type="checkbox" disabled={disabled} checked={value === true} onChange={event => onChange(event.target.checked)} />{label}</label>;
  }
  return <label className="chat-question-field">{label}
    <input type={field.kind === 'number' ? 'number' : 'text'} className="chat-question-input" disabled={disabled} value={value === undefined || value === null ? '' : String(value)}
      placeholder={field.kind === 'text' ? (field.required ? 'Your answer' : 'Your own answer (optional)') : undefined}
      onChange={event => {
        const raw = event.target.value;
        // An empty or partial number is left as text, never stored as 0 or NaN.
        onChange(field.kind === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw);
      }} />
  </label>;
}
