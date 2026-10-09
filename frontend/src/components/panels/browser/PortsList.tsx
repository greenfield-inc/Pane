import React from 'react';
import { Check } from 'lucide-react';
import {
  LISTENING_PORT_GROUP_ORDER,
  type ListeningPort,
  type ListeningPortGroup,
  type ListeningPortsSnapshot,
} from '../../../../../shared/types/listeningPorts';
import { cn } from '../../../utils/cn';

const GROUP_LABELS = {
  'pane-terminal': 'From Pane terminals',
  other: 'Other apps',
  system: 'System',
  pane: 'Pane',
} satisfies Record<ListeningPortGroup, string>;

interface PortsListProps {
  snapshot: ListeningPortsSnapshot | null;
  /** The port the tab shows now, marked instead of offered. */
  currentPort?: number | null;
  /** False on a remote desktop: these ports are on the host, which this computer cannot reach yet. */
  canOpen: boolean;
  onOpen(port: number): void;
}

/** The host's listening ports, grouped by who opened them. Web ports open in the tab. */
export const PortsList: React.FC<PortsListProps> = ({ snapshot, currentPort, canOpen, onOpen }) => {
  if (!snapshot) {
    return <p className="px-3 py-2 text-xs text-text-tertiary">Reading ports…</p>;
  }
  if (snapshot.ports.length === 0) {
    return <p className="px-3 py-2 text-xs text-text-tertiary">No listening ports on {snapshot.host}</p>;
  }
  return (
    <div className="py-1">
      {LISTENING_PORT_GROUP_ORDER.map(group => {
        const ports = snapshot.ports.filter(port => port.group === group);
        if (ports.length === 0) return null;
        return (
          <section key={group} aria-label={GROUP_LABELS[group]} className="mt-1 first:mt-0">
            <h3 className="flex items-center justify-between px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
              <span>{GROUP_LABELS[group]}</span>
              <span>{ports.length}</span>
            </h3>
            {ports.map(port => (
              <PortRow key={port.port} port={port} isCurrent={port.port === currentPort} canOpen={canOpen} onOpen={onOpen} />
            ))}
          </section>
        );
      })}
    </div>
  );
};

const PortRow: React.FC<{ port: ListeningPort; isCurrent: boolean; canOpen: boolean; onOpen(port: number): void }> = ({ port, isCurrent, canOpen, onOpen }) => {
  const isWeb = port.kind === 'web';
  const opens = isWeb && canOpen;
  const content = (
    <>
      <span className="w-12 flex-shrink-0 font-mono text-xs font-semibold text-text-primary">{port.port}</span>
      <span className="min-w-0 truncate text-xs text-text-secondary">{port.process || 'unknown'}</span>
      <span
        className={cn(
          'flex-shrink-0 rounded border px-1 font-mono text-[10px] leading-4',
          isWeb ? 'border-current text-status-success' : 'border-border-primary text-text-tertiary',
        )}
      >
        {port.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{port.paneName}</span>
      {/* One fixed slot for the swapping indicator: Open, the current-page check, or nothing. */}
      <span className="flex w-10 flex-shrink-0 justify-end text-xs text-interactive">
        {opens && (isCurrent ? <Check className="h-3.5 w-3.5" aria-label="Open in this tab" /> : 'Open')}
      </span>
    </>
  );
  const rowClass = 'flex w-full items-center gap-2 px-3 py-1 text-left';
  if (!opens) {
    return <div className={rowClass} title={isWeb ? undefined : `${port.port} does not answer HTTP`}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(port.port)}
      className={cn(rowClass, 'transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring-subtle', isCurrent && 'bg-surface-selected')}
      title={`Open localhost:${port.port}`}
    >
      {content}
    </button>
  );
};
