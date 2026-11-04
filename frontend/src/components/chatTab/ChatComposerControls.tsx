import type { KeyboardEvent } from 'react';
import { ChevronDown, FilePen, Hand, ListTodo, Shield, ShieldOff, Sparkles, type LucideIcon } from 'lucide-react';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';
import { choiceName, modelSummary, type ComposerControls } from './composerControls';

type Configure = (id: string, value: string) => void;

/** Claude Code's and Codex's permission modes; any other mode shows the plain shield. */
const MODE_ICONS = new Map<string, LucideIcon>([
  ['default', Hand], ['read-only', Hand], ['acceptEdits', FilePen], ['plan', ListTodo], ['auto', Sparkles],
  ['bypassPermissions', ShieldOff], ['dontAsk', ShieldOff], ['full-access', ShieldOff],
]);

/** The permission mode, as a quiet chip that opens the mode list. */
export function ChatModeChip({ control, disabled, configure }: { control: AgentChatConfigOption; disabled: boolean; configure: Configure }) {
  const Icon = MODE_ICONS.get(control.currentValue) ?? Shield;
  return <Dropdown position="top-left" width="md" selectedId={control.currentValue} selectedMark="check" menuLabel={control.name}
    items={control.options.map(option => ({ id: option.value, label: option.name, onClick: () => { if (option.value !== control.currentValue) configure(control.id, option.value); } }))}
    trigger={<button type="button" disabled={disabled} title={`${control.name}: ${choiceName(control)}`} className="chat-chip">
      <Icon className="chat-chip-icon" aria-hidden />
      <span className="sr-only">{control.name}: </span><span className="chat-chip-label">{choiceName(control)}</span>
    </button>} />;
}

/** Every setting in the model menu is a named field; Tab moves between them and leaves at either edge. */
function stayInFields(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return;
  const fields = [...event.currentTarget.querySelectorAll('select:not(:disabled)')];
  const current = fields.findIndex(field => field === document.activeElement);
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
  return <Dropdown position="top-right" width="lg" items={[]} formLabel="Model and options"
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
