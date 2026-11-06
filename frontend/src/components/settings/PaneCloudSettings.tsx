import { useState, type ReactNode } from 'react';
import { ExternalLink, LogIn, Plus } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmDialog } from '../ConfirmDialog';
import { SettingRow } from './SettingRow';
import { RemoteGroup } from './RemoteGroup';
import { CARD_ROW } from './CodelessRemoteSettings';
import { API } from '../../utils/api';
import { usePaneCloud } from '../../hooks/usePaneCloud';
import { paneCloudBudget, paneCloudOperationLabel, paneCloudStateLabel, paneCloudStopReason } from '../../utils/paneCloudPresentation';
import type { PaneCloudMachineView, PaneCloudSnapshot } from '../../../../shared/types/paneCloud';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Pane Cloud in Add cloud sandbox: GitHub sign-in (identity only), the seat's one machine, and the
 * link that joins it to the user's tailnet. Pane connects to it over Tailscale once it has joined.
 */
export function PaneCloudSettings({ onOpenMachine }: { onOpenMachine?: (machineId: string) => void }) {
  const { snapshot, loaded, run } = usePaneCloud();
  const { signIn, machine, busy, error } = snapshot;

  if (!loaded) return <p className="py-3 text-sm text-text-tertiary" aria-live="polite">Loading Pane Cloud...</p>;

  return (
    <div className="space-y-1">
      {error && (
        <div className="my-2 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary" role="alert">
          <p>{error.message}</p>
          {error.next && <p className="mt-1 text-text-secondary">{error.next}</p>}
        </div>
      )}
      {signIn.state === 'signed-out' && (
        <SettingRow
          settingId="remote-pane-cloud"
          label="Pane Cloud"
          description="An always-on machine for your agents, run by Greenfield. Free during the invite-only beta. Sign-in proves your GitHub identity only; Pane Cloud never gets your GitHub or agent tokens."
          align="start"
        >
          <Button type="button" size="sm" icon={<LogIn className="h-4 w-4" />} loading={busy === 'sign-in'} onClick={() => void run(API.paneCloud.signIn)}>
            Sign In with GitHub
          </Button>
        </SettingRow>
      )}
      {signIn.state === 'pending' && <DeviceCodeRow userCode={signIn.userCode} verificationUri={signIn.verificationUri} onCancel={() => void run(API.paneCloud.signOut)} />}
      {signIn.state === 'signed-in' && (
        <>
          <SettingRow
            settingId="remote-pane-cloud"
            label="Pane Cloud account"
            description={signIn.access === 'waitlisted'
              ? "You're on the list. Pane Cloud is invite-only for now; you can create a machine once your invite arrives."
              : `Signed in as ${signIn.githubLogin}.`}
            align="start"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => void run(API.paneCloud.signOut)}>Sign Out</Button>
          </SettingRow>
          {signIn.access === 'invited' && !machine && <CreateMachineRow busy={busy === 'create'} onCreate={(name) => void run(() => API.paneCloud.create(name))} />}
          {machine && <MachineRow machine={machine} busy={busy} run={run} onOpenMachine={onOpenMachine} />}
        </>
      )}
    </div>
  );
}

function DeviceCodeRow({ userCode, verificationUri, onCancel }: { userCode: string; verificationUri: string; onCancel: () => void }) {
  return (
    <SettingRow settingId="remote-pane-cloud" label="Sign in with GitHub" description="Enter this code on GitHub. Pane waits here until you approve." align="start">
      <div className="flex flex-col items-end gap-2">
        <code aria-label="One-time code" data-secret="github-device-code" className="font-mono text-lg font-semibold tracking-widest text-text-primary">{userCode}</code>
        <div className="flex gap-2">
          <Button type="button" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void window.electronAPI?.openExternal(verificationUri)}>
            Open GitHub
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </SettingRow>
  );
}

function CreateMachineRow({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState('dev');
  const valid = NAME_PATTERN.test(name);
  return (
    <SettingRow
      settingId="remote-pane-cloud-create"
      label="Add a Pane Cloud machine"
      description="One machine per seat: bursts to 8 vCPU and 16 GiB, 12 vCPU-hours a day, a 50 GB disk."
      align="start"
    >
      <div className="flex w-full flex-col gap-2">
        <Input label="Machine name" value={name} onChange={(event) => setName(event.target.value.trim())} error={valid ? undefined : 'Use lowercase letters, digits and dashes.'} fullWidth />
        <div className="flex justify-end">
          <Button type="button" size="sm" icon={<Plus className="h-4 w-4" />} loading={busy} disabled={!valid} onClick={() => onCreate(name)}>
            Create Machine
          </Button>
        </div>
      </div>
    </SettingRow>
  );
}

function MachineRow({ machine, busy, run, onOpenMachine }: {
  machine: PaneCloudMachineView;
  busy: PaneCloudSnapshot['busy'];
  run: ReturnType<typeof usePaneCloud>['run'];
  onOpenMachine?: (machineId: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const budget = machine.usage ? paneCloudBudget(machine.usage) : null;
  const running = machine.state === 'running';
  const details = [machine.tailnetHostname, machine.paneVersion && `Pane ${machine.paneVersion}`, budget?.used].filter(Boolean).join(' · ');
  return (
    <div className="space-y-3 py-3" aria-label={`Pane Cloud machine ${machine.name}`} role="group">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <span className="truncate">{machine.name}</span>
            <Badge variant={running ? 'success' : machine.state === 'error' ? 'error' : 'default'}>{paneCloudStateLabel(machine)}</Badge>
          </div>
          {details && <p className="truncate text-xs text-text-tertiary">{details}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {machine.profileId && onOpenMachine && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpenMachine(machine.profileId ?? '')}>Details</Button>
          )}
          {machine.state === 'stopped' && (
            <Button type="button" variant="secondary" size="sm" loading={busy === 'start'} onClick={() => void run(API.paneCloud.start)}>Start</Button>
          )}
          {running && (
            <Button type="button" variant="ghost" size="sm" loading={busy === 'stop'} onClick={() => void run(API.paneCloud.stop)}>Stop</Button>
          )}
          <Button type="button" variant="ghost" size="sm" className="text-status-error" loading={busy === 'delete'} onClick={() => setDeleting(true)}>Delete</Button>
        </div>
      </div>
      {budget?.throttled && <p className="text-sm text-status-warning">{budget.throttled}</p>}
      {machine.tailnetLoginUrl && (
        <div className="space-y-2 rounded-md border border-status-info/30 bg-status-info/10 p-3 text-sm" role="status">
          <p className="font-medium text-text-primary">Join {machine.name} to your tailnet</p>
          <p className="text-text-secondary">Open the Tailscale login and sign in with your own account. {machine.name} joins as a device you own, and Pane connects to it as soon as it does.</p>
          <Button type="button" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void window.electronAPI?.openExternal(machine.tailnetLoginUrl ?? '')}>
            Open Tailscale Login
          </Button>
        </div>
      )}
      <ConfirmDialog
        isOpen={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => void run(API.paneCloud.remove)}
        title={`Delete ${machine.name}?`}
        message="This deletes the machine and its disk. Anything on it that you haven't pushed is lost."
        confirmText="Delete"
      />
    </div>
  );
}

/**
 * The Pane Cloud part of a machine's page: its daily CPU budget, Pane version, and every operation
 * run on it, with who asked and why (D-6: every operation is visible to the machine's user).
 */
export function PaneCloudMachineGroups({ machineId }: { machineId: string }) {
  const { snapshot, loaded, run } = usePaneCloud();
  const machine = snapshot.machine?.id === machineId ? snapshot.machine : null;
  if (!loaded) return null;
  if (!machine) {
    return (
      <RemoteGroup title="Pane Cloud">
        <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>
          {snapshot.signIn.state === 'signed-in' ? 'Pane Cloud no longer lists this machine.' : 'Sign in to Pane Cloud in Remote Access to see this machine’s budget and actions.'}
        </p>
      </RemoteGroup>
    );
  }
  const budget = machine.usage ? paneCloudBudget(machine.usage) : null;
  return (
    <>
      {snapshot.error && (
        <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary" role="alert">
          {snapshot.error.message} {snapshot.error.next}
        </div>
      )}
      <RemoteGroup title="Pane Cloud">
        <PaneCloudRow label="State" detail={machine.stateReason ? `Last stopped: ${paneCloudStopReason(machine.stateReason)}` : undefined}>
          <span className="text-sm text-text-secondary">{paneCloudStateLabel(machine)}</span>
          {machine.state === 'stopped' && <Button type="button" variant="secondary" size="sm" loading={snapshot.busy === 'start'} onClick={() => void run(API.paneCloud.start)}>Start</Button>}
          {machine.state === 'running' && <Button type="button" variant="ghost" size="sm" loading={snapshot.busy === 'stop'} onClick={() => void run(API.paneCloud.stop)}>Stop</Button>}
        </PaneCloudRow>
        <PaneCloudRow label="Daily CPU budget" detail={budget?.throttled ?? 'Bursts to 8 vCPU; past 12 vCPU-hours in a UTC day it runs at 0.5 vCPU until midnight UTC.'}>
          <span className="text-sm text-text-secondary">{budget?.used ?? 'Not measured yet'}</span>
        </PaneCloudRow>
        <PaneCloudRow label="Pane" detail="Updates install a published release, checked against its checksum.">
          <span className="text-sm text-text-secondary">{machine.paneVersion ?? 'Installing'}</span>
          <Button type="button" variant="ghost" size="sm" disabled={machine.state !== 'running'} loading={snapshot.busy === 'update'} onClick={() => void run(API.paneCloud.updatePane)}>Update Pane</Button>
        </PaneCloudRow>
      </RemoteGroup>
      <RemoteGroup title="Recent actions" footnote="Every operation Pane Cloud runs on this machine, newest first. Pane Cloud can run only these named operations; it has no shell on the machine.">
        {machine.actions.length === 0 && <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Nothing yet.</p>}
        <ul aria-label="Recent actions">
          {machine.actions.map((action) => (
            <li key={action.id} className={`flex items-start justify-between gap-3 ${CARD_ROW}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{paneCloudOperationLabel(action)}</p>
                <p className="text-xs text-text-tertiary">{action.reason}{action.error ? ` · ${action.error}` : ''}</p>
              </div>
              <div className="flex-none text-right text-xs text-text-tertiary">
                <p>By {action.actor}</p>
                <p><time dateTime={action.requestedAt}>{new Date(action.requestedAt).toLocaleString()}</time>{action.status === 'failed' ? ' · failed' : ''}</p>
              </div>
            </li>
          ))}
        </ul>
      </RemoteGroup>
    </>
  );
}

function PaneCloudRow({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="text-xs text-text-tertiary">{detail}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}
