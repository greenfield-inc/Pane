import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Info, Plus, RefreshCw, Server, Smartphone, Terminal } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Input';
import { SettingRow, SettingsPage } from '../SettingRow';
import { settingDomId } from '../catalog';
import { RemoteGroup } from '../RemoteGroup';
import { CARD_ROW, CodelessAccessRows } from '../CodelessRemoteSettings';
import { GlassesRows } from '../GlassesSettings';
import { MachineMark } from '../../machines/MachineMark';
import { useMachines } from '../../../hooks/useMachines';
import { THIS_COMPUTER, type MachineEntry } from '../../../utils/machineList';
import { cn } from '../../../utils/cn';
import type { RemoteAccessSubviewId } from '../../../types/settings';
import type { RemoteAccessController } from '../useRemoteAccessSettings';

/** Machines come and go, and a tailnet switch changes the whole list; refresh while it is on screen. */
const MACHINE_REFRESH_MS = 30_000;

interface RemoteAccessSettingsProps {
  controller: RemoteAccessController;
  onOpenSubview: (subview: RemoteAccessSubviewId) => void;
  onOpenMachine: (machineId: string) => void;
  /** Changes each time something asks for the "Add a machine" code box open. */
  addCodeRequest?: number;
  /** Opens this Tailscale machine's password field; the nonce changes per request. */
  passwordRequest?: { machine: string; nonce: number };
}

export function RemoteAccessSettings({ controller, onOpenSubview, onOpenMachine, addCodeRequest, passwordRequest }: RemoteAccessSettingsProps) {
  const { connectionState } = controller;
  const { machines, tailnet, listError, refreshing, refresh, select, switchingId } = useMachines({
    connectionState,
    refreshMs: MACHINE_REFRESH_MS,
    wrapConnect: controller.showChecklist,
  });
  const [selectError, setSelectError] = useState<string | null>(null);
  const [password, setPassword] = useState<{ id: string; value: string } | null>(null);
  const handledPasswordRequest = useRef<number | null>(null);

  const local = machines[0];
  const active = machines.find((machine) => machine.active) ?? local;
  const others = machines.filter((machine) => machine !== active);
  const scope = `on ${local.name === THIS_COMPUTER ? 'this computer' : local.name}`;
  const tailnetName = tailnet?.ok ? tailnet.tailnet : null;

  // A machine routed here for its password opens its field once the listing shows it.
  useEffect(() => {
    if (!passwordRequest || handledPasswordRequest.current === passwordRequest.nonce) return;
    const machine = machines.find((entry) => entry.name === passwordRequest.machine && entry.action === 'password');
    if (!machine) return;
    handledPasswordRequest.current = passwordRequest.nonce;
    setPassword({ id: machine.id, value: '' });
  }, [machines, passwordRequest]);

  const pick = async (machine: MachineEntry, withPassword?: string) => {
    setSelectError(null);
    const outcome = await select(machine, withPassword);
    if (outcome.ok) {
      setPassword(null);
      return;
    }
    if (outcome.needsPassword) setPassword({ id: machine.id, value: '' });
    else setSelectError(outcome.error);
  };

  return (
    <SettingsPage title="Remote Access" description="Use Pane on your other computers.">
      {controller.loading && (
        <p className="text-sm text-text-tertiary" aria-live="polite">Loading Remote Pane status...</p>
      )}
      {controller.error && (
        <ErrorBanner message={controller.error}>
          <Button type="button" variant="secondary" size="sm" onClick={() => void controller.reload()}>Retry</Button>
        </ErrorBanner>
      )}
      {selectError && (
        <ErrorBanner message={selectError}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelectError(null)}>Dismiss</Button>
        </ErrorBanner>
      )}

      <ActiveMachineCard
        machine={active}
        local={local}
        lastError={active.kind === 'local' ? null : connectionState.lastError}
        connectedOverTailscale={active.kind === 'tailnet' && connectionState.status === 'connected'}
        switching={switchingId !== null}
        onSwitchBack={() => void pick(local)}
        onPick={(withPassword) => void pick(active, withPassword)}
        password={password?.id === active.id ? password.value : null}
        onPasswordChange={(value) => setPassword({ id: active.id, value })}
        onPasswordCancel={() => setPassword(null)}
        busy={switchingId === active.id}
        onDetails={() => onOpenMachine(active.id)}
        controller={controller}
      />

      <RemoteGroup
        title="Switch to"
        aside={(
          <div id={settingDomId('remote-machines')} data-setting-id="remote-machines" tabIndex={-1} className="flex items-center gap-1 text-xs text-text-tertiary outline-none">
            <span>{tailnetName ? `On ${tailnetName}` : 'On Tailscale'}</span>
            <IconButton
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Refresh machines"
              icon={<RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />}
              disabled={refreshing}
              onClick={() => void refresh()}
            />
          </div>
        )}
      >
        {tailnet && !tailnet.ok && <p className={`text-sm text-text-secondary ${CARD_ROW}`}>{tailnet.reason}. {tailnet.fix}</p>}
        {listError && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{listError}</p>}
        {others.map((machine) => (
          <MachineRow
            key={machine.id}
            machine={machine}
            disabled={switchingId !== null}
            busy={switchingId === machine.id}
            password={password?.id === machine.id ? password.value : null}
            onPasswordChange={(value) => setPassword({ id: machine.id, value })}
            onPasswordCancel={() => setPassword(null)}
            onPick={(withPassword) => void pick(machine, withPassword)}
            onDetails={() => onOpenMachine(machine.id)}
          />
        ))}
        {tailnet?.ok && others.length === 0 && (
          <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Open Pane on another computer on your Tailscale login to see it here.</p>
        )}
        <AddMachine key={addCodeRequest} controller={controller} startAdding={addCodeRequest !== undefined} />
      </RemoteGroup>

      <RemoteGroup title="Access" scope={scope}>
        <CodelessAccessRows tailnetName={tailnetName} />
      </RemoteGroup>

      <RemoteGroup
        title="Devices"
        scope={scope}
        footnote="Phones connect over Tailscale or with a connection code. Glasses pair from the Pane phone app."
      >
        <PhoneRows controller={controller} />
        <GlassesRows />
        <PairHelp onSetUpHost={() => onOpenSubview('host-setup')} />
      </RemoteGroup>

      <RemoteGroup title="More">
        <SettingRow
          settingId="remote-pane"
          label="Connection codes and host setup"
          description="For browsers, other Tailscale accounts, and manual hosts."
          align="start"
          className={CARD_ROW}
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
      </RemoteGroup>
    </SettingsPage>
  );
}

function ErrorBanner({ message, children }: { message: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary" role="alert">
      <span>{message}</span>
      {children}
    </div>
  );
}

interface ActiveMachineCardProps {
  machine: MachineEntry;
  local: MachineEntry;
  lastError: string | null;
  connectedOverTailscale: boolean;
  switching: boolean;
  onSwitchBack: () => void;
  /** Retries, or with a password, saves it and connects again. */
  onPick: (password?: string) => void;
  /** The password being typed, while this machine's password field is open. */
  password: string | null;
  onPasswordChange: (value: string) => void;
  onPasswordCancel: () => void;
  busy: boolean;
  onDetails: () => void;
  controller: RemoteAccessController;
}

/** The machine agents run on now, with the way back to this computer. */
function ActiveMachineCard({ machine, local, lastError, connectedOverTailscale, switching, onSwitchBack, onPick, password, onPasswordChange, onPasswordCancel, busy, onDetails, controller }: ActiveMachineCardProps) {
  const remote = machine.kind !== 'local';
  const detail = [machine.subtitle, !remote && 'Agents run here', connectedOverTailscale && 'Connected over Tailscale'].filter(Boolean).join(' · ');
  return (
    <div className="rounded-lg border border-border-secondary bg-surface-primary p-4" data-testid="active-machine">
      <div className="flex flex-wrap items-center gap-3">
        <MachineMark os={machine.os} slot={machine.slot} presence={machine.presence} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-text-primary">{machine.name}</p>
          <p className="truncate text-xs text-text-tertiary">{detail}</p>
        </div>
        {machine.action === 'retry' && (
          <Button type="button" variant="ghost" size="sm" disabled={switching} onClick={() => onPick()}>Retry</Button>
        )}
        {machine.action === 'password' && password === null && (
          <Button type="button" variant="ghost" size="sm" disabled={switching} onClick={() => onPick()}>Enter password</Button>
        )}
        {remote && (
          <Button type="button" variant="secondary" size="sm" disabled={switching} onClick={onSwitchBack}>
            Switch back to {local.name === THIS_COMPUTER ? 'this computer' : local.name}
          </Button>
        )}
        <IconButton type="button" size="sm" variant="ghost" aria-label={`${machine.name} details`} icon={<Info className="h-4 w-4" />} onClick={onDetails} />
      </div>
      {password !== null && (
        <div className="mt-3 flex justify-end border-t border-border-secondary pt-3">
          <PasswordForm name={machine.name} value={password} busy={busy} onChange={onPasswordChange} onSubmit={() => onPick(password)} onCancel={onPasswordCancel} />
        </div>
      )}
      {lastError && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-secondary pt-3">
          <p className="text-xs text-status-error">{lastError}</p>
          {lastError.toLowerCase().includes('tailscale') && (
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" icon={<Terminal className="h-4 w-4" />} onClick={() => controller.openSetupTerminal(true)}>Open Tailscale Setup</Button>
              <Button type="button" variant="ghost" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}>Download Tailscale</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface MachineRowProps {
  machine: MachineEntry;
  disabled: boolean;
  busy: boolean;
  /** The password being typed, while this machine's password field is open. */
  password: string | null;
  onPasswordChange: (value: string) => void;
  onPasswordCancel: () => void;
  onPick: (password?: string) => void;
  onDetails: () => void;
}

function MachineRow({ machine, disabled, busy, password, onPasswordChange, onPasswordCancel, onPick, onDetails }: MachineRowProps) {
  const pickable = machine.action !== 'none';
  return (
    <div
      className={cn('group flex flex-wrap items-center justify-between gap-3 hover:bg-surface-hover focus-within:bg-surface-hover', CARD_ROW)}
      data-testid={`machine-${machine.name}`}
    >
      <div className={cn('flex min-w-0 flex-1 basis-48 items-center gap-3', machine.presence === 'dimmed' && 'text-text-tertiary')}>
        <MachineMark os={machine.os} slot={machine.slot} presence={machine.presence} size="md" />
        <div className="min-w-0">
          <p className={cn('flex items-center gap-2 truncate text-sm font-medium', machine.presence === 'dimmed' ? 'text-text-tertiary' : 'text-text-primary')}>
            <span className="truncate">{machine.name}</span>
            {machine.kind === 'local' && machine.name !== THIS_COMPUTER && (
              <span className="flex-none rounded bg-surface-secondary px-1.5 py-px text-[11px] font-medium text-text-secondary">This computer</span>
            )}
          </p>
          <p className="truncate text-xs text-text-tertiary">{machine.subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {password !== null ? (
          <PasswordForm name={machine.name} value={password} busy={busy} onChange={onPasswordChange} onSubmit={() => onPick(password)} onCancel={onPasswordCancel} />
        ) : pickable && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={disabled}
            aria-label={`Switch to ${machine.name}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={() => onPick()}
          >
            Switch
          </Button>
        )}
        <IconButton type="button" size="sm" variant="ghost" aria-label={`${machine.name} details`} icon={<Info className="h-4 w-4" />} onClick={onDetails} />
      </div>
    </div>
  );
}

interface PasswordFormProps {
  name: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Asks for a machine's password, then connects with it. */
function PasswordForm({ name, value, busy, onChange, onSubmit, onCancel }: PasswordFormProps) {
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        type="password"
        aria-label={`Password for ${name}`}
        placeholder="Password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
        className="ph-no-capture"
      />
      <Button type="submit" size="sm" loading={busy} disabled={!value}>Connect</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

/** The last Switch to row: how a new machine appears, and pasting a connection code. */
function AddMachine({ controller, startAdding }: { controller: RemoteAccessController; startAdding: boolean }) {
  const [open, setOpen] = useState(startAdding);
  if (!open) {
    return (
      <button
        type="button"
        className={cn('flex w-full items-center gap-3 text-left text-sm font-medium text-interactive-text hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-subtle', CARD_ROW)}
        onClick={() => setOpen(true)}
      >
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-interactive/10" aria-hidden="true">
          <Plus className="h-4 w-4" />
        </span>
        Add a machine
      </button>
    );
  }
  return (
    <form
      id={settingDomId('remote-add-code')}
      className={cn('space-y-3', CARD_ROW)}
      onSubmit={(event) => {
        event.preventDefault();
        void controller.importConnection().then((imported) => { if (imported) setOpen(false); }).catch(() => undefined);
      }}
    >
      <p className="text-sm font-medium text-text-primary">Add a machine</p>
      <p className="text-xs text-text-tertiary">
        Open Pane on a computer signed into your Tailscale login and it appears in this list. For any other machine, paste the connection code from its Set Up Host page.
      </p>
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
        <Button type="button" variant="ghost" size="sm" onClick={() => { controller.setConnectionCode(''); setOpen(false); }}>Cancel</Button>
        <Button type="submit" size="sm" loading={controller.busy} disabled={!controller.connectionCode.trim()}>Connect</Button>
      </div>
    </form>
  );
}

/** Phones paired with a connection code, and any device connected right now. */
function PhoneRows({ controller }: { controller: RemoteAccessController }) {
  const live = controller.hostState.connectedClients;
  // Glasses are listed with their origins below.
  const records = controller.config.host.clients;
  const paired = records.filter((client) => client.kind !== 'glasses');
  const recordIds = new Set(records.map((client) => client.id));
  const unpaired = live.filter((client) => !client.clientId || !recordIds.has(client.clientId));
  const lastUsed = (at?: string) => (at ? `Last used ${new Date(at).toLocaleString()}` : 'Never used');

  return (
    <>
      {paired.map((client) => {
        const connected = live.some((entry) => entry.clientId === client.id);
        return (
          <PhoneRow key={client.id} title={client.label} detail={connected ? 'Connected now' : lastUsed(client.lastUsedAt)}>
            {connected && <Button type="button" variant="ghost" size="sm" disabled={controller.busy} onClick={() => controller.disconnectClients([client.id])}>Disconnect</Button>}
            <Button type="button" variant="ghost" size="sm" aria-label={`Revoke ${client.label}`} disabled={controller.busy} onClick={() => controller.revokeClient(client.id)}>Revoke</Button>
          </PhoneRow>
        );
      })}
      {unpaired.map(({ id, clientId, deviceLabel, label, remoteAddress }) => (
        <PhoneRow key={id} title={deviceLabel ?? label ?? remoteAddress ?? 'A device'} detail="Connected now">
          {clientId && (
            <Button type="button" variant="ghost" size="sm" disabled={controller.busy} onClick={() => controller.disconnectClients([clientId])}>Disconnect</Button>
          )}
        </PhoneRow>
      ))}
    </>
  );
}

function PhoneRow({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-3', CARD_ROW)}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-secondary text-text-secondary" aria-hidden="true">
          <Smartphone className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{title}</p>
          <p className="text-xs text-text-tertiary">{detail}</p>
        </div>
      </div>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

/** How to add a phone or glasses; opens to the steps. */
function PairHelp({ onSetUpHost }: { onSetUpHost: () => void }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className={cn('space-y-2 text-xs text-text-secondary', CARD_ROW)}>
      <p className="text-sm font-medium text-text-primary">Pair a phone or glasses</p>
      <p>Phone on your Tailscale login: open Pane on it and enter the Address above.</p>
      <p>Any other phone or browser: create a connection code in Set Up Host and paste it there.</p>
      <p>Glasses: pair from the Pane phone app, in Settings › Glasses › Pair glasses.</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Done</Button>
        <Button type="button" variant="secondary" size="sm" icon={<Server className="h-4 w-4" />} onClick={onSetUpHost}>Set Up Host</Button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      className={cn('flex w-full items-center gap-3 text-left text-sm font-medium text-interactive-text hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-subtle', CARD_ROW)}
      onClick={() => setOpen(true)}
    >
      <Plus className="h-4 w-4 flex-none" aria-hidden="true" />
      Pair a phone or glasses
    </button>
  );
}
