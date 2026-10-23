import { useMemo, useState, useSyncExternalStore } from 'react';
import { MessageSquare, TerminalSquare } from 'lucide-react';
import { Dropdown } from '../ui/Dropdown';
import type { AgentChatClient, AgentInterface } from '../../../../shared/types/agentChat';
import { agentChatViewer } from '../../services/agentChatViewer';
import './agentChat.css';

/** A view choice on the existing host conversation, never a second agent. */
export function AgentChatHeader({ panelId, client, connected = true }: { panelId: string; client: AgentChatClient; connected?: boolean }) {
  const viewer = useMemo(() => agentChatViewer(client, panelId), [client, panelId]);
  const { view } = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const conversation = view?.conversation;
  const transitioning = !!conversation?.transition && conversation.active !== 'stopped';
  const focusMode = conversation?.nativeStartup ? 'terminal' : conversation?.active === 'stopped' ? 'terminal' : conversation?.active ?? 'chat';
  const change = async (mode: AgentInterface) => {
    if (!conversation) return;
    setBusy(true);
    try {
      if (conversation.active === 'stopped') await client.recover(panelId, mode, conversation.generation);
      else await client.switch(panelId, mode, conversation.generation);
      await viewer.refresh();
    } catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const status = conversation?.nativeStartup ? 'Waiting for native startup…' : conversation?.active === 'stopped' ? 'Conversation stopped' : transitioning ? 'Switching interface…' : !connected ? 'Reconnecting…' : conversation?.pendingSwitch ? `Switch to ${conversation.pendingSwitch.target === 'chat' ? 'Chat' : 'Terminal'} after this turn` : view?.permissions.length ? 'Waiting for you' : view?.running ? 'Agent is working' : '';
  return <Dropdown className="contents" contextMenu menuLabel="Conversation actions" closeOnSelect={false}
    items={[
      { id: 'refresh', label: 'Refresh conversation', onClick: () => void viewer.refresh() },
      { id: 'diagnostics', label: 'Diagnostics', onClick: () => setDiagnostics(value => !value) },
    ]}
    footer={diagnostics ? <pre className="agent-chat chat-diagnostics max-h-64 overflow-auto p-3 text-xs">{JSON.stringify({ conversation, configuration: view?.configuration, updates: view?.transcript?.messages.filter(message => message.id.startsWith('update:')) }, null, 2)}</pre> : undefined}
    trigger={<div className="agent-chat chat-header">
    <div className="chat-switch" role="radiogroup" aria-label="View this conversation as" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!options.length) return;
      event.preventDefault();
      const current = options.findIndex(option => option === document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length;
      options[index].focus();
      options[index].click();
    }}>
      {(['chat', 'terminal'] as const).map(mode => <button key={mode} type="button" role="radio" tabIndex={focusMode === mode ? 0 : -1} aria-checked={(conversation?.nativeStartup ? 'terminal' : conversation?.active) === mode} disabled={!connected || busy || !view?.available || transitioning} onClick={() => void change(mode)}>
        {mode === 'chat' ? <MessageSquare className="h-3.5 w-3.5" /> : <TerminalSquare className="h-3.5 w-3.5" />}{mode === 'chat' ? 'Chat' : 'Terminal'}
      </button>)}
    </div>
    {(status || conversation?.pendingSwitch) && <div className="chat-header-state">
      <span role="status" className="chat-status">{status}</span>
      {conversation?.pendingSwitch && <button type="button" className="chat-button" disabled={busy || !connected} onClick={() => void change(conversation.active === 'chat' ? 'chat' : 'terminal')}>Cancel pending switch</button>}
    </div>}
    {conversation?.transferNotice && <p role="status" className="chat-status">{conversation.transferNotice}</p>}
  </div>} />;
}
