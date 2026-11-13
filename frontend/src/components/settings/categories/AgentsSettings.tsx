import { useEffect } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { ChatAgentCapabilities, ChatAgentEntry } from '../../../../../shared/types/chatTab';
import type { RegistryAgent } from '../../../../../shared/types/agentRegistry';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { agentIcon } from '../../ui/brandIconRegistry';
import { refreshChatAgents, useChatAgentsStore } from '../../../stores/chatAgentsStore';
import { isChatTabsEnabled, useConfigStore } from '../../../stores/configStore';
import {
  cancelUnverifiedInstall, installRegistryAgent, refreshAgentRegistry, removeRegistryAgent, useAgentRegistryStore,
  type AgentRegistryState,
} from '../../../stores/agentRegistryStore';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ConfirmDialog';

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

function LabelList({ name, labels }: { name: string; labels: readonly string[] }) {
  return <ul aria-label={`What ${name} supports`} className="flex flex-wrap gap-1.5 pl-6">
    {labels.map(label => <li key={label} className="rounded-full border border-border-secondary bg-surface-secondary px-2 py-0.5 text-xs text-text-secondary">{label}</li>)}
  </ul>;
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
      details={<LabelList name={entry.label} labels={agentLabels(entry)} />}
    >
      {entry.installed
        ? entry.version && <span className="text-xs text-text-tertiary">Version {entry.version}</span>
        : <span className="flex items-center gap-3 text-xs">
          <span className="text-text-tertiary">Not installed</span>
          {entry.installUrl && <InstallLink url={entry.installUrl} />}
        </span>}
    </SettingRow>)}
  </div>;
}

/** What a registry row says about its agent: whether the registry still lists it, what Pane learned starting it, and how it runs. */
function registryLabels(agent: RegistryAgent, entry: ChatAgentEntry | undefined): string[] {
  const learned = agent.installedVersion && entry ? agentLabels(entry) : [];
  if (agent.listed === false) return ['No longer listed', ...learned];
  if (agent.kind === 'npx') return [...learned, 'Runs on Node.js'];
  return agent.verified ? learned : [...learned, 'No checksum'];
}

/** Install, Remove or Refresh; its spinner takes the label's place in the same box, so the row never moves. */
function RowAction({ label, busyLabel, busy, disabled, onClick }: { label: string; busyLabel: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return <Button type="button" size="sm" variant="secondary" className="w-20" disabled={disabled} aria-busy={busy} onClick={onClick}>
    <span className="flex h-5 items-center justify-center">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" role="img" aria-label={busyLabel} /> : label}
    </span>
  </Button>;
}

function installedStatus(agent: RegistryAgent, installed: string): string {
  if (agent.listed === false || installed === agent.version) return `Version ${installed}`;
  return `Version ${installed}, ${agent.version} on next launch`;
}

/**
 * One row per agent the ACP Registry offers this computer, with Install, or its installed version
 * and Remove. Installed agents show what the host's catalog learned about them; an installed agent
 * the registry no longer lists offers Remove only.
 */
export function RegistryAgentList({ state, catalog, canInstall, onInstall, onRemove }: {
  state: Pick<AgentRegistryState, 'list' | 'rows'>;
  catalog: readonly ChatAgentEntry[] | undefined;
  /** False while chat tabs are off: the list shows without Install. */
  canInstall: boolean;
  onInstall: (agent: RegistryAgent) => void;
  onRemove: (agent: RegistryAgent) => void;
}) {
  const { list, rows } = state;
  if (!list) return <p role="status" className="py-4 text-sm text-text-tertiary">Loading agents from the ACP Registry…</p>;
  return <>
    {list.error && <p role="status" className="mt-3 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary">
      This list may be out of date. {list.error}
    </p>}
    <div role="list" aria-label="ACP Registry agents" className="divide-y divide-border-secondary">
      {list.agents.map(agent => {
        const row = rows[agent.id] ?? {};
        const labels = registryLabels(agent, catalog?.find(entry => entry.id === agent.id));
        const { installedVersion } = agent;
        return <div key={agent.id} role="listitem" aria-label={agent.name}>
          <SettingRow
            label={agent.name}
            description={agent.description}
            disabled={!canInstall && !installedVersion}
            leading={<span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center text-text-secondary">{agentIcon(agent, 'h-4 w-4')}</span>}
            details={(labels.length > 0 || row.error) && <div className="space-y-2">
              {labels.length > 0 && <LabelList name={agent.name} labels={labels} />}
              {row.error && <p role="alert" className="pl-6 text-xs text-status-error">{row.error}</p>}
            </div>}
          >
            <span className="flex items-center gap-3 text-xs">
              {installedVersion
                ? <>
                  <span className="text-text-tertiary">{installedStatus(agent, installedVersion)}</span>
                  <RowAction label="Remove" busyLabel="Removing" busy={row.busy === 'remove'} disabled={row.busy !== undefined} onClick={() => onRemove(agent)} />
                </>
                : <>
                  <span className="text-text-tertiary">{agent.needs ? `Needs ${agent.needs}` : `Version ${agent.version}`}</span>
                  {canInstall && <RowAction label="Install" busyLabel="Installing" busy={row.busy === 'install'} disabled={row.busy !== undefined || agent.needs !== undefined} onClick={() => onInstall(agent)} />}
                </>}
            </span>
          </SettingRow>
        </div>;
      })}
    </div>
  </>;
}

/** Settings › Agents: the ACP Registry's agents, installed here with one click. */
function RegistrySection({ chatTabsOn }: { chatTabsOn: boolean }) {
  const client = window.electronAPI.chatTab;
  const state = useAgentRegistryStore();
  const catalog = useChatAgentsStore(store => store.entries);
  useEffect(() => { void refreshAgentRegistry(window.electronAPI.chatTab); }, []);
  const pending = state.confirmUnverified;
  return <SettingsSection
    title="More agents from the ACP Registry"
    description={chatTabsOn ? undefined : 'Chat tabs are off. Turn them on in AI & Agents to install these agents.'}
  >
    <RegistryAgentList
      state={state}
      catalog={catalog}
      canInstall={chatTabsOn}
      onInstall={agent => void installRegistryAgent(client, agent)}
      onRemove={agent => void removeRegistryAgent(client, agent)}
    />
    <div className="flex items-center justify-between gap-3 pt-2">
      <p className="text-xs text-text-tertiary">Installed agents move to the registry's new version on their next launch.</p>
      <RowAction label="Refresh" busyLabel="Refreshing" busy={state.reading === true} disabled={state.reading === true} onClick={() => void refreshAgentRegistry(client, true)} />
    </div>
    <ConfirmDialog
      isOpen={pending !== undefined}
      onClose={cancelUnverifiedInstall}
      onConfirm={() => { if (pending) void installRegistryAgent(client, pending, true); }}
      title={`Install ${pending?.name ?? 'this agent'} without a checksum?`}
      message="The ACP Registry publishes no checksum for this download, so Pane cannot check that the file is the one its makers released. Install it only if you trust its source."
      confirmText="Install anyway"
      variant="warning"
    />
  </SettingsSection>;
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
      <RegistrySection chatTabsOn={chatTabsOn} />
    </SettingsPage>
  );
}
