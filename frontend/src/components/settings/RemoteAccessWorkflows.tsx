import { useEffect } from 'react';
import { ArrowLeft, Copy, Plus, Terminal, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Input } from '../ui/Input';
import { SettingsSection } from '../ui/SettingsSection';
import { SettingRow, SettingsPage } from './SettingRow';
import { SegmentedControl } from './SettingsControls';
import { SecretField } from './SecretField';
import type { RemoteAccessSubviewId } from '../../types/settings';
import type { RemoteAccessController } from './useRemoteAccessSettings';
import type { RemoteSetupTunnelPreference } from '../../../../shared/types/remoteDaemon';
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
  const configuredBaseUrl = formatRemoteBaseUrl(
    controller.config.host.config.listenHost,
    controller.config.host.config.listenPort,
  );
  const dirty = subview === 'host-setup'
    ? controller.setupDirty
    : JSON.stringify(controller.hostDraft) !== JSON.stringify(controller.config.host.config)
      || Boolean(controller.pairLabel || controller.profileLabel || controller.profileToken)
      || controller.pairBaseUrl !== configuredBaseUrl
      || controller.profileBaseUrl !== configuredBaseUrl;

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
        {subview === 'advanced-host' && <AdvancedHost controller={controller} />}
      </div>
    </div>
  );
}

function formatRemoteBaseUrl(host: string, port: number): string {
  const trimmedHost = host.trim();
  const normalizedHost = trimmedHost.includes(':') && !trimmedHost.startsWith('[') ? `[${trimmedHost}]` : trimmedHost;
  return `http://${normalizedHost}:${port}`;
}

function HostSetup({ controller }: { controller: RemoteAccessController }) {
  const activeCode = controller.setupResult?.connectionCode;
  const executableHealth = getRemoteExecutableHealthPresentation(controller.hostState.executableHealth);
  return (
    <SettingsPage title="Set Up This Machine" description="Host Pane here and create a connection code.">
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
          label={controller.hostState.status === 'live' ? 'Host is on' : 'Host is off'}
          description={controller.hostState.lastError ?? `${controller.hostState.connectedClients.length} connected`}
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
        <SettingRow settingId="remote-host-mode" label="Data" description="Current data runs while Pane is open. Isolated data can run as a background service." align="start">
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

function AdvancedHost({ controller }: { controller: RemoteAccessController }) {
  return (
    <SettingsPage title="Advanced Remote Host" description="Listener and manual pairing.">
      <SettingsSection title="Listener">
        <SettingRow settingId="remote-advanced-host" label="Host listener" description="What other devices connect to." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Checkbox label="Enable remote daemon listener" checked={controller.hostDraft.enabled} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, enabled: event.target.checked })} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Listen Host" value={controller.hostDraft.listenHost} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, listenHost: event.target.value })} placeholder="127.0.0.1" fullWidth />
              <Input label="Listen Port" type="number" value={String(controller.hostDraft.listenPort)} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, listenPort: Number.parseInt(event.target.value, 10) })} error={controller.validation.hostPort ? undefined : 'Port must be between 1 and 65535'} fullWidth />
            </div>
            <Checkbox label="Require pairing / saved bearer tokens" checked={controller.hostDraft.pairingRequired} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, pairingRequired: event.target.checked })} />
            <Checkbox label="Allow direct HTTP on loopback" checked={controller.hostDraft.allowInsecureHttpOnLoopback} onChange={(event) => controller.setHostDraft({ ...controller.hostDraft, allowInsecureHttpOnLoopback: event.target.checked })} />
            <div className="flex justify-end"><Button type="button" size="sm" disabled={!controller.validation.hostPort} loading={controller.busy} onClick={controller.saveHostConfig}>Apply Host Settings</Button></div>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Pairing tools">
        <SettingRow settingId="remote-paired-connection" label="Create paired connection" description="Create a token and a matching saved connection." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Input label="Connection Label" value={controller.pairLabel} onChange={(event) => controller.setPairLabel(event.target.value)} placeholder="Office Mac mini" fullWidth />
            <Input label="Remote Base URL" value={controller.pairBaseUrl} onChange={(event) => controller.setPairBaseUrl(event.target.value)} placeholder="http://127.0.0.1:42137" error={controller.pairBaseUrl && !controller.validation.pair ? 'Enter a label and valid HTTP(S) URL' : undefined} fullWidth />
            <div className="flex justify-end"><Button type="button" size="sm" icon={<Plus className="h-4 w-4" />} disabled={!controller.validation.pair} onClick={controller.createPair}>Create Paired Profile</Button></div>
            {controller.createdToken && (
              <SecretField label="Latest generated remote token" value={controller.createdToken} readOnly />
            )}
          </div>
        </SettingRow>
        <SettingRow settingId="remote-existing-profile" label="Save existing remote profile" description="Save a token from another host." align="start">
          <div className="w-full space-y-3 sm:w-[460px]">
            <Input label="Existing Profile Label" value={controller.profileLabel} onChange={(event) => controller.setProfileLabel(event.target.value)} placeholder="Office Mac mini tunnel" fullWidth />
            <Input label="Existing Remote Base URL" value={controller.profileBaseUrl} onChange={(event) => controller.setProfileBaseUrl(event.target.value)} placeholder="http://127.0.0.1:42137" fullWidth />
            <SecretField label="Existing Remote Token" value={controller.profileToken} onChange={controller.setProfileToken} onRemove={() => controller.setProfileToken('')} />
            <div className="flex justify-end"><Button type="button" size="sm" disabled={!controller.validation.profile} onClick={controller.saveProfile}>Save Remote Profile</Button></div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
