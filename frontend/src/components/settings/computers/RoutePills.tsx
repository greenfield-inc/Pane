import type { ComputerRouteKind } from '../../../../../shared/types/remoteComputers';
import type { RoutePill } from '../../../utils/machineList';
import { cn } from '../../../utils/cn';

/** The pill of the route in use, by kind: its tint and its dot. */
const IN_USE = {
  lan: { pill: 'border-status-success/40 bg-status-success/10 text-status-success', dot: 'bg-status-success' },
  tailscale: { pill: 'border-border-primary bg-surface-secondary text-text-primary', dot: 'bg-text-secondary' },
  ssh: { pill: 'border-autopilot-border bg-autopilot-subtle text-autopilot-on-tint', dot: 'bg-autopilot' },
  public: { pill: 'border-status-warning/40 bg-status-warning/10 text-status-warning', dot: 'bg-status-warning' },
  relay: { pill: 'border-interactive/40 bg-interactive/10 text-interactive-text', dot: 'bg-interactive' },
} as const satisfies Record<ComputerRouteKind, { pill: string; dot: string }>;

/**
 * One pill per route, in the order Pane tries them; a dot marks the one in use, and a route that
 * can't work from here is struck through. The dot and its gap take the same width as the extra
 * padding of a pill without it, so a pill keeps its size when the dot moves.
 */
export function RoutePills({ routes, className }: { routes: readonly RoutePill[]; className?: string }) {
  if (routes.length === 0) return null;
  return (
    <ul className={cn('flex flex-none flex-wrap items-center justify-end gap-1', className)} aria-label="Routes">
      {routes.map((route) => (
        <li key={route.id}>
          <RoutePillView route={route} />
        </li>
      ))}
    </ul>
  );
}

export function RoutePillView({ route }: { route: RoutePill }) {
  const inUse = route.inUse && !route.down;
  const style = IN_USE[route.kind];
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center whitespace-nowrap rounded-full border text-[11px] font-medium leading-none',
        inUse ? cn('gap-[5px] pl-2 pr-2.5', style.pill) : 'px-[14.5px] border-border-secondary text-text-tertiary',
        route.down && 'line-through',
      )}
      aria-label={inUse ? `${route.label}, in use` : route.down ? `${route.label}, not available here` : route.label}
    >
      {inUse && <span className={cn('h-1.5 w-1.5 flex-none rounded-full', style.dot)} aria-hidden="true" />}
      {route.label}
    </span>
  );
}
