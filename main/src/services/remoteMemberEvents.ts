import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';
import { LOCAL_MACHINE_ID } from '../../../shared/types/machineConnections';
import type { OrchestrationMemberMachine } from '../../../shared/types/orchestrationSession';
import type { RunpaneWorkspaceEntry, RunpaneWorkspaceEntryKind } from '../../../shared/types/runpaneOrchestration';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { reasonOf } from '../../../shared/paneError';
import { workspaceEntrySchema } from './workspaceJournalSchema';

/**
 * The entries a member Pane's machine sends to a Session on another computer. `agent.busy` clears
 * a blocked item once the worker moves on, as it does for a local Pane.
 */
export const REMOTE_MEMBER_KINDS: ReadonlySet<RunpaneWorkspaceEntryKind> = new Set<RunpaneWorkspaceEntryKind>(['agent.report', 'agent.blocked', 'agent.busy', 'panel.exited']);

/** Journal resets one catch-up follows (a truncated cursor, then a new epoch) before it gives up until the next connect. */
const MAX_RESETS = 3;

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
  };
  members: {
    remoteMember(paneId: string): { machine: OrchestrationMemberMachine } | undefined;
    remoteMemberPaneIds(machineId: string): string[];
    /** Where the machine's next catch-up starts: the newest entry recorded from it. */
    remoteCursor(machineId: string): JournalPosition | undefined;
    saveRemoteCursor(machineId: string, cursor: JournalPosition): void;
  };
}

interface Received {
  entry: RunpaneWorkspaceEntry;
  epoch: string;
}

/** Where a catch-up read starts in a machine's journal. */
interface JournalCursor {
  since: number;
  epoch?: string;
}

/** An entry's place in a machine's journal. */
interface JournalPosition {
  epoch: string;
  gen: number;
}

const waitResultSchema = boundary.object({
  epoch: boundary.string,
  entries: boundary.array(boundary.json),
  reset: boundary.optional(boundary.object({ reason: boundary.string })),
  dropped: boundary.optional(boundary.number),
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
      const [rawEntry, rawEpoch] = event.args;
      const entry = decodeOptionalBoundary(rawEntry, workspaceEntrySchema);
      const epoch = decodeOptionalBoundary(rawEpoch, boundary.string);
      if (!entry || epoch === undefined) return;
      const received: Received = { entry, epoch };
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
    const latest = this.deps.members.remoteCursor(machineId);
    let request: JournalCursor = latest ? { since: latest.gen, epoch: latest.epoch } : { since: 0 };
    let resets = 0;
    for (;;) {
      const result = decodeOptionalBoundary(await this.deps.machines.invoke(machineId, 'runpane:workspace:wait', [{
        ...request,
        timeoutMs: 0,
        limit: PAGE,
        paneIds,
        kinds: [...REMOTE_MEMBER_KINDS],
      }]), waitResultSchema);
      if (!result) throw new Error('its journal read had an unexpected shape');
      if (result.reset !== undefined) {
        if (++resets > MAX_RESETS) throw new Error(`its journal kept resetting (${result.reset.reason})`);
        // Older entries rolled out of its journal: read on from the oldest it still keeps.
        if (result.reset.reason === 'cursor-truncated' && result.dropped !== undefined) request = { since: request.since + result.dropped, epoch: result.epoch };
        // Its journal started over: everything in the new one is unread.
        else request = { since: 0, epoch: result.epoch };
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
    const latest = this.deps.members.remoteCursor(machineId);
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
    this.deps.members.saveRemoteCursor(machineId, { epoch, gen: entry.gen });
  }
}
