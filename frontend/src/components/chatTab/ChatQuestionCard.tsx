import { useState } from 'react';
import type { ChatTabAnswer, ChatTabQuestion } from '../../../../shared/types/chatTab';
import { questionAnswer, questionFields, unshownRequiredFields, type QuestionField } from '../../../../shared/chatTabQuestions';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * An agent's question (ACP form elicitation), such as Claude's AskUserQuestion,
 * docked above the composer. The first answer from any surface wins.
 */
export function ChatQuestionCard({ question, disabled, onAnswer }: { question: ChatTabQuestion; disabled: boolean; onAnswer: (answer: ChatTabAnswer) => void }) {
  const fields = questionFields(question.schema);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const set = (key: string, value: JsonValue) => setValues(current => ({ ...current, [key]: value }));
  const unshown = unshownRequiredFields(question.schema);
  const content = unshown.length ? undefined : questionAnswer(fields, values);
  const submit = () => { if (content) onAnswer({ action: 'accept', content }); };
  return <section aria-label="Agent question" className="chat-question" onKeyDown={event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  }}>
    <p className="chat-question-message">{question.message}</p>
    {fields.map(field => <Field key={field.key} field={field.title === question.message ? { ...field, title: '' } : field} value={values[field.key]} disabled={disabled} onChange={value => set(field.key, value)} />)}
    {unshown.length > 0 && <p className="chat-question-hint">Pane can't show {unshown.join(', ')}, so you can only skip this question.</p>}
    <div className="chat-question-actions">
      <button type="button" className="chat-button chat-button-primary" disabled={disabled || !content} onClick={submit}>Answer</button>
      <button type="button" className="chat-button chat-button-outline" disabled={disabled} onClick={() => onAnswer({ action: 'decline' })}>Skip</button>
    </div>
  </section>;
}

function Field({ field, value, disabled, onChange }: { field: QuestionField; value: JsonValue | undefined; disabled: boolean; onChange: (value: JsonValue) => void }) {
  const label = <span className="chat-question-label" hidden={!field.title && !field.description}>{field.title}{field.description && <span className="chat-question-hint">{field.description}</span>}</span>;
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
