import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, Monitor, Plus, RefreshCw, Server, Smartphone, Terminal, Trash2, X } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Input';
import { SettingRow } from '../SettingRow';
import { settingDomId } from '../catalog';
import { RemoteGroup } from '../RemoteGroup';
import { CARD_ROW, CodelessAccessRows } from '../CodelessRemoteSettings';
import { GlassesRows } from '../GlassesSettings';
import { ComputerRow } from '../computers/ComputerRow';
import { PublicUrlField } from '../computers/PublicUrlField';
import { useAddDeviceStore } from '../../addDevice/addDeviceStore';
import { useMachines } from '../../../hooks/useMachines';
import { useConfigStore } from '../../../stores/configStore';
import { THIS_COMPUTER, type MachineEntry } from '../../../utils/machineList';
import { cn } from '../../../utils/cn';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { Dropdown } from '../../ui/Dropdown';
import { Bone, Skeleton, LoadingStatus } from '../../ui/Skeleton';
import { computerRelayId } from '../../../../../shared/types/remoteComputers';
import { relayCarrier } from '../../../utils/relayCarrier';
import type { RemoteDaemonClientRecord } from '../../../../../shared/types/remoteDaemon';
import type { RemoteAccessSubviewId, SettingSaveState, SettingsSettingId } from '../../../types/settings';
import type { RemoteAccessController } from '../useRemoteAccessSettings';

/** Machines come and go, and a tailnet switch changes the whole list; refresh while it is on screen. */
const MACHINE_REFRESH_MS = 30_000;

type RemoteAccessTab = 'computers' | 'devices' | 'tailscale';

/** The tab last shown, so coming back from Set Up Host or a computer's details returns to it. */
let shownTab: RemoteAccessTab = 'computers';

/** The tab that holds a setting a link can open; the header's settings show on every tab. */
function tabHolding(setting: SettingsSettingId): RemoteAccessTab | undefined {
  switch (setting) {
    case 'remote-machines':
    case 'remote-linked-computers':
      return 'computers';
    case 'remote-glasses':
    case 'remote-relay-address':
      return 'devices';
    case 'remote-visibility':
    case 'remote-address':
    case 'remote-password':
    case 'remote-pane':
    case 'remote-add-code':
      return 'tailscale';
    default:
      return undefined;
  }
}

interface RemoteAccessSettingsProps {
  controller: RemoteAccessController;
  onOpenSubview: (subview: RemoteAccessSubviewId) => void;
  onOpenMachine: (machineId: string) => void;
  /** A setting a link asked for; the nonce changes per request. `remote-add-code` also opens the connection code box. */
  settingRequest?: { setting: SettingsSettingId; nonce: number };
  /** Opens this Tailscale machine's password field; the nonce changes per request. */
  passwordRequest?: { machine: string; nonce: number };
}

export function RemoteAccessSettings({ controller, onOpenSubview, onOpenMachine, settingRequest, passwordRequest }: RemoteAccessSettingsProps) {
  const { connectionState } = controller;
  const { machines, tailnet, listError, refreshing, refresh, select, switchingId } = useMachines({
    connectionState,
    refreshMs: MACHINE_REFRESH_MS,
    wrapConnect: controller.showChecklist,
  });
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const openAddDevice = useAddDeviceStore((state) => state.open);
  const requestedTab = settingRequest && tabHolding(settingRequest.setting);
  const [tab, setShownTab] = useState<RemoteAccessTab>(requestedTab ?? shownTab);
  const setTab = (next: RemoteAccessTab) => {
    shownTab = next;
    setShownTab(next);
  };
  const addCodeRequest = settingRequest?.setting === 'remote-add-code' ? settingRequest.nonce : undefined;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [password, setPassword] = useState<{ id: string; value: string } | null>(null);
  // Kept here: an unlinked computer's row is gone after the reload, but its outcome may ask the person to finish elsewhere.
  const [unlinkOutcome, setUnlinkOutcome] = useState<string | null>(null);
  const handledPasswordRequest = useRef<number | null>(null);
  const handledSettingRequest = useRef<number | null>(null);

  const local = machines[0];
  const here = local.name === THIS_COMPUTER ? 'this computer' : local.name;
  const scope = `on ${here}`;
  const listedRelayIds = new Set(machines.flatMap((machine) => {
    const relayId = machine.computer && computerRelayId(machine.computer);
    return relayId ? [relayId] : [];
  }));
  // Computers linked with this one that this one does not list (it reaches them no other way).
  const linkedOnly = controller.config.host.clients.filter((client) => client.kind === 'computer' && !(client.computerId && listedRelayIds.has(client.computerId)));
  const devices = controller.config.host.clients.filter((client) => client.kind !== 'computer').length;
  const tailnetName = tailnet?.ok ? tailnet.tailnet : null;
  const tailscaleSignedOut = tailnet?.ok === false;

  // A link to a setting opens its tab; Settings then focuses it.
  useEffect(() => {
    if (!settingRequest || handledSettingRequest.current === settingRequest.nonce) return;
    handledSettingRequest.current = settingRequest.nonce;
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab, settingRequest]);

  // A machine routed here for its password opens its field once the listing shows it.
  useEffect(() => {
    if (!passwordRequest || handledPasswordRequest.current === passwordRequest.nonce) return;
    const machine = machines.find((entry) => entry.name === passwordRequest.machine && entry.action === 'password');
    if (!machine) return;
    handledPasswordRequest.current = passwordRequest.nonce;
    setTab('computers');
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

  const reorder = async (computerId: string, routeIds: string[]): Promise<string | null> => {
    try {
      await window.electronAPI.invoke('computers:reorder-routes', { computerId, routeIds });
      await fetchConfig();
      return null;
    } catch (cause) {
      return `The order was not saved: ${ipcErrorMessage(cause, "Pane couldn't write its settings")}. Try again.`;
    }
  };

  const unlink = (machine: MachineEntry) => {
    const computer = machine.computer;
    if (!computer) return;
    const relayId = computerRelayId(computer);
    setUnlinkOutcome(null);
    if (!relayId) {
      // Main switches to this computer first when it is the active one.
      void controller.forgetComputer(computer.id).then(() => fetchConfig());
      return;
    }
    void runEverywhere(controller, 'relay:unlink-computer-everywhere', { computerId: relayId }, `Unlinked ${computer.label}`, computer.label)
      .then((line) => {
        setUnlinkOutcome(line);
        return fetchConfig();
      });
  };

  const tabs: Array<{ id: RemoteAccessTab; label: string; count?: number }> = [
    { id: 'computers', label: 'Computers', count: machines.length },
    { id: 'devices', label: 'Phones and glasses', count: devices },
    { id: 'tailscale', label: 'Tailscale' },
  ];

  return (
    <section className="mx-auto w-full max-w-3xl pb-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-text-primary">Remote Access</h2>
          <p className="mt-1.5 max-w-2xl text-sm text-text-tertiary">Reach your computers from each other and from your phone.</p>
        </div>
        <Button
          id={settingDomId('remote-pair-phone')}
          data-setting-id="remote-pair-phone"
          type="button"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() => openAddDevice(tab === 'devices' ? 'phone' : 'computer')}
        >
          Add a device
        </Button>
      </header>

      <div role="tablist" aria-label="Remote Access" className="mb-5 flex gap-6 border-b border-border-secondary">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`remote-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`remote-panel-${entry.id}`}
            onClick={() => setTab(entry.id)}
            className={cn(
              '-mb-px border-b-2 pb-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
              tab === entry.id ? 'border-interactive text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary',
            )}
          >
            {entry.label}
            {entry.count !== undefined && <span className="tabular-nums"> · {entry.count}</span>}
          </button>
        ))}
      </div>

      {controller.loading && <LoadingStatus label="Loading Remote Pane status" />}
      <div role="tabpanel" id={`remote-panel-${tab}`} aria-labelledby={`remote-tab-${tab}`} className="space-y-8">
        {controller.error && (
          <ErrorBanner message={controller.error}>
            <Button type="button" variant="secondary" size="sm" onClick={() => void controller.reload()}>Retry</Button>
          </ErrorBanner>
        )}

        {tab === 'computers' && (
          <>
            {selectError && (
              <ErrorBanner message={selectError}>
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelectError(null)}>Dismiss</Button>
              </ErrorBanner>
            )}
            <section className="space-y-2">
              <div
                id={settingDomId('remote-machines')}
                data-setting-id="remote-machines"
                tabIndex={-1}
                className="divide-y divide-border-secondary overflow-hidden rounded-lg border border-border-secondary bg-surface-primary outline-none"
              >
                {machines.map((machine) => (
                  <ComputerRow
                    key={machine.id}
                    machine={machine}
                    expanded={expanded === machine.id}
                    onToggle={() => setExpanded((current) => (current === machine.id ? null : machine.id))}
                    disabled={switchingId !== null}
                    busy={switchingId === machine.id}
                    password={password?.id === machine.id ? password.value : null}
                    onPasswordChange={(value) => setPassword({ id: machine.id, value })}
                    onPasswordCancel={() => setPassword(null)}
                    onPick={(withPassword) => void pick(machine, withPassword)}
                    onLink={() => openAddDevice('computer', { computerId: machine.computer?.id })}
                    onAddRoute={() => openAddDevice('computer', { computerId: machine.computer?.id })}
                    onReorder={(routeIds) => (machine.computer ? reorder(machine.computer.id, routeIds) : Promise.resolve(null))}
                    onUnlink={() => unlink(machine)}
                    onDetails={() => onOpenMachine(machine.id)}
                    localDetail={machine.kind === 'local'
                      ? <PublicUrlField saved={controller.config.host.publicUrl ?? ''} onSaved={controller.reload} />
                      : undefined}
                    footer={machine.active && machine.kind !== 'local' && connectionState.lastError
                      ? <ConnectionError message={connectionState.lastError} controller={controller} />
                      : undefined}
                  />
                ))}
                {unlinkOutcome && <p className={`text-xs text-text-secondary ${CARD_ROW}`} role="status">{unlinkOutcome}</p>}
              </div>
              <p className="px-0.5 text-xs text-text-tertiary">
                {tailscaleSignedOut
                  ? `Tailscale is signed out on ${here}. Computers with another route use it without closing your Panes.`
                  : 'Pills show every way Pane can reach a computer; the dot marks the one in use. If it fails, Pane uses another without closing your Panes.'}
              </p>
            </section>

            {linkedOnly.length > 0 && (
              <RemoteGroup
                title="Also linked"
                footnote="These computers can reach this one. Link them back to reach them from here."
              >
                <div id={settingDomId('remote-linked-computers')} data-setting-id="remote-linked-computers" tabIndex={-1} className="divide-y divide-border-secondary outline-none">
                  {linkedOnly.map((computer) => (
                    <LinkedComputerRow key={computer.id} computer={computer} controller={controller} onOutcome={setUnlinkOutcome} />
                  ))}
                </div>
              </RemoteGroup>
            )}
          </>
        )}

        {tab === 'devices' && (
          <>
            <RemoteGroup
              title="Devices"
              scope={scope}
              footnote={`On the same Wi-Fi a device connects directly. Anywhere else, ${relayCarrier(controller.config.relay?.relayAddress)}. Glasses pair from the Pane phone app.`}
            >
              <PhoneRows controller={controller} here={here} />
              <GlassesRows />
            </RemoteGroup>
            <RemoteGroup title="Pane relay">
              <RelayAddressRow controller={controller} />
            </RemoteGroup>
          </>
        )}

        {tab === 'tailscale' && (
          <>
            <RemoteGroup
              title="Access"
              scope={scope}
              aside={(
                <div className="flex items-center gap-1 text-xs text-text-tertiary">
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
              <CodelessAccessRows tailnetName={tailnetName} />
            </RemoteGroup>

            <RemoteGroup title="Hosts and connection codes">
              <SettingRow
                settingId="remote-pane"
                label="Set up a host"
                description="Reach this computer over your tailnet or your own address without Pane's servers."
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
              <AddMachine key={addCodeRequest} controller={controller} startAdding={addCodeRequest !== undefined} />
            </RemoteGroup>
          </>
        )}
      </div>
    </section>
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

/** The active computer's last error, with Tailscale's fixes when Tailscale caused it. */
function ConnectionError({ message, controller }: { message: string; controller: RemoteAccessController }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 border-t border-border-secondary', CARD_ROW)}>
      <p className="text-xs text-status-error">{message}</p>
      {message.toLowerCase().includes('tailscale') && (
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" icon={<Terminal className="h-4 w-4" />} onClick={() => controller.openSetupTerminal(true)}>Open Tailscale Setup</Button>
          <Button type="button" variant="ghost" size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.electronAPI.openExternal('https://tailscale.com/download')}>Download Tailscale</Button>
        </div>
      )}
    </div>
  );
}

/** Pasting a connection code from another computer's Set Up Host page. */
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
        Paste a connection code
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
      <p className="text-sm font-medium text-text-primary">Paste a connection code</p>
      <p className="text-xs text-text-tertiary">
        Computers on your Tailscale login appear under Computers by themselves. For any other host, paste the code from its Set Up Host page.
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

/**
 * "Removed from A and B." plus, for computers that didn't answer, how to finish there. `unlinked`
 * names the computer being unlinked, which can itself be one that didn't answer.
 */
function everywhereResult(subject: string, result: { removed: string[]; notReached: string[] }, unlinked?: string): string {
  const join = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const done = result.removed.length > 0 ? `${subject} from ${join(result.removed)}.` : '';
  const others = result.notReached.filter((name) => name !== unlinked);
  const one = others.length === 1;
  const left = others.length > 0
    ? ` ${join(others)} didn't answer and still ${one ? 'has' : 'have'} it. Remove it there in Settings › Remote Access once ${one ? "it's" : "they're"} back online.`
    : '';
  const itself = unlinked && result.notReached.includes(unlinked)
    ? ` ${unlinked} didn't answer, so it may still list your other computers. Unlink them there in Settings › Remote Access once it's back online.`
    : '';
  return (done + left + itself).trim();
}

/** Runs an "everywhere" command, then reloads the list; returns the line to show under the list. */
async function runEverywhere(controller: RemoteAccessController, channel: string, args: { clientId: string } | { computerId: string }, subject: string, unlinked?: string): Promise<string> {
  try {
    const result: { removed: string[]; notReached: string[] } = await window.electronAPI.invoke(channel, args);
    return everywhereResult(subject, result, unlinked);
  } catch (cause) {
    return `Nothing was removed: ${ipcErrorMessage(cause, "Pane couldn't reach your other computers")}. Try again.`;
  } finally {
    void controller.reload();
  }
}

/** Phones paired with this computer, and any device connected right now. */
function PhoneRows({ controller, here }: { controller: RemoteAccessController; here: string }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const live = controller.hostState.connectedClients;
  // Glasses are listed with their origins below; linked computers under Computers.
  const records = controller.config.host.clients;
  const paired = records.filter((client) => client.kind === undefined);
  const recordIds = new Set(records.map((client) => client.id));
  const unpaired = live.filter((client) => !client.clientId || !recordIds.has(client.clientId));
  const lastUsed = (at?: string) => (at ? `Last used ${new Date(at).toLocaleString()}` : 'Never used');

  return (
    <>
      {paired.map((client) => {
        const connected = live.some((entry) => entry.clientId === client.id);
        const detail = [connected ? 'Connected now' : lastUsed(client.lastUsedAt), client.linkedBy && `Added by ${client.linkedBy}`].filter(Boolean).join(' · ');
        return (
          <PhoneRow key={client.id} title={client.label} detail={detail}>
            {connected && <Button type="button" variant="ghost" size="sm" disabled={controller.busy} onClick={() => controller.disconnectClients([client.id])}>Disconnect</Button>}
            <Dropdown
              menuLabel={`Remove ${client.label}`}
              position="bottom-right"
              width="lg"
              trigger={(
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${client.label}`} disabled={controller.busy}>
                  Remove
                  <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
              items={[
                {
                  id: 'here',
                  icon: X,
                  label: `Remove from ${here}`,
                  description: 'It keeps working with your other computers.',
                  onClick: () => { setOutcome(null); controller.revokeClient(client.id); },
                },
                {
                  id: 'everywhere',
                  icon: Trash2,
                  variant: 'danger',
                  label: 'Remove from all your computers',
                  description: 'Signs it out of every computer linked with this one.',
                  onClick: () => {
                    setOutcome(null);
                    void runEverywhere(controller, 'relay:remove-phone-everywhere', { clientId: client.id }, `Removed ${client.label}`).then(setOutcome);
                  },
                },
              ]}
            />
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
      {paired.length === 0 && unpaired.length === 0 && controller.loading && <PhoneRowSkeleton />}
      {paired.length === 0 && unpaired.length === 0 && !controller.loading && (
        <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>No phones yet. Pair one to use Pane from anywhere.</p>
      )}
      {outcome && <p className={`text-xs text-text-secondary ${CARD_ROW}`} role="status">{outcome}</p>}
    </>
  );
}

/** A PhoneRow while the paired phones load. */
function PhoneRowSkeleton() {
  return (
    <Skeleton className={cn('flex items-center justify-between gap-3', CARD_ROW)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-secondary"><Bone className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center"><Bone className="h-3.5 w-32" /></div>
          <div className="flex h-4 items-center"><Bone className="h-3 w-44" /></div>
        </div>
      </div>
      <Bone className="h-8 w-20 rounded-button" />
    </Skeleton>
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
          <p className="truncate text-xs text-text-tertiary">{detail}</p>
        </div>
      </div>
      <div className="flex flex-none gap-1">{children}</div>
    </div>
  );
}

/** A computer linked with this one that this one does not list. */
function LinkedComputerRow({ computer, controller, onOutcome }: { computer: RemoteDaemonClientRecord; controller: RemoteAccessController; onOutcome: (line: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const connected = controller.hostState.connectedClients.some((entry) => entry.clientId === computer.id);
  const detail = [computer.linkedBy && `Linked by ${computer.linkedBy}`, connected ? 'Connected now' : null].filter(Boolean).join(' · ');
  const computerId = computer.computerId;
  return (
    <div className={CARD_ROW} data-testid={`linked-${computer.label}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-surface-secondary text-text-secondary" aria-hidden="true">
            <Monitor className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text-primary">{computer.label}</p>
            {detail && <p className="truncate text-xs text-text-tertiary">{detail}</p>}
          </div>
        </div>
        {computerId && (
          <Dropdown
            menuLabel={`Unlink ${computer.label}`}
            position="bottom-right"
            width="lg"
            trigger={(
              <Button type="button" variant="ghost" size="sm" aria-label={`Unlink ${computer.label}`} loading={busy}>
                Unlink
                <ChevronDown className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            )}
            items={[{
              id: 'everywhere',
              icon: Trash2,
              variant: 'danger',
              label: 'Unlink from all your computers',
              description: 'It stops reaching your other computers, and they stop reaching it.',
              onClick: () => {
                setBusy(true);
                onOutcome(null);
                void runEverywhere(controller, 'relay:unlink-computer-everywhere', { computerId }, `Unlinked ${computer.label}`, computer.label).then((line) => {
                  setBusy(false);
                  onOutcome(line);
                });
              },
            }]}
          />
        )}
      </div>
    </div>
  );
}

const SELF_HOSTED_RELAY_GUIDE = 'https://github.com/greenfield-inc/Pane/blob/main/docs/SELF_HOSTED_RELAY.md';

/** "Relay address": a self-hosted relay; empty uses Pane's servers. */
function RelayAddressRow({ controller }: { controller: RemoteAccessController }) {
  const saved = controller.config.relay?.relayAddress ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingSaveState>({ state: 'idle' });
  const value = draft ?? saved;
  const save = async () => {
    if (value.trim() === saved || saveState.state === 'saving') return;
    setSaveState({ state: 'saving' });
    try {
      await window.electronAPI.invoke('relay:set-address', value.trim() || null);
      await controller.reload();
      setDraft(null);
      setSaveState({ state: 'saved' });
    } catch (cause) {
      setSaveState({ state: 'error', message: `Not saved: ${ipcErrorMessage(cause, "Pane couldn't save the address")}` });
    }
  };
  return (
    <SettingRow
      settingId="remote-relay-address"
      label="Relay address"
      description="Leave it empty to use Pane's servers. To use your own relay, enter its domain, such as relay.example.com, and press Enter."
      saveState={saveState}
      className={CARD_ROW}
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Input
          aria-label="Relay address"
          placeholder="Pane's servers"
          className="w-56 text-sm"
          value={value}
          onChange={(event) => { setDraft(event.target.value); setSaveState({ state: 'idle' }); }}
          onBlur={() => void save()}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={<ExternalLink className="h-4 w-4" />}
          onClick={() => window.electronAPI.openExternal(SELF_HOSTED_RELAY_GUIDE)}
        >
          Run your own
        </Button>
      </form>
    </SettingRow>
  );
}
