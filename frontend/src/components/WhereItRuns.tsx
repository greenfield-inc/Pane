import type { ReactNode } from 'react';
import { Cloud, Cpu, Eye, KeyRound, MemoryStick, Monitor, Server } from 'lucide-react';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import type { MachineOs } from '../utils/machineList';
import { cn } from '../utils/cn';
import { isMac, isWindows } from '../utils/platformUtils';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/** Where a new Session runs: `here` (the machine the window is on), `cloud`, or another saved machine's id. */
export type Place = string;

export interface PlaceMachine {
  id: string;
  name: string;
  os: MachineOs | null;
}

const INSPECTION_SENTENCE = 'During the beta, automated checks can inspect cloud machines to stop abuse. Staff look only at flagged accounts, and every look is logged.';

const THIS_COMPUTER = isMac() ? 'this Mac' : 'this computer';

/** What stops a cloud Session being created now: one quiet line and at most one action. */
export interface PaneCloudGate {
  line: string;
  action?: 'sign-in' | 'sign-up';
  /** The code the browser shows while signing in. */
  code?: string;
}

const SMALL_BADGE = 'gap-1 px-1.5 py-px text-[10.5px] leading-[14px]';

function OnlineBadge() {
  return <Badge variant="success" size="sm" className={SMALL_BADGE} icon={<span className="h-1.5 w-1.5 rounded-full bg-status-success" aria-hidden="true" />}>Online</Badge>;
}

interface PlaceCardProps {
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  badge: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}

function PlaceCard({ id, title, subtitle, icon, badge, selected, disabled, onSelect, children, footer }: PlaceCardProps) {
  return (
    <div
      data-testid={`where-it-runs-${id}`}
      className={cn(
        'rounded border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-interactive',
        selected ? 'border-interactive bg-surface-selected' : 'border-border-primary hover:bg-surface-hover',
      )}
    >
      <label htmlFor={`where-it-runs-input-${id}`} className="flex cursor-default items-start gap-3">
        <input id={`where-it-runs-input-${id}`} type="radio" name="where-it-runs" value={id} aria-label={title} checked={selected} disabled={disabled} onChange={onSelect} className="sr-only" />
        <span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-text-primary">{title}</span>
          <span className="block text-xs text-text-secondary">{subtitle}</span>
          {children}
        </span>
        <span className="shrink-0">{badge}</span>
      </label>
      {footer && <div className="ml-[30px] mt-2.5 flex items-center gap-2 text-xs text-text-secondary">{footer}</div>}
    </div>
  );
}

interface WhereItRunsProps {
  value: Place;
  onChange: (place: Place) => void;
  current: PlaceMachine;
  others: readonly PlaceMachine[];
  /** Shown on the Pane Cloud card while it is selected. */
  cloudGate: PaneCloudGate | null;
  onCloudSignIn: () => void;
  onCloudSignUp: () => void;
  disabled?: boolean;
}

export function WhereItRuns({ value, onChange, current, others, cloudGate, onCloudSignIn, onCloudSignUp, disabled }: WhereItRunsProps) {
  const here = current.id === LOCAL_MACHINE_ID;
  const thisLabel = isMac() ? 'This Mac' : isWindows() ? 'This PC' : 'This computer';
  const cloudSelected = value === 'cloud';
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-label font-medium text-text-primary">Where it runs</legend>
      <div className="grid gap-2" role="radiogroup" aria-label="Where it runs">
        <PlaceCard
          id="here"
          title={here ? thisLabel : current.name}
          subtitle={here ? (current.name === 'This computer' ? 'The computer this window is on' : current.name) : 'Remote machine'}
          icon={here ? <Monitor className="h-[18px] w-[18px]" /> : <Server className="h-[18px] w-[18px]" />}
          badge={<OnlineBadge />}
          selected={value === 'here'}
          disabled={disabled}
          onSelect={() => onChange('here')}
        />
        <PlaceCard
          id="cloud"
          title="Pane Cloud"
          subtitle={`A new machine for this Session. Keeps working when ${THIS_COMPUTER} is closed.`}
          icon={<Cloud className="h-[18px] w-[18px]" />}
          badge={<Badge variant="success" size="sm" className={SMALL_BADGE}>Beta</Badge>}
          selected={cloudSelected}
          disabled={disabled}
          onSelect={() => onChange('cloud')}
          footer={cloudSelected && cloudGate ? <>
            <span className="flex-1">{cloudGate.line}</span>
            {cloudGate.code && <span className="font-mono text-text-tertiary">{cloudGate.code}</span>}
            {cloudGate.action === 'sign-in' && <Button type="button" size="sm" variant="secondary" onClick={onCloudSignIn}>Sign in</Button>}
            {cloudGate.action === 'sign-up' && <Button type="button" size="sm" variant="secondary" onClick={onCloudSignUp}>Finish signing up</Button>}
          </> : undefined}
        >
          {cloudSelected && <>
            <span className="mt-2 flex flex-wrap gap-1">
              <Badge size="sm" className={SMALL_BADGE} icon={<Cpu className="h-2.5 w-2.5" aria-hidden="true" />}>4 vCPUs</Badge>
              <Badge size="sm" className={SMALL_BADGE} icon={<MemoryStick className="h-2.5 w-2.5" aria-hidden="true" />}>8 GB</Badge>
            </span>
            <span className="mt-2.5 flex items-start gap-2 text-xs text-text-secondary">
              <KeyRound className="mt-0.5 h-[13px] w-[13px] shrink-0 text-text-tertiary" aria-hidden="true" />
              <span>Your secrets come along, sent straight from your machines, and are kept on a separate volume the checks don&apos;t read.</span>
            </span>
            <span className="mt-1.5 flex items-start gap-2 text-xs text-text-tertiary">
              <Eye className="mt-0.5 h-[13px] w-[13px] shrink-0" aria-hidden="true" />
              <span>{INSPECTION_SENTENCE}</span>
            </span>
          </>}
        </PlaceCard>
        {others.map(machine => (
          <PlaceCard
            key={machine.id}
            id={machine.id}
            title={machine.name}
            subtitle="Remote machine"
            icon={<Server className="h-[18px] w-[18px]" />}
            badge={<OnlineBadge />}
            selected={value === machine.id}
            disabled={disabled}
            onSelect={() => onChange(machine.id)}
          />
        ))}
      </div>
    </fieldset>
  );
}
