import { useMemo, useState, useSyncExternalStore } from 'react';
import { Dropdown } from '../ui/Dropdown';
import type { AgentChatClient } from '../../../../shared/types/agentChat';
import { agentChatViewer } from '../../services/agentChatViewer';
import './agentChat.css';

/** The conversation's status line; its context menu refreshes the view or shows diagnostics. */
export function AgentChatHeader({ panelId, client, connected = true }: { panelId: string; client: AgentChatClient; connected?: boolean }) {
  const viewer = useMemo(() => agentChatViewer(client, panelId), [client, panelId]);
  const { view } = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const [diagnostics, setDiagnostics] = useState(false);
  const conversation = view?.conversation;
  const status = !connected ? 'Reconnecting…' : view?.permissions.length ? 'Waiting for you' : view?.running ? 'Agent is working' : '';
  return <Dropdown className="contents" contextMenu menuLabel="Conversation actions" closeOnSelect={false}
    items={[
      { id: 'refresh', label: 'Refresh conversation', onClick: () => void viewer.refresh() },
      { id: 'diagnostics', label: 'Diagnostics', onClick: () => setDiagnostics(value => !value) },
    ]}
    footer={diagnostics ? <pre className="agent-chat chat-diagnostics max-h-64 overflow-auto p-3 text-xs">{JSON.stringify({ conversation, configuration: view?.configuration, updates: view?.transcript?.messages.filter(message => message.id.startsWith('update:')) }, null, 2)}</pre> : undefined}
    trigger={<div className="agent-chat chat-header">
      {status && <div className="chat-header-state"><span role="status" className="chat-status">{status}</span></div>}
    </div>} />;
}
