import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, Copy } from 'lucide-react';
import { Button } from '../ui/Button';
import { RemoteGroup } from './RemoteGroup';
import { CARD_ROW, errorMessage, phoneAddress } from './CodelessRemoteSettings';
import { MachineMark, machineColorVar } from '../machines/MachineMark';
import { useMachines } from '../../hooks/useMachines';
import { THIS_COMPUTER, type MachineEntry } from '../../utils/machineList';
import { MACHINE_COLOR_NAMES } from '../../../../shared/utils/machineColor';
import type { RemoteAccessController } from './useRemoteAccessSettings';

interface MachineDetailsProps {
  machineId: string;
  controller: RemoteAccessController;
  onBack: () => void;
  /** A machine that needs its password goes back to Remote Access with its field open. */
  onNeedsPassword: (machineName: string) => void;
}

/** One machine's address, state, Pane version, owner and colour, with switch and forget. */
export function MachineDetails({ machineId, controller, onBack, onNeedsPassword }: MachineDetailsProps) {
  const { machines, select, switchingId } = useMachines({ connectionState: controller.connectionState, wrapConnect: controller.showChecklist });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const local = machines[0];
  // A machine connected from here for the first time moves from its Tailscale id to its saved id.
  const machine = machines.find((entry) => entry.id === machineId)
    ?? machines.find((entry) => entry.tailnet && `tailnet:${entry.tailnet.dnsName}` === machineId);
  if (!machine) {
    return (
      <DetailsFrame onBack={onBack}>
        <p className="text-sm text-text-tertiary">This machine is no longer listed.</p>
      </DetailsFrame>
    );
  }

  const localName = local.name === THIS_COMPUTER ? 'this computer' : local.name;
  const address = machine.tailnet ? machine.tailnet.dnsName : machine.profile ? phoneAddress(machine.profile.baseUrl) : null;
  const colorName = MACHINE_COLOR_NAMES[machine.slot];
  const header = machine.active && machine.kind === 'tailnet' && controller.connectionState.status === 'connected'
    ? [machine.os, 'Connected over Tailscale'].filter(Boolean).join(' · ')
    : machine.subtitle;
  const status = machine.active && machine.kind !== 'local'
    ? { value: machine.presence === 'solid' ? 'Connected' : machine.stateText, detail: 'Agents run here' }
    : machine.active ? { value: 'Agents run here', detail: undefined } : { value: machine.stateText || 'Saved', detail: undefined };

  const copyAddress = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => { if (mounted.current) setCopied(false); }, 2_000);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not copy the address.'));
    }
  };

  const pick = async (target: MachineEntry) => {
    setError(null);
    const outcome = await select(target);
    if (outcome.ok) return;
    if (outcome.needsPassword) onNeedsPassword(target.name);
    else setError(outcome.error);
  };

  const forget = async (profileId: string) => {
    // Main switches to this computer first when the machine is the active one.
    if (await controller.deleteProfile(profileId)) onBack();
  };

  return (
    <DetailsFrame onBack={onBack}>
      <div className="flex items-center gap-4">
        <MachineMark os={machine.os} slot={machine.slot} presence={machine.presence} size="lg" />
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-text-primary">{machine.name}</h2>
          <p className="truncate text-sm text-text-tertiary">{header}</p>
        </div>
      </div>
      {(error || controller.error) && (
        <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-text-primary" role="alert">{error ?? controller.error}</div>
      )}

      <RemoteGroup title="Connection">
        {address && (
          <DetailRow label="Address" detail={address}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={() => void copyAddress(address)}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </DetailRow>
        )}
        <DetailRow label="Status" detail={status.detail}><Value>{status.value}</Value></DetailRow>
        {machine.tailnet?.paneVersion && (
          <DetailRow label="Pane" detail={`Version on ${machine.name}`}><Value>{machine.tailnet.paneVersion}</Value></DetailRow>
        )}
        {machine.tailnet && (
          <DetailRow label="Owner" detail="Tailscale login"><Value>{machine.tailnet.ownerLogin}</Value></DetailRow>
        )}
      </RemoteGroup>

      <RemoteGroup title="Colour">
        <div className={`flex items-center gap-3 ${CARD_ROW}`}>
          <span className="h-4 w-4 flex-none rounded-full" style={{ backgroundColor: machineColorVar(machine.slot) }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">{colorName}</p>
            <p className="text-xs text-text-tertiary">Marks {machine.name} everywhere in Pane, on this computer and your phone.</p>
          </div>
        </div>
      </RemoteGroup>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {machine.active && machine.kind !== 'local' ? (
          <Button type="button" variant="secondary" size="sm" disabled={switchingId !== null} onClick={() => void pick(local)}>
            Switch back to {localName}
          </Button>
        ) : machine.action !== 'none' ? (
          <Button type="button" variant="secondary" size="sm" loading={switchingId === machine.id} disabled={switchingId !== null} onClick={() => void pick(machine)}>
            {machine.action === 'retry' ? 'Retry' : 'Switch'}
          </Button>
        ) : <span />}
        {machine.profile && (
          <Button type="button" variant="ghost" size="sm" className="text-status-error" disabled={controller.busy} onClick={() => void forget(machine.profile?.id ?? '')}>
            Forget {machine.name}
          </Button>
        )}
      </div>
    </DetailsFrame>
  );
}

function DetailsFrame({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 pb-8">
      <button type="button" className="flex items-center gap-1 text-sm text-interactive-text hover:underline" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Remote Access
      </button>
      {children}
    </section>
  );
}

function DetailRow({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="truncate text-xs text-text-tertiary">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="truncate text-sm text-text-secondary">{children}</span>;
}
