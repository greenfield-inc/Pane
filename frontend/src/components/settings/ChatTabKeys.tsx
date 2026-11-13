import { useEffect, useState } from 'react';
import type { ChatAgent, ChatTabKeyStatus } from '../../../../shared/types/chatTab';
import { configuredAgent, configuredChatAgentIds } from '../../../../shared/agents';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** One key per chat agent whose config names the env vars its key goes in. */
const AGENTS = configuredChatAgentIds().flatMap(id => {
  const agent = configuredAgent(id);
  const env = agent.chat?.apiKeyEnv ?? [];
  return env.length ? [{ id, label: `${agent.label} API key`, env: env.join(' and ') }] : [];
});

/**
 * Chat tabs run the person's own agent CLIs under each machine's own sign-in (D-14). An API key
 * is optional, stays in this machine's secure store, and is never shown again once saved.
 */
/** `removeOnly` (Chat tabs off): saved keys can be removed, and nothing new saved. */
export function ChatTabKeys({ removeOnly = false, onRemovedAll }: { removeOnly?: boolean; onRemovedAll?: () => void }) {
  const [status, setStatus] = useState<ChatTabKeyStatus | undefined>();
  const [drafts, setDrafts] = useState<Record<ChatAgent, string>>(() => Object.fromEntries(AGENTS.map(agent => [agent.id, ''])));
  const [error, setError] = useState<string>();
  useEffect(() => { void window.electronAPI.chatTab.keys().then(setStatus, cause => setError(ipcErrorMessage(cause, 'Pane could not read the key status.'))); }, []);
  const save = async (agent: ChatAgent, key: string | null) => {
    try {
      const next = await window.electronAPI.chatTab.setKey(agent, key);
      setStatus(next);
      if (!Object.values(next).some(Boolean)) onRemovedAll?.();
      setDrafts(current => ({ ...current, [agent]: '' }));
      setError(undefined);
    } catch (cause) { setError(ipcErrorMessage(cause, 'The key was not saved.')); }
  };
  return <div className="flex w-full flex-col gap-3">
    {AGENTS.filter(agent => !removeOnly || status?.[agent.id]).map(agent => {
      const draft = drafts[agent.id];
      return <div key={agent.id} className="flex flex-col gap-1">
        <span className="text-xs font-medium text-text-secondary">{agent.label}{status?.[agent.id] ? ' · set on this machine' : ''}</span>
        <div className="flex gap-2">
          {!removeOnly && <Input type="password" autoComplete="off" aria-label={agent.label} title={`Passed to the agent as ${agent.env}`} placeholder={status?.[agent.id] ? 'Saved; type to replace' : 'Optional'} value={draft} onChange={event => setDrafts(current => ({ ...current, [agent.id]: event.target.value }))} />}
          {!removeOnly && <Button variant="secondary" size="sm" disabled={!draft.trim()} onClick={() => void save(agent.id, draft)}>Save</Button>}
          {status?.[agent.id] && <Button variant="ghost" size="sm" onClick={() => void save(agent.id, null)}>Remove</Button>}
        </div>
      </div>;
    })}
    {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
  </div>;
}
