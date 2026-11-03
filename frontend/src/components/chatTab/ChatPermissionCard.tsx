import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ShieldAlert } from 'lucide-react';
import type { AgentChatPermission } from '../../../../shared/types/agentChat';
import { permissionSummary } from '../../../../shared/chatTabPermissions';

/**
 * An approval docked above the composer (round 2 · Option 1). The choices are
 * exactly the ones the adapter sent; keys 1 to N answer while the composer is empty.
 * ExitPlanMode shows the plan itself with the adapter's approve and keep-planning choices.
 */
export function ChatPermissionCard({ permission, agent, machine, disabled, composerEmpty, onAnswer }: {
  permission: AgentChatPermission;
  agent: string;
  machine?: string;
  disabled: boolean;
  composerEmpty: boolean;
  onAnswer: (permission: AgentChatPermission, optionId: string) => void;
}) {
  const summary = permissionSummary(permission, agent);
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || !composerEmpty) return;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      if (target && target.closest('input:not(.chat-input), select, [contenteditable=true]')) return;
      const index = Number(event.key) - 1;
      const option = Number.isInteger(index) ? permission.options[index] : undefined;
      if (!option) return;
      event.preventDefault();
      onAnswer(permission, option.optionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composerEmpty, disabled, onAnswer, permission]);
  return <section aria-label={summary.heading} className="chat-approval" data-kind={summary.kind}>
    <p className="chat-approval-heading"><ShieldAlert aria-hidden="true" /><span>{summary.heading}</span>{machine && <span className="chat-approval-machine">on {machine}</span>}</p>
    {summary.plan
      ? <div className="chat-approval-plan chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.plan}</ReactMarkdown></div>
      : summary.detail && <pre className="chat-approval-detail">{summary.detail}</pre>}
    <div className="chat-approval-options">{permission.options.map((option, index) => <button key={option.optionId} type="button" disabled={disabled}
      className={`chat-button ${index === 0 ? 'chat-button-primary' : 'chat-button-outline'}`} onClick={() => onAnswer(permission, option.optionId)}>
      <span>{option.name}</span>{index < 9 && <kbd className="chat-key">{index + 1}</kbd>}
    </button>)}</div>
    <p className="chat-approval-hint">or type to tell {agent} what to do instead</p>
  </section>;
}
