import type { PaneEventArgument, PaneEventSink } from '../core/eventSink';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { OrchestrationSessionSummary } from '../../../shared/types/orchestrationSession';
import {
  SESSION_SNAPSHOT_MESSAGE_LIMIT,
  type SessionSnapshot,
  type SessionSnapshotHeld,
  type SessionSnapshotOmittedData,
  type SessionSnapshotsRequest,
  type SessionSnapshotsResult,
} from '../../../shared/types/sessionSnapshot';
import type { ChatTabTranscript, ChatTabView } from '../../../shared/types/chatTab';
import type { AgentChatMessage, AgentChatPart } from '../../../shared/types/agentChat';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';

/** The fewest milliseconds between two notices for one Session (the same pace as recent.json's writes). */
const SNAPSHOT_NOTICE_INTERVAL_MS = 1000;
/** Inline attachment bytes longer than this are left out of a snapshot and named by their length. */
const INLINE_DATA_LIMIT = 4096;
/** A list read this old is read again even with no change heard, in case one was missed. */
const LIST_MAX_AGE_MS = 60_000;
/** Changes to a Session's order or which one is selected: neither is in a snapshot. */
const UNSHOWN_CHANGES: ReadonlySet<string> = new Set(['reordered', 'selected']);

/** What the service reads on the host. None of them may create a tab, start an agent or write. */
export interface SessionSnapshotSources {
  /** Every Session as a summary list holds it. */
  sessions(): Promise<OrchestrationSessionSummary[]>;
  /** A Pane's tabs, as `panels:list` returns them. */
  tabs(paneId: string): ToolPanel[];
  panel(panelId: string): ToolPanel | undefined;
  layout(paneId: string): SessionPanelLayout | null;
  /** A chat tab's view with its newest `limit` messages, read without starting it; undefined when it is gone. */
  chat(panelId: string, limit: number): ChatTabView | undefined;
  /** Sends `session-snapshot:changed` on the event stream. */
  announce(sessionId: string, revision: number): void;
}

interface ChatSession {
  record: OrchestrationSessionSummary;
  chatPanelId: string;
}

interface NoticePace {
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sessionChangeSchema = boundary.object({ sessionId: boundary.string, kind: boundary.optional(boundary.string) });
const paneEventSchema = boundary.object({ sessionId: boundary.string });
const panelEventSchema = boundary.object({ panelId: boundary.string });

/**
 * Host snapshots (T-116 PR 4): a small, ready copy of each unarchived chat Session for the owner's
 * other machines, and a notice on the event stream when one changes. It watches the events this
 * Pane already sends (it is one of the event sinks), keeps only revision numbers, and builds a
 * snapshot when one is read. Reading never creates a tab, starts an agent or writes.
 *
 * Revisions are milliseconds since 1970, kept rising: every Session reads as changed at the time
 * this Pane started, so a desktop that last read before a restart reads everything again.
 */
export class SessionSnapshotService implements PaneEventSink {
  private last = 0;
  private readonly started: number;
  private readonly revisions = new Map<string, number>();
  private readonly paces = new Map<string, NoticePace>();
  /** The chat Sessions as last read, by id and by their own Pane. */
  private known = new Map<string, ChatSession>();
  private sessionByPane = new Map<string, string>();
  /** The list read under way, and how many changes had been heard when it was asked for. */
  private refreshing?: { read: Promise<void>; changes: number };
  /** Counts Session changes heard; the list is read again when it was read before the latest. */
  private listChanges = 0;
  private listedChanges = -1;
  private listedAt = -Infinity;
  private disposed = false;

  constructor(private readonly sources: SessionSnapshotSources) {
    this.started = this.nextRevision();
  }

  /** Watches what this Pane sends; changes to a chat Session's snapshot raise its revision. */
  send(channel: string, ...args: PaneEventArgument[]): void {
    if (this.disposed) return;
    const [payload] = args;
    switch (channel) {
      case 'orchestration-sessions:changed': {
        const change = decodeOptionalBoundary(payload, sessionChangeSchema);
        if (!change?.sessionId || UNSHOWN_CHANGES.has(change.kind ?? '')) return;
        // A chat Session it knows changed now. The list is read again for new, archived and switched
        // Sessions; one that has just become a chat Session is announced once it is known.
        const wasKnown = this.known.has(change.sessionId);
        this.listChanges += 1;
        if (wasKnown) this.changed(change.sessionId);
        void this.refresh().then(() => {
          if (!wasKnown && this.known.has(change.sessionId)) this.changed(change.sessionId);
        }, error => console.warn('[Session snapshots] Could not read the Session list:', error));
        return;
      }
      case 'panel:created':
      case 'panel:updated': {
        const panel = decodeOptionalBoundary(payload, paneEventSchema);
        if (panel) this.paneChanged(panel.sessionId);
        return;
      }
      case 'panel:deleted':
      case 'panel:layoutChanged': {
        const change = decodeOptionalBoundary(payload, paneEventSchema);
        if (change) this.paneChanged(change.sessionId);
        return;
      }
      case 'chat-tab:event':
      case 'chat-tab:view': {
        const change = decodeOptionalBoundary(payload, panelEventSchema);
        const paneId = change && this.sources.panel(change.panelId)?.sessionId;
        if (paneId) this.paneChanged(paneId);
        return;
      }
      default:
    }
  }

  /** `orchestration-sessions:snapshots`: the snapshots newer than `since`, with only the messages after what the desktop holds. */
  async snapshots(request: SessionSnapshotsRequest): Promise<SessionSnapshotsResult> {
    // Taken before reading, so a change made while this read runs is read again next time.
    const revision = this.last;
    // The list is read only after a Session changed: each pull would otherwise copy every record.
    if (this.listedChanges !== this.listChanges || Date.now() - this.listedAt > LIST_MAX_AGE_MS) await this.refresh();
    const since = request.since;
    const snapshots: SessionSnapshot[] = [];
    const sessionIds: string[] = [];
    for (const { record, chatPanelId } of this.known.values()) {
      const sessionRevision = this.revisionOf(record.id);
      if (since !== undefined && sessionRevision <= since) {
        sessionIds.push(record.id);
        continue;
      }
      const chat = this.sources.chat(chatPanelId, SESSION_SNAPSHOT_MESSAGE_LIMIT);
      if (!chat) continue;
      sessionIds.push(record.id);
      snapshots.push({
        sessionId: record.id,
        revision: sessionRevision,
        session: record,
        chat: { ...chat, transcript: chat.transcript && withoutInlineData(after(chat.transcript, chat.messageCount, request.held?.[record.id])) },
        tabs: this.sources.tabs(record.internalSessionId),
        layout: this.sources.layout(record.internalSessionId),
      });
    }
    return { revision, sessionIds, snapshots };
  }

  dispose(): void {
    this.disposed = true;
    for (const pace of this.paces.values()) clearTimeout(pace.timer);
    this.paces.clear();
  }

  private paneChanged(paneId: string): void {
    const sessionId = this.sessionByPane.get(paneId);
    if (sessionId) this.changed(sessionId);
  }

  private changed(sessionId: string): void {
    if (this.disposed) return;
    this.revisions.set(sessionId, this.nextRevision());
    const pace = this.paces.get(sessionId) ?? { sentAt: -Infinity };
    this.paces.set(sessionId, pace);
    if (pace.timer) return;
    const wait = pace.sentAt + SNAPSHOT_NOTICE_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.announce(sessionId, pace);
      return;
    }
    pace.timer = setTimeout(() => {
      pace.timer = undefined;
      this.announce(sessionId, pace);
    }, wait);
  }

  private announce(sessionId: string, pace: NoticePace): void {
    if (this.disposed) return;
    pace.sentAt = Date.now();
    this.sources.announce(sessionId, this.revisionOf(sessionId));
  }

  private revisionOf(sessionId: string): number {
    return this.revisions.get(sessionId) ?? this.started;
  }

  private nextRevision(): number {
    this.last = Math.max(Date.now(), this.last + 1);
    return this.last;
  }

  /**
   * Reads which Sessions are chat Sessions now. A read under way is shared when it was asked for
   * after the latest change; otherwise another read follows it, so it can't miss that change.
   */
  private refresh(): Promise<void> {
    const changes = this.listChanges;
    const current = this.refreshing;
    if (current && current.changes >= changes) return current.read;
    const read = (current?.read ?? Promise.resolve()).catch(() => undefined).then(() => this.readSessions());
    const entry = { read, changes };
    this.refreshing = entry;
    void read.catch(() => undefined).finally(() => { if (this.refreshing === entry) this.refreshing = undefined; });
    return read;
  }

  private async readSessions(): Promise<void> {
    const changes = this.listChanges;
    const listedAt = Date.now();
    const known = new Map<string, ChatSession>();
    const sessionByPane = new Map<string, string>();
    for (const record of await this.sources.sessions()) {
      if (record.archived === true || record.move?.state === 'arriving') continue;
      const chatPanelId = record.panelIds[record.agent];
      if (this.sources.panel(chatPanelId)?.type !== 'chat') continue;
      known.set(record.id, { record, chatPanelId });
      sessionByPane.set(record.internalSessionId, record.id);
    }
    this.known = known;
    this.sessionByPane = sessionByPane;
    this.listedChanges = changes;
    this.listedAt = listedAt;
  }
}

/**
 * The window from the last message the desktop holds on (it may have grown since), or the whole
 * window when the desktop holds another conversation or too little to join it up.
 */
function after(transcript: ChatTabTranscript, messageCount: number, held: SessionSnapshotHeld | undefined): ChatTabTranscript {
  if (!held || held.generation !== transcript.generation || held.count > messageCount) return transcript;
  const from = Math.max(0, held.count - 1);
  if (from < transcript.start) return transcript;
  return { ...transcript, start: from, messages: transcript.messages.slice(from - transcript.start) };
}

function withoutInlineData(transcript: ChatTabTranscript): ChatTabTranscript {
  return { ...transcript, messages: transcript.messages.map(lighterMessage) };
}

function lighterMessage(message: AgentChatMessage): AgentChatMessage {
  return { ...message, parts: message.parts.map(lighterPart) };
}

function lighterPart(part: AgentChatPart): AgentChatPart {
  if (part.type === 'content') return { ...part, content: lighterBlock(part.content) };
  if (part.type !== 'tool' || !part.content) return part;
  return { ...part, content: part.content.map(lighterToolContent) };
}

/** A tool call's content entry; `{ type: 'content', content }` holds a content block (ACP `ToolCallContent`). */
function lighterToolContent(entry: JsonValue): JsonValue {
  const object = decodeOptionalBoundary(entry, boundary.jsonObject);
  if (object?.type !== 'content' || object.content === undefined) return entry;
  return { ...object, content: lighterBlock(object.content) };
}

/** A content block without an image's or audio's long `data`, or an embedded resource's long `blob` (ACP `ContentBlock`). */
function lighterBlock(block: JsonValue): JsonValue {
  const object = decodeOptionalBoundary(block, boundary.jsonObject);
  if (!object) return block;
  const result = withoutLong(object, 'data');
  const resource = decodeOptionalBoundary(object.resource, boundary.jsonObject);
  if (resource) result.resource = withoutLong(resource, 'blob');
  return result;
}

function withoutLong(object: JsonObject, field: SessionSnapshotOmittedData['omitted']['field']): JsonObject {
  const value = decodeOptionalBoundary(object[field], boundary.string);
  if (value === undefined || value.length <= INLINE_DATA_LIMIT) return { ...object };
  const { [field]: _omitted, ...rest } = object;
  const omitted: SessionSnapshotOmittedData['omitted'] = { field, length: value.length };
  return { ...rest, omitted: { ...omitted } };
}
