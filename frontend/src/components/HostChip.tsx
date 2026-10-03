import { HOST_ICONS } from '../utils/hostKind';
import { formatHostChipText, type ActiveHost } from '../utils/hostRepoActions';

/** Names the host a repo dialog acts on, e.g. "On: sandbox-1 (cloud sandbox)". */
export function HostChip({ host }: { host: ActiveHost }) {
  const Icon = HOST_ICONS[host.icon];
  return (
    <div
      data-host-icon={host.icon}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-secondary bg-surface-secondary px-2.5 py-1 text-xs text-text-secondary"
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{formatHostChipText(host)}</span>
    </div>
  );
}
