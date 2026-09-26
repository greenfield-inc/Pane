import { randomUUID } from 'crypto';
import type { PaneEventArgument, PaneEventSink } from '../core/eventSink';
import type { AgentState } from '../../../shared/types/agentStatus';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { extractWorkspaceHeldInput } from './workspaceHeldInput';
import type {
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
} from '../../../shared/types/runpaneOrchestration';

export interface WorkspacePaneMetadata {
  paneId: string;
  paneName: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
}

interface WorkspacePanelMetadata {
  panelId: string;
  paneId: string;
  isCliPanel?: boolean;
  agentType?: string;
  panelTitle?: string;
  lastActivityAt?: string;
  /** Latest terminal screen text; held input is derived from it, ignoring composer placeholders. */
  screenText?: string;
}

export interface WorkspaceJournalFilter {
  kinds?: readonly RunpaneWorkspaceEntryKind[];
  paneIds?: readonly string[];
  excludePaneIds?: readonly string[];
  repoId?: number;
  nameContains?: string;
  agentsOnly?: boolean;
  includeHeldInput?: boolean;
  includeHeldInputPresence?: boolean;
}

export interface WorkspaceJournalReadResult {
  entries: RunpaneWorkspaceEntry[];
  generation: number;
  dropped?: number;
}

interface WorkspaceWaiter {
  cursor: number;
  filter: WorkspaceJournalFilter;
  limit: number;
  key: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: WorkspaceJournalReadResult & { timedOut: boolean }): void;
}

interface WorkspaceJournalOptions {
  capacity?: number;
  now?: () => number;
  resolvePane?: (paneId: string) => WorkspacePaneMetadata | undefined;
  resolvePanel?: (panelId: string) => WorkspacePanelMetadata | undefined;
}

const DEFAULT_CAPACITY = 4096;
const MAX_WAITERS = 64;
const MAX_WAITERS_PER_KEY = 8;
const agentStateSchema = boundary.enumeration('blocked', 'working', 'idle', 'unknown');
const sessionEventSchema = boundary.object({
  id: boundary.string,
  name: boundary.optional(boundary.string),
  projectId: boundary.optional(boundary.number),
  worktreePath: boundary.optional(boundary.string),
});
const agentStatusEventSchema = boundary.object({
  panelId: boundary.string,
  sessionId: boundary.string,
  state: agentStateSchema,
  reason: boundary.optional(boundary.nullable(boundary.string)),
});
const panelExitEventSchema = boundary.object({
  type: boundary.string,
  source: boundary.object({
    panelId: boundary.string,
    sessionId: boundary.string,
  }),
  data: boundary.object({
    exitCode: boundary.optional(boundary.number),
    signal: boundary.optional(boundary.number),
  }),
});

export class WorkspaceJournal implements PaneEventSink {
  readonly epoch = randomUUID();
  private readonly ring: RunpaneWorkspaceEntry[] = [];
  private readonly paneById = new Map<string, WorkspacePaneMetadata>();
  private readonly stateByPanel = new Map<string, AgentState>();
  private readonly readySinceByPanel = new Map<string, number>();
  private readonly exitedPanels = new Set<string>();
  private readonly waiters = new Set<WorkspaceWaiter>();
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly resolvePane?: WorkspaceJournalOptions['resolvePane'];
  private readonly resolvePanel?: WorkspaceJournalOptions['resolvePanel'];
  private nextGeneration = 0;

  constructor(options: WorkspaceJournalOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.now = options.now ?? Date.now;
    this.resolvePane = options.resolvePane;
    this.resolvePanel = options.resolvePanel;
  }

  get generation(): number {
    return this.nextGeneration;
  }

  get oldestGeneration(): number {
    return this.ring[0]?.gen ?? this.nextGeneration + 1;
  }

  readySince(panelId: string): number | undefined {
    return this.readySinceByPanel.get(panelId);
  }

  rememberPane(metadata: WorkspacePaneMetadata): void {
    this.paneById.set(metadata.paneId, metadata);
  }

  append(entry: Omit<RunpaneWorkspaceEntry, 'gen' | 'at'>): RunpaneWorkspaceEntry {
    const full: RunpaneWorkspaceEntry = {
      ...entry,
      gen: ++this.nextGeneration,
      at: new Date(this.now()).toISOString(),
    };
    this.ring.push(full);
    if (this.ring.length > this.capacity) this.ring.shift();
    this.resolveWaiters();
    return full;
  }

  readAfter(cursor: number, filter: WorkspaceJournalFilter = {}, limit = 256): WorkspaceJournalReadResult {
    const firstAvailableCursor = this.oldestGeneration - 1;
    const dropped = cursor < firstAvailableCursor ? firstAvailableCursor - cursor : undefined;
    const effectiveCursor = Math.max(cursor, firstAvailableCursor);
    const matchingEntries = this.ring
      .filter(entry => entry.gen > effectiveCursor && matchesFilter(entry, filter));
    const entries = matchingEntries
      .slice(0, Math.max(1, limit))
      .map(entry => projectWorkspaceEntry(entry, filter));
    const generation = matchingEntries.length > entries.length
      ? entries.at(-1)?.gen ?? effectiveCursor
      : this.nextGeneration;
    return { entries, generation, dropped };
  }

  waitAfter(
    cursor: number,
    filter: WorkspaceJournalFilter,
    timeoutMs: number,
    limit = 256,
    key = 'anonymous',
  ): Promise<WorkspaceJournalReadResult & { timedOut: boolean }> {
    const existing = this.readAfter(cursor, filter, limit);
    if (existing.entries.length > 0 || existing.dropped || timeoutMs === 0) {
      return Promise.resolve({ ...existing, timedOut: existing.entries.length === 0 });
    }

    if (this.waiters.size >= MAX_WAITERS) {
      return Promise.reject(new Error(`Workspace watch limit reached (${MAX_WAITERS})`));
    }
    const keyCount = [...this.waiters].filter(waiter => waiter.key === key).length;
    if (keyCount >= MAX_WAITERS_PER_KEY) {
      return Promise.reject(new Error(`Workspace watch limit reached for ${key} (${MAX_WAITERS_PER_KEY})`));
    }

    return new Promise((resolve) => {
      const waiter: WorkspaceWaiter = {
        cursor,
        filter,
        limit,
        key,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve({ ...this.readAfter(cursor, filter, limit), timedOut: true });
        }, timeoutMs),
        resolve,
      };
      this.waiters.add(waiter);
    });
  }

  send(channel: string, ...args: PaneEventArgument[]): void {
    if (channel === 'session:created' || channel === 'session:updated') {
      const payload = decodeOptionalBoundary(args[0], sessionEventSchema);
      if (!payload) return;
      const pane = paneMetadataFromEvent(payload, this.resolvePane);
      if (!pane) return;
      this.rememberPane(pane);
      if (channel === 'session:created') {
        this.append({ ...pane, kind: 'pane.created', source: 'session' });
      }
      return;
    }

    if (channel === 'session:deleted') {
      const payload = decodeOptionalBoundary(args[0], boundary.object({ id: boundary.string }));
      if (!payload) return;
      const paneId = payload.id;
      const pane = this.lookupPane(paneId);
      if (!pane) return;
      this.append({ ...pane, kind: 'pane.gone', source: 'session' });
      this.paneById.delete(paneId);
      return;
    }

    if (channel === 'panel:agentStatus') {
      const payload = decodeOptionalBoundary(args[0], agentStatusEventSchema);
      if (!payload) return;
      this.consumeAgentStatus(payload);
      return;
    }

    if (channel === 'panel:event') {
      const payload = decodeOptionalBoundary(args[0], panelExitEventSchema);
      if (!payload) return;
      if (payload.type === 'terminal:started') {
        this.exitedPanels.delete(payload.source.panelId);
        this.stateByPanel.delete(payload.source.panelId);
        this.readySinceByPanel.delete(payload.source.panelId);
        return;
      }
      if (payload.type !== 'terminal:exit') return;
      const { panelId, sessionId: paneId } = payload.source;
      if (this.exitedPanels.has(panelId)) return;
      this.exitedPanels.add(panelId);
      this.stateByPanel.delete(panelId);
      this.readySinceByPanel.delete(panelId);
      const pane = this.lookupPane(paneId);
      if (!pane) return;
      const panel = this.resolvePanel?.(panelId);
      this.append({
        ...pane,
        kind: 'panel.exited',
        panelId,
        panelTitle: panel?.panelTitle,
        agentType: panel?.agentType,
        source: 'exit',
        exitCode: payload.data.exitCode,
        reason: payload.data.signal === undefined ? 'terminal:exit' : `signal:${payload.data.signal}`,
      });
    }
  }

  dispose(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ...this.readAfter(waiter.cursor, waiter.filter, waiter.limit), timedOut: true });
    }
    this.waiters.clear();
  }

  private consumeAgentStatus(payload: {
    panelId: string;
    sessionId: string;
    state: AgentState;
    reason?: string | null;
  }): void {
    const { panelId, sessionId: paneId, state } = payload;
    const panel = this.resolvePanel?.(panelId);
    if (!panel?.isCliPanel) return;

    const previous = this.stateByPanel.get(panelId);
    this.stateByPanel.set(panelId, state);
    if (state !== 'idle') this.readySinceByPanel.delete(panelId);
    if (previous === state) return;

    const kind = agentEntryKind(state, previous);
    if (!kind) return;
    const pane = this.lookupPane(paneId);
    if (!pane) return;
    const now = this.now();
    if (kind === 'agent.ready') this.readySinceByPanel.set(panelId, now);
    const lastActivityMs = panel?.lastActivityAt ? Date.parse(panel.lastActivityAt) : Number.NaN;
    const settledMs = kind === 'agent.ready' && Number.isFinite(lastActivityMs)
      ? Math.max(0, now - lastActivityMs)
      : undefined;
    const heldInput = kind === 'agent.ready' && panel?.screenText ? extractWorkspaceHeldInput(panel.screenText) : undefined;
    const entry: Omit<RunpaneWorkspaceEntry, 'gen' | 'at'> = {
      ...pane,
      kind,
      panelId,
      panelTitle: panel?.panelTitle,
      agentType: panel?.agentType,
      from: previous,
      to: state,
      source: payload.reason === 'exit' ? 'exit' : 'agent',
      reason: payload.reason ?? null,
      settledMs,
    };
    if (heldInput) entry.heldInput = heldInput;
    this.append(entry);
  }

  private lookupPane(paneId: string): WorkspacePaneMetadata | undefined {
    const existing = this.paneById.get(paneId);
    if (existing) return existing;
    const resolved = this.resolvePane?.(paneId);
    if (resolved) this.rememberPane(resolved);
    return resolved;
  }

  private resolveWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const result = this.readAfter(waiter.cursor, waiter.filter, waiter.limit);
      if (result.entries.length === 0 && !result.dropped) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve({ ...result, timedOut: false });
    }
  }
}

function agentEntryKind(state: AgentState, previous: AgentState | undefined): RunpaneWorkspaceEntryKind | undefined {
  if (state === 'idle') {
    return previous === 'working' || previous === 'blocked' ? 'agent.ready' : undefined;
  }
  if (state === 'working') return 'agent.busy';
  if (state === 'blocked') return 'agent.blocked';
  return 'agent.unknown';
}

/** Stable identity of a filter, for keying per-consumer state. */
export function workspaceFilterKey(filter: WorkspaceJournalFilter): string {
  return JSON.stringify({
    kinds: [...filter.kinds ?? []].sort(),
    paneIds: [...filter.paneIds ?? []].sort(),
    excludePaneIds: [...filter.excludePaneIds ?? []].sort(),
    repoId: filter.repoId ?? null,
    nameContains: filter.nameContains ?? null,
    agentsOnly: filter.agentsOnly ?? null,
    includeHeldInput: filter.includeHeldInput ?? null,
    includeHeldInputPresence: filter.includeHeldInputPresence ?? null,
  });
}

export function matchesFilter(entry: RunpaneWorkspaceEntry, filter: WorkspaceJournalFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(entry.kind)) return false;
  if (filter.paneIds && !filter.paneIds.includes(entry.paneId)) return false;
  if (filter.excludePaneIds && filter.excludePaneIds.includes(entry.paneId)) return false;
  if (filter.repoId !== undefined && entry.repoId !== filter.repoId) return false;
  if (filter.nameContains && !entry.paneName.toLocaleLowerCase().includes(filter.nameContains.toLocaleLowerCase())) return false;
  if (filter.agentsOnly && !entry.agentType && entry.kind !== 'pane.created' && entry.kind !== 'pane.gone') return false;
  return true;
}

export function projectWorkspaceEntry(
  entry: RunpaneWorkspaceEntry,
  filter: WorkspaceJournalFilter,
): RunpaneWorkspaceEntry {
  const projected = { ...entry };
  if (!filter.includeHeldInput) delete projected.heldInput;
  if (filter.includeHeldInputPresence && (entry.heldInputPresent || entry.heldInput !== undefined)) {
    projected.heldInputPresent = true;
  } else {
    delete projected.heldInputPresent;
  }
  return projected;
}

function paneMetadataFromEvent(
  payload: {
    id: string;
    name?: string;
    projectId?: number;
    worktreePath?: string;
  },
  resolvePane: WorkspaceJournalOptions['resolvePane'],
): WorkspacePaneMetadata | undefined {
  const paneId = payload.id;
  const resolved = resolvePane?.(paneId);
  return {
    paneId,
    paneName: payload.name ?? resolved?.paneName ?? paneId,
    repoId: payload.projectId ?? resolved?.repoId,
    repoName: resolved?.repoName,
    worktreePath: payload.worktreePath ?? resolved?.worktreePath,
  };
}
