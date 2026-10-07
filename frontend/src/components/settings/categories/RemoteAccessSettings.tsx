import { useState } from 'react';
import { ExternalLink, Plus, Server, Terminal, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Textarea } from '../../ui/Input';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { RemoteAccessSubviewId } from '../../../types/settings';
import type { RemoteAccessController } from '../useRemoteAccessSettings';
import { CodelessRemoteSettings } from '../CodelessRemoteSettings';

interface RemoteAccessSettingsProps {
  controller: RemoteAccessController;
  onOpenSubview: (subview: RemoteAccessSubviewId) => void;
}

export function RemoteAccessSettings({ controller, onOpenSubview }: RemoteAccessSettingsProps) {
  const { connectionState } = controller;
  const remote = connectionState.mode === 'remote';

  return (
    <SettingsPage title="Remote Access" description="Use Pane on your other computers.">
      {controller.loading && (
        <p className="text-sm text-text-tertiary" aria-live="polite">Loading Remote Pane status...</p>
      )}
      {controller.error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">
          <span>{controller.error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void controller.reload()}>Retry</Button>
        </div>
      )}
      {remote && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border-secondary p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">
              {connectionState.status === 'connected'
                ? `Connected to ${connectionState.activeProfileLabel ?? 'remote Pane'}`
                : `${connectionState.activeProfileLabel ?? 'Remote Pane'}: ${connectionState.status}`}
            </p>
            {connectionState.lastError && <p className="text-xs text-status-error">{connectionState.lastError}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {connectionState.lastError?.toLowerCase().includes('tailscale') && (
              <>
                <Button type="button" variant="ghost" size="sm" icon={<Terminal className="h-4 w-4" />} onClick={() => controller.openSetupTerminal(true)}>Open Tailscale Setup</Button>
                <Button type="button" variant="ghost" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}>Download Tailscale</Button>
              </>
            )}
            <Button type="button" variant="secondary" size="sm" disabled={controller.busy} onClick={() => void controller.useLocal()}>
              Use This Computer
            </Button>
          </div>
        </div>
      )}
      <CodelessRemoteSettings
        connectionState={connectionState}
        otherHosts={<CodeHosts controller={controller} />}
        accessFooter={(
          <SettingRow
            settingId="remote-pane"
            label="Connection codes"
            description="For browsers, phones, and other Tailscale accounts."
            align="start"
          >
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" icon={<Server className="h-4 w-4" />} onClick={() => onOpenSubview('host-setup')}>
                Set Up Host
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenSubview('advanced-host')}>
                Advanced
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<ExternalLink className="h-4 w-4" />}
                onClick={() => window.electronAPI.openExternal('https://runpane.com/docs/remote-daemon')}
              >
                Docs
              </Button>
            </div>
          </SettingRow>
        )}
      />
    </SettingsPage>
  );
}

/** Hosts saved from connection codes, plus pasting a new code. */
function CodeHosts({ controller }: { controller: RemoteAccessController }) {
  const [adding, setAdding] = useState(false);
  const { connectionState } = controller;
  const hosts = controller.config.client.profiles.filter((profile) => !profile.tailnetMachine);

  return (
    <>
      {hosts.map((profile) => {
        const active = connectionState.mode === 'remote' && connectionState.activeProfileId === profile.id;
        return (
          <div key={profile.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid={`code-host-${profile.id}`}>
            <div className="flex min-w-0 items-start gap-3">
              <Server className="mt-0.5 h-4 w-4 flex-none text-text-tertiary" aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{profile.label}</p>
                <p className="truncate text-xs text-text-tertiary">{profile.baseUrl}</p>
              </div>
            </div>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant={active ? 'secondary' : 'primary'} disabled={active || controller.busy} onClick={() => void controller.useProfile(profile.id)}>
                {active ? 'Connected' : 'Connect'}
              </Button>
              <IconButton type="button" size="sm" variant="ghost" aria-label={`Delete ${profile.label}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => void controller.deleteProfile(profile.id)} />
            </div>
          </div>
        );
      })}
      {adding ? (
        <form
          className="space-y-2 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void controller.importConnection().then((imported) => { if (imported) setAdding(false); }).catch(() => undefined);
          }}
        >
          <Textarea
            label="Connection Code"
            value={controller.connectionCode}
            onChange={(event) => controller.setConnectionCode(event.target.value)}
            placeholder="pane-remote://..."
            rows={3}
            fullWidth
            autoFocus
            className="ph-no-capture"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => { controller.setConnectionCode(''); setAdding(false); }}>Cancel</Button>
            <Button type="submit" size="sm" loading={controller.busy} disabled={!controller.connectionCode.trim()}>Connect</Button>
          </div>
        </form>
      ) : (
        <div className="py-2">
          <Button type="button" variant="ghost" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add with a Code
          </Button>
        </div>
      )}
    </>
  );
}
