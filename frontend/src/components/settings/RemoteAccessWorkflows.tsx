import { DEFAULT_REMOTE_BASE_URL } from '../../utils/remote-base-url';
import { useEffect } from 'react';
import { ArrowLeft, Copy, ExternalLink, Plus, Terminal, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Input, Textarea } from '../ui/Input';
import { SettingsSection } from '../ui/SettingsSection';
import { SettingRow, SettingsPage } from './SettingRow';
import { SegmentedControl } from './SettingsControls';
import { SecretField } from './SecretField';
import type { RemoteAccessSubviewId } from '../../types/settings';
import type { RemoteAccessController } from './useRemoteAccessSettings';
import { DEFAULT_REMOTE_DAEMON_HOST_CONFIG, type RemoteSetupTunnelPreference } from '../../../../shared/types/remoteDaemon';
import { getRemoteExecutableHealthPresentation } from '../../utils/remoteRuntimePresentation';
import { useCommittedRef } from '../../hooks/useCommittedRef';

interface RemoteAccessWorkflowsProps {
  subview: RemoteAccessSubviewId;
  controller: RemoteAccessController;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function RemoteAccessWorkflows({ subview, controller, onBack, onDirtyChange }: RemoteAccessWorkflowsProps) {
  const resetDraftRef = useCommittedRef(controller.resetSubviewDraft);
  const dirty = subview === 'host-setup'
    ? controller.setupDirty
    : subview === 'connections'
      ? Boolean(controller.connectionCode)
      : controller.advancedDirty;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => {
    onDirtyChange(false);
    resetDraftRef.current(subview);
  }, [onDirtyChange, resetDraftRef, subview]);

  return (
    <div className="mx-auto w-full max-w-3xl pb-8">
      <Button type="button" variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack}>
        Back to Remote Access
      </Button>
      <div className="mt-5">
        {controller.error && <div className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">{controller.error}</div>}
        {controller.result && <div className="mb-4 rounded-md border border-status-success/30 bg-status-success/10 p-3 text-sm text-status-success" aria-live="polite">{controller.result}</div>}
        {subview === 'host-setup' && <HostSetup controller={controller} />}
        {subview === 'connections' && <Connections controller={controller} />}
        {subview === 'advanced-host' && <AdvancedHost controller={controller} />}
      </div>
    </div>
  );
}

function HostSetup({ controller }: { controller: RemoteAccessController }) {
  const activeCode = controller.setupResult?.connectionCode;
  const executableHealth = getRemoteExecutableHealthPresentation(controller.hostState.executableHealth);
  return (
    <SettingsPage title="Set Up This Machine" description="Configure this Pane install as a remote host and create a cross-device connection code.">
      <SettingsSection title="Host status">
        {executableHealth && (
          <div
            className={`mb-3 rounded-md border p-3 text-sm ${executableHealth.severity === 'error' ? 'border-status-error/30 bg-status-error/10 text-status-error' : 'border-status-warning/30 bg-status-warning/10 text-text-primary'}`}
            role="alert"
          >
            <p className="font-medium">{executableHealth.code}</p>
            <p className="mt-1">{executableHealth.message}</p>
            {executableHealth.recoveryCommand && <code className="mt-2 block select-all text-xs">{executableHealth.recoveryCommand}</code>}
          </div>
        )}
        <SettingRow
          settingId="remote-host-setup"
          label={controller.hostState.status === 'live' ? 'Remote host is live' : 'Remote host is not running'}
          description={controller.hostState.lastError ?? `${controller.hostState.connectedClients.length} connected client(s)`}
        >
          <div className="flex flex-wrap justify-end gap-2">
            {(controller.hostState.status === 'live' || controller.config.host.config.enabled) && (
              <Button type="button" variant="secondary" size="sm" onClick={controller.createHostCode} disabled={controller.busy}>Create & Copy Code</Button>
            )}
            {controller.hostState.connectedClients.length > 0 && (
              <Button type="button" variant="secondary" size="sm" onClick={() => controller.disconnectClients()} disabled={controller.busy}>Disconnect Clients</Button>
            )}
            {(controller.hostState.status === 'live' || controller.config.host.config.enabled) && (
              <Button type="button" variant="danger" size="sm" onClick={controller.stopHost} disabled={controller.busy}>Stop Host</Button>
            )}
            {controller.config.host.access && (
              <Button type="button" variant="ghost" size="sm" onClick={controller.clearHostAccess} disabled={controller.busy}>Forget Code</Button>
            )}
          </div>
        </SettingRow>
        {controller.config.host.clients.map((client) => (
          <div key={client.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{client.label}</p>
              <p className="text-xs text-text-tertiary">{client.lastUsedAt ? `Last used ${new Date(client.lastUsedAt).toLocaleString()}` : 'Never used'}</p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="secondary" size="sm" onClick={() => controller.disconnectClients([client.id])}>Disconnect</Button>
              <IconButton type="button" variant="danger" size="sm" aria-label={`Revoke ${client.label}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => controller.revokeClient(client.id)} />
            </div>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection title="Setup">
        <SettingRow settingId="remote-host-mode" label="Data and service mode" description="Use current Pane data while this app is open, or isolated daemon data with an optional background service." align="start">
          <div className="w-full space-y-4 sm:w-[460px]">
            <SegmentedControl
              label="Remote host data mode"
              value={controller.setupDataMode}
              options={[{ id: 'current', label: 'Current Pane Data' }, { id: 'isolated', label: 'Isolated Daemon Data' }]}
              onChange={controller.setSetupDataMode}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="This Machine Label" value={controller.setupLabel} onChange={(event) => controller.setSetupLabel(event.target.value)} placeholder="Office Mac mini" fullWidth />
              <Input
                label="Listen Port"
                type="number"
                value={String(controller.setupListenPort)}
                onChange={(event) => controller.setSetupListenPort(Number.parseInt(event.target.value, 10))}
                error={controller.validation.setupPort ? undefined : 'Port must be between 1 and 65535'}
                fullWidth
              />
            </div>
            {controller.setupDataMode === 'isolated' && (
              <div className="space-y-3">
                <Input label="Daemon Data Directory" value={controller.setupPaneDir} onChange={(event) => controller.setSetupPaneDir(event.target.value)} placeholder="~/.pane_remote" fullWidth />
                <Checkbox label="Install background service" checked={controller.setupInstallService} onChange={(event) => controller.setSetupInstallService(event.target.checked)} />
              </div>
            )}
            <SegmentedControl<RemoteSetupTunnelPreference>
              label="Remote host access mode"
              columns={3}
              value={controller.setupTunnelPreference}
              options={[{ id: 'tailscale', label: 'Tailscale' }, { id: 'ssh', label: 'SSH Tunnel' }, { id: 'manual', label: 'Manual HTTPS' }]}
              onChange={controller.setSetupTunnelPreference}
            />
            {controller.setupTunnelPreference === 'manual' && (
              <Input
                label="Manual HTTPS Base URL"
                value={controller.setupManualBaseUrl}
                onChange={(event) => controller.setSetupManualBaseUrl(event.target.value)}
                placeholder="https://pane-remote.example.com"
                error={controller.validation.manualBaseUrl ? undefined : 'A valid HTTPS URL is required'}
                fullWidth
              />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {controller.setupTunnelPreference === 'tailscale' && (
                <Button type="button" variant="secondary" size="sm" icon={<Terminal className="h-4 w-4" />} onClick={() => controller.openSetupTerminal(false)} disabled={controller.busy}>Open Guided Setup</Button>
              )}
              <Button type="button" size="sm" onClick={controller.setupHost} loading={controller.busy} disabled={!controller.validation.setupPort || !controller.validation.manualBaseUrl}>Create Connection Code</Button>
            </div>
            {activeCode && (
              <button
                type="button"
                className="ph-no-capture flex w-full items-center justify-between gap-2 rounded-md border border-border-secondary p-3 text-left hover:bg-surface-hover"
                onClick={() => controller.copyText(activeCode, 'Connection code copied.')}
              >
                <span className="min-w-0 truncate font-mono text-xs text-text-secondary">{activeCode}</span>
                <Copy className="h-4 w-4 flex-none" />
              </button>
            )}
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}

function Connections({ controller }: { controller: RemoteAccessController }) {
  return (
    <SettingsPage title="Connections" description="Connect this desktop app to a remote Pane host and manage saved profiles.">
      <SettingsSection title="Runtime">
        <SettingRow
          settingId="remote-connections"
          label={controller.connectionState.status === 'connected' ? `Connected to ${controller.connectionState.activeProfileLabel ?? 'remote Pane'}` : 'Using local runtime'}
          description={controller.connectionState.lastError ?? controller.connectionState.activeBaseUrl ?? 'Choose where worktrees, terminals, and agent commands run.'}
        >
          <Button type="button" variant="secondary" size="sm" onClick={controller.useLocal} disabled={controller.busy || controller.connectionState.mode === 'local'}>Use Local Runtime</Button>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Add connection">
        <SettingRow settingId="remote-connection-code" label="Connection code" description="Paste a pane-remote:// code created by the host." align="start">
          <div className="w-full space-y-2 sm:w-[460px]">
            <Textarea label="Connection Code" value={controller.connectionCode} onChange={(event) => controller.setConnectionCode(event.target.value)} placeholder="pane-remote://..." rows={3} fullWidth className="ph-no-capture" />
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={controller.importConnection} loading={controller.busy} disabled={!controller.connectionCode.trim()}>Import & Connect</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Saved profiles">
        {controller.config.client.profiles.length === 0 ? <p className="py-4 text-sm text-text-tertiary">No remote profiles saved.</p> : controller.config.client.profiles.map((profile) => {
          const active = controller.connectionState.activeProfileId === profile.id && controller.connectionState.status === 'connected';
          return (
            <div key={profile.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{profile.label}</p>
                <p className="truncate text-xs text-text-tertiary">{profile.baseUrl}</p>
              </div>
              <div className="flex gap-1">
                <Button type="button" size="sm" variant={active ? 'secondary' : 'primary'} disabled={active || controller.busy} onClick={() => controller.useProfile(profile.id)}>{active ? 'Connected' : 'Connect'}</Button>
                <IconButton type="button" size="sm" variant="danger" aria-label={`Delete ${profile.label}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => controller.deleteProfile(profile.id)} />
              </div>
            </div>
          );
        })}
      </SettingsSection>
      {controller.connectionState.lastError?.toLowerCase().includes('tailscale') && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" icon={<Terminal className="h-4 w-4" />} onClick={() => controller.openSetupTerminal(true)}>Open Tailscale Setup</Button>
          <Button type="button" variant="ghost" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}>Download Tailscale</Button>
        </div>
      )}
    </SettingsPage>
  );
}

function AdvancedHost({ controller }: { controller: RemoteAccessController }) {
  return (
    <SettingsPage title="Advanced Remote Host" description="Listener settings and manual pairing tools for experienced operators.">
      <SettingsSection title="Listener">
        <SettingRow settingId="remote-advanced-host" label="Host listener" description="Controls the HTTP/SSE listener for this machine." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Checkbox label="Enable remote daemon listener" checked={controller.hostDraft.enabled} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, enabled: event.target.checked })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Listen Host" value={controller.hostDraft.listenHost} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, listenHost: event.target.value })} placeholder={DEFAULT_REMOTE_DAEMON_HOST_CONFIG.listenHost} fullWidth />
              <Input label="Listen Port" type="number" value={String(controller.hostDraft.listenPort)} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, listenPort: Number.parseInt(event.target.value, 10) })} error={controller.validation.hostPort ? undefined : 'Port must be between 1 and 65535'} fullWidth />
            </div>
            <Checkbox label="Require pairing / saved bearer tokens" checked={controller.hostDraft.pairingRequired} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, pairingRequired: event.target.checked })} />
            <Checkbox label="Allow direct HTTP on loopback" checked={controller.hostDraft.allowInsecureHttpOnLoopback} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, allowInsecureHttpOnLoopback: event.target.checked })} />
            <div className="flex justify-end"><Button type="button" size="sm" disabled={!controller.validation.hostPort} loading={controller.busy} onClick={controller.saveHostConfig}>Apply Host Settings</Button></div>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Pairing tools">
        <SettingRow settingId="remote-paired-connection" label="Create paired connection" description="Mint a host token and save a matching local client profile." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Input label="Connection Label" value={controller.pairLabel} onChange={(event) => controller.setPairLabel(event.target.value)} placeholder="Office Mac mini" fullWidth />
            <Input label="Remote Base URL" value={controller.pairBaseUrl} onChange={(event) => controller.setPairBaseUrl(event.target.value)} placeholder={DEFAULT_REMOTE_BASE_URL} error={controller.pairBaseUrl && !controller.validation.pair ? 'Enter a label and valid HTTP(S) URL' : undefined} fullWidth />
            <div className="flex justify-end"><Button type="button" size="sm" icon={<Plus className="h-4 w-4" />} disabled={!controller.validation.pair} onClick={controller.createPair}>Create Paired Profile</Button></div>
            {controller.createdToken && (
              <SecretField label="Latest generated remote token" value={controller.createdToken} readOnly />
            )}
          </div>
        </SettingRow>
        <SettingRow settingId="remote-existing-profile" label="Save existing remote profile" description="Save a bearer token that was created on another host." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Input label="Existing Profile Label" value={controller.profileLabel} onChange={(event) => controller.setProfileLabel(event.target.value)} placeholder="Office Mac mini tunnel" fullWidth />
            <Input label="Existing Remote Base URL" value={controller.profileBaseUrl} onChange={(event) => controller.setProfileBaseUrl(event.target.value)} placeholder={DEFAULT_REMOTE_BASE_URL} fullWidth />
            <SecretField label="Existing Remote Token" value={controller.profileToken} onChange={controller.setProfileToken} onRemove={() => controller.setProfileToken('')} />
            <div className="flex justify-end"><Button type="button" size="sm" disabled={!controller.validation.profile} onClick={controller.saveProfile}>Save Remote Profile</Button></div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
