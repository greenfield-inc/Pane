import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, GripVertical, Link2, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { MachineMark } from '../../machines/MachineMark';
import { RoutePillView, RoutePills } from './RoutePills';
import { THIS_COMPUTER, type MachineEntry, type RoutePill } from '../../../utils/machineList';
import { cn } from '../../../utils/cn';
import type { ComputerRoute, RemoteComputer } from '../../../../../shared/types/remoteComputers';

const ROW = 'px-4 py-3';

export interface ComputerRowProps {
  machine: MachineEntry;
  expanded: boolean;
  onToggle: () => void;
  /** A switch is running somewhere. */
  disabled: boolean;
  /** This row's switch is running. */
  busy: boolean;
  /** The password being typed, while this machine's password field is open. */
  password: string | null;
  onPasswordChange: (value: string) => void;
  onPasswordCancel: () => void;
  onPick: (password?: string) => void;
  /** Opens Add a device › Computer for this computer. */
  onLink: () => void;
  onAddRoute: () => void;
  /** Saves a new route order; resolves to an error line, or null. */
  onReorder: (routeIds: string[]) => Promise<string | null>;
  onUnlink: () => void;
  onDetails: () => void;
  /** Under the row: the active computer's last error and its fixes. */
  footer?: ReactNode;
  /** This computer's expanded content (its Public URL). */
  localDetail?: ReactNode;
}

/** One computer in Settings › Remote Access › Computers: its routes as pills, and its detail when expanded. */
export function ComputerRow({ machine, expanded, onToggle, disabled, busy, password, onPasswordChange, onPasswordCancel, onPick, onLink, onAddRoute, onReorder, onUnlink, onDetails, footer, localDetail }: ComputerRowProps) {
  const dimmed = machine.presence === 'dimmed';
  const computer = machine.computer;
  const detailId = `computer-detail-${machine.id}`;
  return (
    <div data-testid={`machine-${machine.name}`} data-active={machine.active || undefined}>
      <div className={cn('flex flex-wrap items-center justify-between gap-3', ROW)}>
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <MachineMark letters={machine.letters} slot={machine.slot} presence={machine.presence} size="md" />
          <div className="min-w-0">
            <p className={cn('flex items-center gap-2 truncate text-sm font-medium', dimmed ? 'text-text-tertiary' : 'text-text-primary')}>
              <span className="truncate">{machine.name}</span>
              {machine.kind === 'local' && machine.name !== THIS_COMPUTER && (
                <span className="flex-none rounded bg-surface-secondary px-1.5 py-px text-[11px] font-medium text-text-secondary">This computer</span>
              )}
            </p>
            <p className="truncate text-xs text-text-tertiary">{rowSubtitle(machine)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RoutePills routes={machine.routes ?? []} />
          {password !== null ? (
            <PasswordForm name={machine.name} value={password} busy={busy} onChange={onPasswordChange} onSubmit={() => onPick(password)} onCancel={onPasswordCancel} />
          ) : machine.needsLink ? (
            <Button type="button" variant="secondary" size="sm" icon={<Link2 className="h-3.5 w-3.5" />} aria-label={`Link ${machine.name}`} onClick={onLink}>
              Link
            </Button>
          ) : machine.action !== 'none' && (
            <Button type="button" variant="secondary" size="sm" loading={busy} disabled={disabled} aria-label={pickLabel(machine)} onClick={() => onPick()}>
              {machine.action === 'retry' ? 'Retry' : machine.active ? 'Enter password' : 'Switch'}
            </Button>
          )}
          {computer || localDetail ? (
            <IconButton
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${machine.name} routes and details`}
              aria-expanded={expanded}
              aria-controls={detailId}
              icon={<ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />}
              onClick={onToggle}
            />
          ) : machine.kind !== 'local' && <span className="h-7 w-7 flex-none" aria-hidden="true" />}
        </div>
      </div>
      {footer}
      {localDetail && expanded && <div id={detailId}>{localDetail}</div>}
      {computer && expanded && (
        <ComputerDetail id={detailId} computer={computer} routes={machine.routes ?? []} onAddRoute={onAddRoute} onReorder={onReorder} onUnlink={onUnlink} onDetails={onDetails} />
      )}
    </div>
  );
}

/** This computer's row has its badge, so its subtitle says where agents run instead of "This computer". */
function rowSubtitle(machine: MachineEntry): string {
  if (machine.kind !== 'local') return machine.subtitle;
  return [machine.os, machine.active && 'Agents run here'].filter(Boolean).join(' · ');
}

/** The row's button: retry or re-enter the password of the active computer, else switch to it. */
function pickLabel(machine: MachineEntry): string {
  if (machine.action === 'retry') return `Retry ${machine.name}`;
  return machine.active ? `Enter password for ${machine.name}` : `Switch to ${machine.name}`;
}

/** "In use · found automatically": what a route is doing and how it was added. */
function routeLine(pill: RoutePill, route: ComputerRoute): string {
  const how = route.source === 'link' ? 'from the link'
    : route.source === 'found' ? 'found automatically'
      : route.source === 'ssh' ? 'over SSH from this computer'
        : 'added with a connection code';
  const state = pill.down ? 'Tailscale is signed out here' : pill.inUse ? 'In use' : null;
  return state ? `${state} · ${how}` : how.charAt(0).toUpperCase() + how.slice(1);
}

/** Who linked a computer, in one sentence. */
function linkedSentence(computer: RemoteComputer): string {
  if (computer.linkedBy) return `By ${computer.linkedBy}, which paired with both computers`;
  const sources = new Set(computer.routes.map((route) => route.source));
  if (sources.has('link')) return 'With a one-time link';
  if (sources.has('ssh')) return 'Over SSH from this computer';
  if (sources.has('manual')) return 'With a connection code';
  return 'Found on Tailscale; not linked';
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface ComputerDetailProps {
  id: string;
  computer: RemoteComputer;
  routes: readonly RoutePill[];
  onAddRoute: () => void;
  onReorder: (routeIds: string[]) => Promise<string | null>;
  onUnlink: () => void;
  onDetails: () => void;
}

/** Routes in order with drag to reorder, Add route, who linked it, and unlink. */
function ComputerDetail({ id, computer, routes, onAddRoute, onReorder, onUnlink, onDetails }: ComputerDetailProps) {
  // The order shown while a reorder saves; the saved order replaces it once the config reloads.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const savedIds = computer.routes.map((route) => route.id);
  const ids = order && order.length === savedIds.length && order.every((routeId) => savedIds.includes(routeId)) ? order : savedIds;
  const pills = new Map(routes.map((pill) => [pill.id, pill]));
  const byId = new Map(computer.routes.map((route) => [route.id, route]));
  const unlinkable = computer.routes.some((route) => route.relay);

  const save = async (next: string[]) => {
    if (next.join('\n') === ids.join('\n')) return;
    setOrder(next);
    setError(null);
    const failure = await onReorder(next);
    if (failure) {
      setOrder(null);
      setError(failure);
    }
  };

  const onDrop = (event: DragEvent, target: string) => {
    event.preventDefault();
    if (!dragging) return;
    void save(moved(ids, ids.indexOf(dragging), ids.indexOf(target)));
    setDragging(null);
  };

  const onHandleKey = (event: KeyboardEvent, routeId: string) => {
    const from = ids.indexOf(routeId);
    const to = event.key === 'ArrowUp' ? from - 1 : event.key === 'ArrowDown' ? from + 1 : -1;
    if (to < 0 || to >= ids.length) return;
    event.preventDefault();
    void save(moved(ids, from, to));
  };

  return (
    <div id={id} className="space-y-3 pb-4 pl-[60px] pr-4">
      <ol className="space-y-1" aria-label={`${computer.label} routes in order`}>
        {ids.map((routeId) => {
          const route = byId.get(routeId);
          const pill = pills.get(routeId);
          if (!route || !pill) return null;
          return (
            <li
              key={routeId}
              draggable={ids.length > 1}
              onDragStart={(event) => { setDragging(routeId); event.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => { if (dragging) event.preventDefault(); }}
              onDrop={(event) => onDrop(event, routeId)}
              className={cn('grid grid-cols-[8rem_1fr_auto] items-center gap-3 rounded-md py-0.5', dragging === routeId && 'opacity-50')}
              data-testid={`route-${route.kind}`}
            >
              <span><RoutePillView route={pill} /></span>
              <span className="truncate text-xs text-text-secondary">{routeLine(pill, route)}</span>
              {ids.length > 1 ? (
                <button
                  type="button"
                  className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                  aria-label={`Move ${pill.label}. Drag, or press the up and down arrows.`}
                  onKeyDown={(event) => onHandleKey(event, routeId)}
                >
                  <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : <span className="h-6 w-6" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <dl className="grid grid-cols-[8rem_1fr_auto] items-center gap-x-3 gap-y-2 text-xs">
        <dt className="text-text-tertiary">Order</dt>
        <dd className="text-text-secondary">Pane tries routes top to bottom; drag to reorder</dd>
        <dd><button type="button" className="text-xs font-medium text-interactive-text hover:underline" onClick={onAddRoute}>Add route</button></dd>
        <dt className="text-text-tertiary">Linked</dt>
        <dd className="col-span-2 text-text-secondary">{linkedSentence(computer)}</dd>
      </dl>
      {error && <p className="text-xs text-status-error" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-xs text-text-tertiary hover:text-text-secondary hover:underline" onClick={onDetails}>Colour and details</button>
        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">
              {unlinkable ? `${computer.label} stops reaching your other computers, and they stop reaching it.` : `Pane forgets ${computer.label} on this computer.`}
            </span>
            <Button type="button" variant="danger" size="sm" onClick={() => { setConfirming(false); onUnlink(); }}>{unlinkable ? 'Unlink' : 'Forget'}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <button type="button" className="flex items-center gap-1.5 text-xs font-medium text-status-error hover:underline" onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {unlinkable ? 'Unlink from all your computers' : `Forget ${computer.label}`}
          </button>
        )}
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
export function PasswordForm({ name, value, busy, onChange, onSubmit, onCancel }: PasswordFormProps) {
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
