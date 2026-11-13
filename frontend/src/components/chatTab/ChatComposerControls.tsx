import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { Check, ChevronDown, FilePen, Hand, ListTodo, Shield, ShieldOff, Sparkles, type LucideIcon } from 'lucide-react';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';
import { Toggle } from '../ui/Toggle';
import { choiceName, isRiskyMode, modelSummary, onOffValues, paneFullAccessOn, phoneSettingsOrder, triggerLabels, type ComposerControls } from '../../../../shared/chatComposerControls';

type Configure = (id: string, value: string) => void;

/** Icons for common permission modes; a mode that never asks shows the open shield, any other the plain one. */
const MODE_ICONS = new Map<string, LucideIcon>([
  ['default', Hand], ['read-only', Hand], ['acceptEdits', FilePen], ['plan', ListTodo], ['auto', Sparkles], ['agent', Sparkles],
]);

/**
 * The setting that lets the agent act without asking right now: a mode that never asks, or
 * Pane's own Full access when it is on. Viewers mark either one the same way.
 */
export function riskySetting(arranged: ComposerControls): AgentChatConfigOption | undefined {
  return isRiskyMode(arranged.mode) ? arranged.mode : paneFullAccessOn(arranged.more);
}

/**
 * The permission mode, as a quiet chip that opens the mode list; amber for a mode that never asks
 * (D-267), and while Pane's Full access is on (`risky`).
 */
export function ChatModeChip({ control, risky, disabled, configure }: { control: AgentChatConfigOption; risky: boolean; disabled: boolean; configure: Configure }) {
  const Icon = isRiskyMode(control) ? ShieldOff : MODE_ICONS.get(control.currentValue) ?? Shield;
  return <Dropdown className="chat-anchor chat-anchor-mode" position="top-left" width="md" selectedId={control.currentValue} selectedMark="check" menuLabel={control.name}
    items={control.options.map(option => ({ id: option.value, label: option.name, onClick: () => { if (option.value !== control.currentValue) configure(control.id, option.value); } }))}
    trigger={<button type="button" disabled={disabled} title={`${control.name}: ${choiceName(control)}`} className="chat-chip" data-tone={risky ? 'warning' : undefined}>
      <Icon className="chat-chip-icon" aria-hidden />
      <span className="sr-only">{control.name}: </span><span className="chat-chip-label">{choiceName(control)}</span>
    </button>} />;
}

/** Every setting in the model menu is a named field; Tab moves between them and leaves at either edge. */
function stayInFields(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  // A radio group is one stop (its checked choice); arrows move inside it.
  const fields = [...event.currentTarget.querySelectorAll('select:not(:disabled), [role=switch]:not(:disabled), input[type=radio]:checked:not(:disabled)')];
  const active = document.activeElement;
  const stop = active instanceof HTMLInputElement && active.type === 'radio'
    ? fields.find(field => field instanceof HTMLInputElement && field.name === active.name)
    : active;
  const current = fields.findIndex(field => field === stop);
  const next = current + (event.shiftKey ? -1 : 1);
  if (current >= 0 && next >= 0 && next < fields.length) event.stopPropagation();
}

function Field({ control, disabled, configure }: { control: AgentChatConfigOption; disabled: boolean; configure: Configure }) {
  return <label className="chat-field">
    <span>{control.name}</span>
    <select aria-label={control.name} value={control.currentValue} disabled={disabled} onChange={event => configure(control.id, event.target.value)}
      // The menu moves between items with the arrows; inside a select they pick a choice.
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.stopPropagation(); }}>
      {control.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
    </select>
  </label>;
}

/** Model and effort on one button; its menu also holds the agent's other settings, each under its own name. */
export function ChatModelMenu({ arranged, disabled, configure }: { arranged: ComposerControls; disabled: boolean; configure: Configure }) {
  const primary = [arranged.model, arranged.effort].flatMap(control => control ? [control] : []);
  if (!primary.length && !arranged.more.length) return null;
  const summary = modelSummary(arranged);
  return <Dropdown className="chat-anchor" position="top-right" width="lg" items={[]} formLabel="Model and options"
    trigger={<button type="button" disabled={disabled} title={summary} className="chat-chip chat-model">
      <span className="sr-only">Model and options: </span><span className="chat-chip-label">{summary}</span>
      <ChevronDown className="chat-chip-chevron" aria-hidden />
    </button>}
    footer={<div className="chat-fields" onKeyDown={stayInFields}>
      {primary.map(control => <Field key={control.id} control={control} disabled={disabled} configure={configure} />)}
      {!!primary.length && !!arranged.more.length && <hr className="chat-fields-rule" />}
      {arranged.more.map(control => <Field key={control.id} control={control} disabled={disabled} configure={configure} />)}
    </div>} />;
}

/** A composer narrower than this is laid out for a phone (D-118): the PWA on a phone, or a very narrow panel. */
const PHONE_WIDTH = 480;

/** Whether the element is phone-narrow, following its size. */
export function usePhoneWidth(ref: RefObject<HTMLElement | null>): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setPhone(entry.contentRect.width < PHONE_WIDTH));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return phone;
}

/**
 * On a phone the mode leaves the row, and an agent may have no mode at all: a setting that lets the
 * agent act without asking (riskySetting) keeps a small marker so it is never forgotten.
 */
export function ChatRiskyModeMarker({ setting }: { setting: AgentChatConfigOption | undefined }) {
  if (!setting) return null;
  const label = `${isRiskyMode(setting) ? 'Permissions' : setting.name}: ${choiceName(setting)}`;
  return <span role="img" aria-label={label} title={label} className="chat-risk"><ShieldOff aria-hidden /></span>;
}

function PhoneSetting({ control, title, first, disabled, configure }: { control: AgentChatConfigOption; title: string; first: boolean; disabled: boolean; configure: Configure }) {
  const toggle = onOffValues(control);
  if (toggle) {
    const on = control.currentValue === toggle.on;
    const id = `chat-setting-${control.id}`;
    // The whole row is the switch's label, so the row is the target and names it.
    return <label htmlFor={id} className="chat-choice">
      <span>{title}</span>
      <Toggle id={id} checked={on} disabled={disabled} onChange={next => configure(control.id, next ? toggle.on : toggle.off)} />
    </label>;
  }
  return <fieldset className="chat-choice-group" disabled={disabled}>
    <legend>{title}</legend>
    {control.options.map(option => {
      const checked = option.value === control.currentValue;
      return <label key={option.value} className="chat-choice">
        <input type="radio" className="sr-only" name={`chat-setting-${control.id}`} checked={checked}
          // The sheet opens on the current model, not the first choice in the list.
          data-autofocus={first && checked ? '' : undefined}
          onChange={() => configure(control.id, option.value)}
          // The menu moves between items with the arrows; inside a group they pick a choice.
          onKeyDown={event => { if (event.key.startsWith('Arrow')) event.stopPropagation(); }} />
        <span>{option.name}</span>
        {checked && <Check className="chat-choice-check" aria-hidden />}
      </label>;
    })}
  </fieldset>;
}

/**
 * The phone's model button (D-118): plain text, the model then its effort muted, like ChatGPT's.
 * Its sheet lists Model, Effort, the agent's other settings and Permissions, each choice with a check.
 */
export function ChatPhoneModelMenu({ arranged, disabled, configure }: { arranged: ComposerControls; disabled: boolean; configure: Configure }) {
  const settings = phoneSettingsOrder(arranged);
  if (!settings.length) return null;
  const summary = modelSummary(arranged);
  const labels = triggerLabels(arranged);
  return <Dropdown className="chat-anchor" position="top-right" width="auto" items={[]} formLabel="Model and options" menuClassName="chat-phone-menu"
    trigger={<button type="button" disabled={disabled} title={summary} className="chat-phone-model">
      <span className="sr-only">Model and options: </span>
      {labels.model || labels.effort
        ? <>{labels.model && <span className="chat-phone-model-name">{labels.model}</span>}{labels.effort && <span className="chat-phone-model-effort">{labels.effort}</span>}</>
        : <span className="chat-phone-model-name">{summary}</span>}
    </button>}
    footer={<div className="chat-choices" onKeyDown={stayInFields}>
      {settings.map(({ control, title }, index) => <PhoneSetting key={control.id} control={control} title={title} first={index === 0} disabled={disabled} configure={configure} />)}
    </div>} />;
}
