import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import type { OrchestrationMemberMachine } from '../../../shared/types/orchestrationSession';
import type { RunpaneWorkspaceEntry, RunpaneWorkspaceEntryKind } from '../../../shared/types/runpaneOrchestration';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { reasonOf } from '../../../shared/paneError';
import { workspaceEntrySchema } from './workspaceJournalSchema';

/** The entries a member Pane's machine sends to a Session on another computer. */
export const REMOTE_MEMBER_KINDS: ReadonlySet<RunpaneWorkspaceEntryKind> = new Set<RunpaneWorkspaceEntryKind>(['agent.report', 'agent.blocked', 'panel.exited']);

/** How many entries one catch-up read asks for; a longer backlog is read in pages. */
const PAGE = 256;

export interface RemoteMemberEventsDeps {
  machines: {
    subscribe(listener: (event: MachineConnectionsEvent) => void): () => void;
    /** Runs a host channel on a saved machine. */
    invoke(machineId: string, channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue>;
  };
  journal: {
    append(entry: Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>): RunpaneWorkspaceEntry;
    /** The newest entry recorded from this machine, which is where its next catch-up starts. */
    latestFromMachine(machineId: string): RunpaneWorkspaceEntry | undefined;
  };
  members: {
    remoteMember(paneId: string): { machine: OrchestrationMemberMachine } | undefined;
    remoteMemberPaneIds(machineId: string): string[];
  };
}

interface Received {
  entry: RunpaneWorkspaceEntry;
  epoch: string;
}

const waitResultSchema = boundary.object({
  epoch: boundary.string,
  entries: boundary.array(boundary.json),
  reset: boundary.optional(boundary.json),
});

/**
 * Records a remote Session member's reports, blocked questions and exits in this computer's
 * journal, so `runpane watch --session`, the Session inbox and Approvals treat them like a local
 * Pane's. Its machine sends each one live as `workspace:entry`; on every connect this reads that
 * machine's journal from the newest entry already recorded, so entries sent while either side was
 * away arrive too. Each entry is recorded once, in order: the cursor is the journal itself.
 */
export class RemoteMemberEvents {
  /** Live entries held while that machine's catch-up runs, recorded after it. */
  private readonly held = new Map<string, Received[]>();
  private readonly rerun = new Set<string>();

  constructor(private readonly deps: RemoteMemberEventsDeps) {}

  start(): () => void {
    return this.deps.machines.subscribe(event => {
      if (event.type === 'resync' && event.machineId !== LOCAL_MACHINE_ID) void this.catchUp(event.machineId);
      if (event.type !== 'event' || event.channel !== 'workspace:entry' || event.machineId === LOCAL_MACHINE_ID) return;
      const received = decodeReceived(event.args[0], event.args[1]);
      if (!received) return;
      const held = this.held.get(event.machineId);
      if (held) held.push(received);
      else this.record(event.machineId, received);
    });
  }

  /** Reads what the machine journalled for this computer's members since the newest entry recorded from it. */
  async catchUp(machineId: string): Promise<void> {
    if (this.held.has(machineId)) {
      this.rerun.add(machineId);
      return;
    }
    this.held.set(machineId, []);
    try {
      const paneIds = this.deps.members.remoteMemberPaneIds(machineId);
      if (paneIds.length > 0) await this.readBacklog(machineId, paneIds);
    } catch (error) {
      // The next connect reads again from the same cursor.
      console.warn(`[RemoteMemberEvents] Couldn't read ${machineId}'s journal: ${reasonOf(error)}`);
    } finally {
      const held = this.held.get(machineId) ?? [];
      this.held.delete(machineId);
      for (const received of held) this.record(machineId, received);
      if (this.rerun.delete(machineId)) void this.catchUp(machineId);
    }
  }

  private async readBacklog(machineId: string, paneIds: string[]): Promise<void> {
    const latest = this.deps.journal.latestFromMachine(machineId)?.machine;
    let request: { since: number; epoch?: string } = latest ? { since: latest.gen, epoch: latest.epoch } : { since: 0 };
    for (;;) {
      const result = decodeOptionalBoundary(await this.deps.machines.invoke(machineId, 'runpane:workspace:wait', [{
        ...request,
        timeoutMs: 0,
        limit: PAGE,
        paneIds,
        kinds: [...REMOTE_MEMBER_KINDS],
      }]), waitResultSchema);
      if (!result) throw new Error('its journal read had an unexpected shape');
      // Its journal started over: everything in the new one is unread.
      if (result.reset !== undefined) {
        request = { since: 0, epoch: result.epoch };
        continue;
      }
      const entries = result.entries.flatMap(raw => decodeOptionalBoundary(raw, workspaceEntrySchema) ?? []);
      for (const entry of entries) this.record(machineId, { entry, epoch: result.epoch });
      const last = entries.at(-1);
      if (entries.length < PAGE || !last) return;
      request = { since: last.gen, epoch: result.epoch };
    }
  }

  private record(machineId: string, { entry, epoch }: Received): void {
    if (!REMOTE_MEMBER_KINDS.has(entry.kind) || entry.replay || entry.baseline || entry.machine) return;
    const member = this.deps.members.remoteMember(entry.paneId);
    if (member?.machine.id !== machineId) return;
    const latest = this.deps.journal.latestFromMachine(machineId)?.machine;
    if (latest && latest.epoch === epoch && entry.gen <= latest.gen) return;
    this.deps.journal.append({
      kind: entry.kind,
      paneId: entry.paneId,
      paneName: entry.paneName,
      panelId: entry.panelId,
      panelTitle: entry.panelTitle,
      agentType: entry.agentType,
      source: entry.source,
      reason: entry.reason,
      exitCode: entry.exitCode,
      report: entry.report,
      screenLines: entry.screenLines,
      machine: { id: machineId, label: member.machine.label, epoch, gen: entry.gen },
    });
  }
}

function decodeReceived(entry: unknown, epoch: unknown): Received | undefined {
  const decoded = decodeOptionalBoundary(entry, workspaceEntrySchema);
  return decoded && typeof epoch === 'string' ? { entry: decoded, epoch } : undefined;
}
