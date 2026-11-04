import type { AgentChatPermission } from '../../../../shared/types/agentChat';

export function AgentChatPermissions({ permissions, disabled, onAnswer, inline = false }: {
  permissions: AgentChatPermission[];
  disabled: boolean;
  inline?: boolean;
  onAnswer: (request: AgentChatPermission, optionId: string) => Promise<void>;
}) {
  return <>{permissions.map(permission => <section key={permission.id} aria-label="Agent permission request" className="chat-permission">
    {!inline && <p className="font-medium">{permission.title}</p>}
    {!inline && <details className="my-2"><summary>Request details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(permission.toolCall, null, 2)}</pre></details>}
    <div className="chat-permission-options">{permission.options.map(option => <button key={option.optionId} type="button" disabled={disabled} onClick={() => void onAnswer(permission, option.optionId)} className={`chat-button ${option.kind === 'allow_once' ? 'chat-button-primary' : 'chat-button-outline'}`}>{option.name}</button>)}</div>
  </section>)}</>;
}
