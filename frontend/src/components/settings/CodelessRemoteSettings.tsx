import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { AppleIcon, LinuxIcon, WindowsIcon } from '../ui/BrandIcons';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SettingsSection } from '../ui/SettingsSection';
import { SettingRow } from './SettingRow';
import { settingDomId } from './catalog';
import { SegmentedControl } from './SettingsControls';
import { API } from '../../utils/api';
import { useConfigStore } from '../../stores/configStore';
import {
  WORKSPACE_PASSWORD_MIN_LENGTH,
  type TailnetMachine,
  type TailnetMachineList,
  type WorkspaceAccessSummary,
  type WorkspaceAccessUpdate,
  type WorkspaceVisibility,
} from '../../../../shared/types/workspaceAccess';
import type { RemotePaneConnectionState } from '../../../../shared/types/remoteDaemon';

/** Machines come and go, and a tailnet switch changes the whole list; refresh while it is on screen. */
const MACHINE_REFRESH_MS = 30_000;

const VISIBILITY_OPTIONS: ReadonlyArray<{ id: WorkspaceVisibility; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'owner', label: 'Only me' },
  { id: 'tailnet', label: 'Everyone on tailnet' },
];

const OS_ICONS = {
  macOS: AppleIcon,
  Windows: WindowsIcon,
  Linux: LinuxIcon,
} satisfies Record<TailnetMachine['os'], typeof AppleIcon>;

const STATE_TEXT = {
  available: 'Ready',
  'password-required': 'Needs password',
  outdated: 'Older Pane',
  unreachable: 'Pane not open',
  offline: 'Offline',
} satisfies Record<TailnetMachine['state'], string>;

interface CodelessRemoteSettingsProps {
  connectionState: RemotePaneConnectionState;
  /** Hosts saved from connection codes, listed with the Tailscale machines. */
  otherHosts?: ReactNode;
  /** The last row of the access section. */
  accessFooter?: ReactNode;
}

/**
 * Codeless remote access over Tailscale: the machines this app can connect to with one click,
 * and who may connect to this machine (visibility, plus an optional password).
 */
export function CodelessRemoteSettings({ connectionState, otherHosts, accessFooter }: CodelessRemoteSettingsProps) {
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const [access, setAccess] = useState<WorkspaceAccessSummary | null>(null);
  const [machines, setMachines] = useState<TailnetMachineList | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingVisibility, setPendingVisibility] = useState<WorkspaceVisibility | null>(null);
  const [passwordDraft, setPasswordDraft] = useState<string | null>(null);
  const [connectPassword, setConnectPassword] = useState<{ name: string; value: string } | null>(null);
  const mounted = useRef(true);

  const refreshMachines = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await API.remoteDaemon.listTailnetMachines();
      if (!mounted.current) return;
      if (response.success && response.data) setMachines(response.data);
      else setError(response.error ?? 'Could not list your machines.');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, 'Could not list your machines.'));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void API.remoteDaemon.getWorkspaceAccess().then((response) => {
      if (!mounted.current) return;
      if (response.success && response.data) setAccess(response.data);
      else setError(response.error ?? 'Could not read who can connect to this machine.');
    }).catch((cause: unknown) => {
      if (mounted.current) setError(errorMessage(cause, 'Could not read who can connect to this machine.'));
    });
    void refreshMachines();
    const timer = window.setInterval(() => void refreshMachines(), MACHINE_REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refreshMachines]);

  const updateAccess = async (update: WorkspaceAccessUpdate): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await API.remoteDaemon.updateWorkspaceAccess(update);
      if (!response.success || !response.data) {
        setError(response.error ?? 'Could not change who can connect to this machine.');
        return false;
      }
      setAccess(response.data);
      return true;
    } catch (cause) {
      setError(errorMessage(cause, 'Could not change who can connect to this machine.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const chooseVisibility = (visibility: WorkspaceVisibility) => {
    if (visibility === access?.visibility) return;
    // Widening to the whole tailnet always needs an explicit, warned confirmation.
    if (visibility === 'tailnet') {
      setPendingVisibility('tailnet');
      return;
    }
    setPendingVisibility(null);
    void updateAccess({ visibility });
  };

  const connect = async (machine: TailnetMachine, password?: string) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await API.remoteDaemon.saveTailnetMachine({ name: machine.name, password });
      if (!saved.success || !saved.data) {
        setError(saved.error ?? `Could not connect to ${machine.name}.`);
        return;
      }
      const switched = await API.remoteDaemon.updateClientState({ activeProfileId: saved.data.id, mode: 'remote' });
      if (!switched.success) {
        setError(switched.error ?? `Could not connect to ${machine.name}.`);
        return;
      }
      setConnectPassword(null);
      await fetchConfig().catch(() => undefined);
      void refreshMachines();
    } catch (cause) {
      setError(errorMessage(cause, `Could not connect to ${machine.name}.`));
    } finally {
      setBusy(false);
    }
  };

  const confirmTailnetVisibility = async () => {
    if (await updateAccess({ visibility: 'tailnet' })) setPendingVisibility(null);
  };

  const savePassword = async () => {
    if (passwordDraft !== null && await updateAccess({ password: passwordDraft })) setPasswordDraft(null);
  };

  const tailnetName = machines?.ok ? machines.tailnet : null;
  const visibility = pendingVisibility ?? access?.visibility ?? 'owner';
  const passwordValid = passwordDraft !== null && passwordDraft.length >= WORKSPACE_PASSWORD_MIN_LENGTH;

  return (
    <>
      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">
          <span>{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      )}

      <SettingsSection title="Your computers">
        <div id={settingDomId('remote-machines')} data-setting-id="remote-machines" tabIndex={-1} className="flex items-center justify-between gap-3 py-2 outline-none">
          <p className="text-xs text-text-tertiary">{tailnetName ? `On ${tailnetName}` : 'On Tailscale'}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />}
            onClick={() => void refreshMachines()}
            disabled={refreshing}
          >
            Refresh
          </Button>
        </div>
        {machines && !machines.ok && (
          <p className="py-3 text-sm text-text-secondary">{machines.reason}. {machines.fix}</p>
        )}
        {machines?.ok && machines.machines.length === 0 && (
          <p className="py-3 text-sm text-text-tertiary">Open Pane on another computer on your Tailscale login to see it here.</p>
        )}
        {machines?.ok && machines.machines.map((machine) => {
          // A failed or reconnecting connection is not "Connected": Connect stays available to retry.
          const active = connectionState.status === 'connected'
            && connectionState.activeProfileId === machine.profileId
            && machine.profileId !== undefined;
          const connectable = machine.state === 'available' || machine.state === 'outdated';
          const askingPassword = connectPassword?.name === machine.name;
          const OsIcon = OS_ICONS[machine.os];
          return (
            <div key={machine.dnsName} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid={`tailnet-machine-${machine.name}`}>
              <div className="flex min-w-0 items-start gap-3">
                <span role="img" aria-label={machine.os} title={machine.os} className="mt-0.5 flex-none text-text-tertiary">
                  <OsIcon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{machine.name}</p>
                  <p className="text-xs text-text-tertiary">
                    {[
                      STATE_TEXT[machine.state],
                      machine.visibility === 'tailnet' && 'Shared with tailnet',
                      !machine.mine && machine.ownerLogin,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
              {askingPassword ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect(machine, connectPassword.value);
                  }}
                >
                  <Input
                    type="password"
                    aria-label={`Password for ${machine.name}`}
                    placeholder="Password"
                    value={connectPassword.value}
                    onChange={(event) => setConnectPassword({ name: machine.name, value: event.target.value })}
                    autoFocus
                    className="ph-no-capture"
                  />
                  <Button type="submit" size="sm" loading={busy} disabled={!connectPassword.value}>Connect</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConnectPassword(null)}>Cancel</Button>
                </form>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant={active ? 'secondary' : 'primary'}
                  disabled={active || busy || (!connectable && machine.state !== 'password-required')}
                  onClick={() => (machine.state === 'password-required'
                    ? setConnectPassword({ name: machine.name, value: '' })
                    : void connect(machine))}
                >
                  {active ? 'Connected' : 'Connect'}
                </Button>
              )}
            </div>
          );
        })}
        {otherHosts}
      </SettingsSection>

      <SettingsSection title="Access to this computer">
        <SettingRow
          settingId="remote-visibility"
          label="Who can connect"
          description={describeAccess(access)}
          align="start"
        >
          <div className="w-full space-y-3 sm:w-[420px]">
            <SegmentedControl<WorkspaceVisibility>
              label="Who can connect to this computer"
              columns={3}
              value={visibility}
              options={VISIBILITY_OPTIONS}
              onChange={chooseVisibility}
            />
            {pendingVisibility === 'tailnet' && (
              <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-text-primary" role="alert">
                <p className="flex items-start gap-2 font-medium">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-status-warning" />
                  Anyone on {tailnetName ?? 'this tailnet'} can connect
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  They can run agents and commands on this computer. Add a password to limit who gets in.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPendingVisibility(null)}>Cancel</Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={busy}
                    onClick={() => void confirmTailnetVisibility()}
                  >
                    Allow Everyone
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SettingRow>
        <SettingRow
          settingId="remote-password"
          label="Password"
          description={access?.passwordProtected
            ? 'On. Every device enters it to connect.'
            : 'Ask every device for a password.'}
          align="start"
        >
          {passwordDraft === null ? (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={busy || access === null} onClick={() => setPasswordDraft('')}>
                {access?.passwordProtected ? 'Change' : 'Set Password'}
              </Button>
              {access?.passwordProtected && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void updateAccess({ password: null })}>
                  Remove
                </Button>
              )}
            </div>
          ) : (
            <form
              className="w-full space-y-2 sm:w-[320px]"
              onSubmit={(event) => {
                event.preventDefault();
                if (passwordValid) void savePassword();
              }}
            >
              <Input
                type="password"
                label="Password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                error={passwordDraft && !passwordValid ? `At least ${WORKSPACE_PASSWORD_MIN_LENGTH} characters` : undefined}
                autoFocus
                fullWidth
                className="ph-no-capture"
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setPasswordDraft(null)}>Cancel</Button>
                <Button type="submit" size="sm" loading={busy} disabled={!passwordValid}>Save</Button>
              </div>
            </form>
          )}
        </SettingRow>
        {accessFooter}
      </SettingsSection>
    </>
  );
}

function describeAccess(access: WorkspaceAccessSummary | null): string {
  if (!access) return 'Checking Tailscale…';
  if (access.state === 'off' && access.visibility !== 'off') return `${access.reason ?? 'Not running'}. ${access.fix ?? ''}`.trim();
  if (access.visibility === 'off') return 'Connection codes only.';
  return access.visibility === 'tailnet' ? 'Anyone on this tailnet.' : 'Your devices on Tailscale.';
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
