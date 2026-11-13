import { useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ChatAgentCapabilities, ChatAgentEntry } from '../../../../../shared/types/chatTab';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { agentIcon } from '../../ui/brandIconRegistry';
import { refreshChatAgents, useChatAgentsStore } from '../../../stores/chatAgentsStore';
import { isChatTabsEnabled, useConfigStore } from '../../../stores/configStore';

const CAPABILITY_LABELS: ReadonlyArray<[keyof ChatAgentCapabilities, string]> = [
  ['reopen', 'Reopens chats'],
  ['list', 'Lists past chats'],
  ['images', 'Images'],
];

const FULL_ACCESS_LABELS = {
  agent: 'Full access by agent',
  pane: 'Full access by Pane',
} satisfies Record<ChatAgentEntry['fullAccess'], string>;

function agentLabels(entry: ChatAgentEntry): string[] {
  return [...CAPABILITY_LABELS.filter(([key]) => entry.capabilities?.[key]).map(([, label]) => label), FULL_ACCESS_LABELS[entry.fullAccess]];
}

function InstallLink({ url }: { url: string }) {
  return <button type="button" onClick={() => window.electronAPI.openExternal(url)} className="inline-flex items-center gap-1 text-interactive hover:underline">
    Install
    <ExternalLink className="h-3 w-3" aria-hidden="true" />
  </button>;
}

/** One row per agent in the host's catalog: what it is, what it supports, and how to install it. */
export function AgentList({ agents }: { agents: readonly ChatAgentEntry[] }) {
  return <div id={settingDomId('chat-agents')} data-setting-id="chat-agents" tabIndex={-1} className="divide-y divide-border-secondary outline-none">
    {agents.map(entry => <SettingRow
      key={entry.id}
      label={entry.label}
      description={entry.description}
      leading={<span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center text-text-secondary">{agentIcon(entry, 'h-4 w-4')}</span>}
      details={<ul aria-label={`What ${entry.label} supports`} className="flex flex-wrap gap-1.5 pl-6">
        {agentLabels(entry).map(label => <li key={label} className="rounded-full border border-border-secondary bg-surface-secondary px-2 py-0.5 text-xs text-text-secondary">{label}</li>)}
      </ul>}
    >
      {entry.installed
        ? entry.version && <span className="text-xs text-text-tertiary">Version {entry.version}</span>
        // The ACP Registry's one-click install goes here.
        : <span className="flex items-center gap-3 text-xs">
          <span className="text-text-tertiary">Not installed</span>
          {entry.installUrl && <InstallLink url={entry.installUrl} />}
        </span>}
    </SettingRow>)}
  </div>;
}

/** Settings › Agents: the agents this machine can open as chat tabs. */
export function AgentsSettings() {
  const chatTabsOn = useConfigStore(state => isChatTabsEnabled(state.config));
  const agents = useChatAgentsStore(state => state.entries);
  const error = useChatAgentsStore(state => state.error);
  // Read again on every visit: an agent installed since the last read shows at once.
  useEffect(() => { void refreshChatAgents(window.electronAPI.chatTab); }, []);
  return (
    <SettingsPage title="Agents" description="The agents this machine can open as chat tabs. Pane learns what an agent supports the first time it starts a chat with it.">
      <SettingsSection title="Chat agents" description={chatTabsOn ? undefined : 'Chat tabs are off. Turn them on in AI & Agents to open these agents as chats.'}>
        {error && <p role="alert" className="py-2 text-sm text-status-error">{error}</p>}
        {agents ? <AgentList agents={agents} /> : !error && <p role="status" className="py-4 text-sm text-text-tertiary">Loading agents…</p>}
      </SettingsSection>
    </SettingsPage>
  );
}
