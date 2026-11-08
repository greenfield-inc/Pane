import { useEffect, useState } from 'react';
import { ExternalLink, GitBranch, MessageSquare } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { ToolPanel } from '../../../../shared/types/panels';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { SessionProvider } from '../../contexts/SessionProvider';
import { panelApi } from '../../services/panelApi';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { openOnMachine } from '../../utils/machineRowActions';
import { PanelContainer } from '../panels/PanelContainer';
import { SessionBeside } from '../PaneChatView';
import { MachineContext } from './MachineContext';
import { besideOf } from './approvalGroups';

/**
 * The column's origin tab in a Session and in Autopilot (D-289): the chat where it was asked,
 * live, as the Approvals screen shows it. An orchestrator's item shows its Session; a worker's or
 * a standalone Pane's item shows the asking tab itself; another machine's item says where it is.
 */
export function ApprovalOrigin({ item }: { item: NotifyItem }) {
  const activeMachineId = useAllMachinesStore((state) => state.entries.find((entry) => entry.active)?.id ?? LOCAL_MACHINE_ID);
  const beside = besideOf(item, activeMachineId);
  const machineId = item.machineId ?? activeMachineId;
  if (beside.kind === 'machine') {
    return <div className="absolute inset-0 flex flex-col" data-testid="approval-origin"><MachineContext item={item} machine={beside.machine} connectedName={beside.connected.name} /></div>;
  }
  if (beside.kind === 'session') {
    return (
      <div className="absolute inset-0 flex flex-col" data-testid="approval-origin">
        <OriginHeader icon="session" name={beside.name} onOpen={() => void openOnMachine(machineId, { kind: 'session', id: beside.sessionId, name: beside.name })} />
        <SessionBeside key={beside.sessionId} sessionId={beside.sessionId} />
      </div>
    );
  }
  if (beside.kind === 'pane') {
    return (
      <div className="absolute inset-0 flex flex-col" data-testid="approval-origin">
        <OriginHeader icon="pane" name={beside.name} onOpen={() => void openOnMachine(machineId, { kind: 'pane', id: beside.paneId, name: beside.name })} />
        <AskingTab paneId={beside.paneId} panelId={beside.panelId} />
      </div>
    );
  }
  return <p className="p-6 text-[13px] text-text-tertiary" data-testid="approval-origin">Asked in {item.source.name}; its chat is no longer open.</p>;
}

function OriginHeader({ icon, name, onOpen }: { icon: 'session' | 'pane'; name: string; onOpen: () => void }) {
  const Icon = icon === 'session' ? MessageSquare : GitBranch;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-primary px-4 text-[13px]">
      <Icon className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
      <span className="text-text-tertiary">{icon === 'session' ? 'Session' : 'Pane'}</span>
      <span className="min-w-0 truncate font-semibold text-text-primary">{name}</span>
      <button type="button" onClick={onOpen} className="ml-auto inline-flex shrink-0 items-center gap-1 text-text-tertiary hover:text-text-primary">
        Open in Pane <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The tab that asked, live, inside its own Pane's context; its Pane's panels load here if no view has them yet. */
function AskingTab({ paneId, panelId }: { paneId: string; panelId?: string }) {
  const pane = useSessionStore((state) => state.sessions.find((candidate) => candidate.id === paneId));
  const stored = usePanelStore((state) => state.panels[paneId]);
  const [loaded, setLoaded] = useState<ToolPanel[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (stored?.length) return;
    let live = true;
    // Read only: this Pane's own view owns its store entry and layout.
    panelApi.loadPanelsForSession(paneId).then((panels) => { if (live) setLoaded(panels); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [paneId, stored?.length]);
  const panels = stored?.length ? stored : loaded ?? [];
  const panel = panels.find((candidate) => candidate.id === panelId) ?? panels.find((candidate) => candidate.type === 'terminal' || candidate.type === 'chat');
  if (!pane || failed) return <p className="p-6 text-[13px] text-text-tertiary">The Pane that asked isn't open here.</p>;
  if (!panel) return <p className="p-6 text-[13px] text-text-tertiary">{loaded || stored ? 'Its tab is no longer open.' : 'Loading its tab…'}</p>;
  return (
    <div className="relative min-h-0 flex-1" data-testid="approval-origin-tab">
      <SessionProvider session={pane}>
        <PanelContainer panel={panel} isActive autoFocus={false} />
      </SessionProvider>
    </div>
  );
}
