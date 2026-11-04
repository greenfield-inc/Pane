import { ChevronDown } from 'lucide-react';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';

export function AgentChatConfiguration({ controls, disabled, configure }: { controls: AgentChatConfigOption[]; disabled: boolean; configure: (id: string, value: string) => void }) {
  const summary = controls.map(control => control.options.find(option => option.value === control.currentValue)?.name ?? control.currentValue).join(' · ');
  const selectors = controls.map(control => <label key={control.id} className="chat-config-label">
    <span>{control.name}</span>
    <select aria-label={control.name} title={control.name} value={control.currentValue} disabled={disabled} className="chat-config" onChange={event => configure(control.id, event.target.value)} onKeyDown={event => {
      // The dropdown moves between menu items; the select owns option arrows.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.stopPropagation();
    }}>
      {control.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
    </select>
  </label>);
  return <>
    <div className="chat-config-expanded">{selectors}</div>
    <Dropdown className="chat-config-compact" position="top-left" width="md" items={[]} formLabel="Conversation configuration" trigger={<button type="button" disabled={disabled} aria-label="Conversation configuration" title={summary} className="chat-button"><span>{summary}</span><ChevronDown className="h-3 w-3 shrink-0" /></button>} footer={<div className="agent-chat chat-config-options" onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll('select:not(:disabled)')];
      const current = controls.findIndex(control => control === document.activeElement);
      const next = current + (event.shiftKey ? -1 : 1);
      // Tab between fields normally. At either edge, let the dropdown close
      // and return focus to its trigger.
      if (current >= 0 && next >= 0 && next < controls.length) event.stopPropagation();
    }}>{selectors}</div>} />
  </>;
}
