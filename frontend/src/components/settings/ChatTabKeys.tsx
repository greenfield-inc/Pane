import { useEffect, useState } from 'react';
import type { ChatAgent, ChatTabKeyStatus } from '../../../../shared/types/chatTab';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

const AGENTS: Array<{ id: ChatAgent; label: string; env: string }> = [
  { id: 'claude', label: 'Anthropic API key (Claude)', env: 'ANTHROPIC_API_KEY' },
  { id: 'codex', label: 'OpenAI API key (Codex)', env: 'OPENAI_API_KEY' },
];

/**
 * Chat tabs run the person's own claude and codex under each machine's own
 * sign-in (D-14). An API key is optional, stays in this machine's secure store,
 * and is never shown again once saved.
 */
export function ChatTabKeys() {
  const [status, setStatus] = useState<ChatTabKeyStatus | undefined>();
  const [drafts, setDrafts] = useState<Record<ChatAgent, string>>({ claude: '', codex: '' });
  const [error, setError] = useState<string>();
  useEffect(() => { void window.electronAPI.chatTab.keys().then(setStatus, cause => setError(ipcErrorMessage(cause, 'Pane could not read the key status.'))); }, []);
  const save = async (agent: ChatAgent, key: string | null) => {
    try {
      setStatus(await window.electronAPI.chatTab.setKey(agent, key));
      setDrafts(current => ({ ...current, [agent]: '' }));
      setError(undefined);
    } catch (cause) { setError(ipcErrorMessage(cause, 'The key was not saved.')); }
  };
  return <div className="flex w-full flex-col gap-3">
    {AGENTS.map(agent => <div key={agent.id} className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{agent.label}{status?.[agent.id] ? ' · set on this machine' : ''}</span>
      <div className="flex gap-2">
        <Input type="password" autoComplete="off" aria-label={agent.label} title={`Passed to the agent as ${agent.env}`} placeholder={status?.[agent.id] ? 'Saved; type to replace' : 'Optional'} value={drafts[agent.id]} onChange={event => setDrafts(current => ({ ...current, [agent.id]: event.target.value }))} />
        <Button variant="secondary" size="sm" disabled={!drafts[agent.id].trim()} onClick={() => void save(agent.id, drafts[agent.id])}>Save</Button>
        {status?.[agent.id] && <Button variant="ghost" size="sm" onClick={() => void save(agent.id, null)}>Remove</Button>}
      </div>
    </div>)}
    {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
  </div>;
}
