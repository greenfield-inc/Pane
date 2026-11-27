import { randomUUID } from 'crypto';
import type { PaneEventArgument, PaneEventSink } from '../core/eventSink';
import { isReadableTabType, readableCopy } from '../daemon/accessLevel';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
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
import type { AgentChatPart } from '../../../shared/types/agentChat';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';

/** The fewest milliseconds between two notices for one Session (the same pace as recent.json's writes). */
const SNAPSHOT_NOTICE_INTERVAL_MS = 1000;
/** A string longer than this outside a message's own text (an image's bytes, a file, a tool's output) is left out and named by its length. */
const INLINE_DATA_LIMIT = 4096;
/** The message changes remembered per chat; a desktop holding an older revision gets the whole window. */
const TRACKED_CHANGES = 500;
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

/** Which messages of one chat changed, and at which transcript revision, since this Pane began watching it. */
interface ChatChanges {
  generation: number;
  /** The first revision watched: changes from it on are all in `changed`. */
  from: number;
  /** The last revision heard. */
  latest: number;
  /** Message index → the revision that last changed it, oldest change first. */
  changed: Map<number, number>;
}

interface NoticePace {
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sessionChangeSchema = boundary.object({ sessionId: boundary.string, kind: boundary.optional(boundary.string) });
const paneEventSchema = boundary.object({ sessionId: boundary.string });
const panelEventSchema = boundary.object({ panelId: boundary.string });
const chatEventSchema = boundary.object({ panelId: boundary.string, generation: boundary.number, revision: boundary.number, index: boundary.optional(boundary.number) });

/**
 * Host snapshots (T-116 PR 4): a small, ready copy of each unarchived chat Session for the owner's
 * other machines, and a notice on the event stream when one changes. It watches the events this
 * Pane already sends (it is one of the event sinks), keeps only revision numbers, and builds a
 * snapshot when one is read. Reading never creates a tab, starts an agent or writes.
 *
 * Revisions are milliseconds since 1970, kept rising, and an answer names this Pane's run (`epoch`):
 * a desktop whose last answer came from another run (a restart, maybe with the clock set back)
 * reads everything again. What leaves this machine is the read-only projection (`readableCopy`):
 * no launch settings, and tabs cut to what a tab shows (D-11).
 */
export class SessionSnapshotService implements PaneEventSink {
  private last = 0;
  private readonly started: number;
  private readonly epoch = randomUUID();
  private readonly chats = new Map<string, ChatChanges>();
  private readonly revisions = new Map<string, number>();
  private readonly paces = new Map<string, NoticePace>();
  /** The chat Sessions as last read, by id and by their own Pane. */
  private known = new Map<string, ChatSession>();
  private sessionByPane = new Map<string, string>();
  private sessionByChat = new Map<string, string>();
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
      case 'chat-tab:event': {
        const event = decodeOptionalBoundary(payload, chatEventSchema);
        if (event && this.sessionByChat.has(event.panelId)) this.track(event);
        const paneId = event && this.sources.panel(event.panelId)?.sessionId;
        if (paneId) this.paneChanged(paneId);
        return;
      }
      case 'chat-tab:view': {
        const change = decodeOptionalBoundary(payload, panelEventSchema);
        const paneId = change && this.sources.panel(change.panelId)?.sessionId;
        if (paneId) this.paneChanged(paneId);
        return;
      }
      default:
    }
  }

  /** `orchestration-sessions:snapshots`: the snapshots newer than `since`, with only the messages changed since what the desktop holds. */
  async snapshots(request: SessionSnapshotsRequest): Promise<SessionSnapshotsResult> {
    // Taken before reading, so a change made while this read runs is read again next time.
    const revision = this.last;
    // The list is read only after a Session changed: each pull would otherwise copy every record.
    if (this.listedChanges !== this.listChanges || Date.now() - this.listedAt > LIST_MAX_AGE_MS) await this.refresh();
    // `since` and `held` mean something only to the run that answered them.
    const sameRun = request.epoch === this.epoch;
    const since = sameRun ? request.since : undefined;
    const snapshots: SessionSnapshot[] = [];
    const sessionIds: string[] = [];
    for (const { record, chatPanelId } of this.known.values()) {
      sessionIds.push(record.id);
      const sessionRevision = this.revisionOf(record.id);
      if (since !== undefined && sessionRevision <= since) continue;
      const chat = this.sources.chat(chatPanelId, SESSION_SNAPSHOT_MESSAGE_LIMIT);
      if (!chat) {
        // Not readable yet (its tab is still loading): kept listed, and sent on the next read.
        this.revisions.set(record.id, this.nextRevision());
        continue;
      }
      const held = sameRun ? request.held?.[record.id] : undefined;
      const snapshot: SessionSnapshot = {
        sessionId: record.id,
        revision: sessionRevision,
        session: readableCopy(record),
        chat: { ...chat, transcript: chat.transcript && withoutInlineData(changedSince(chat.transcript, chat.messageCount, held, this.chats.get(chatPanelId))) },
        tabs: this.sources.tabs(record.internalSessionId).filter(tab => isReadableTabType(tab.type)).map(tab => readableCopy(tab)),
        layout: this.sources.layout(record.internalSessionId),
      };
      // A chat whose agent hasn't run since this Pane started has no transcript here yet; that says nothing of its messages.
      if (!chat.transcript) snapshot.transcriptUnknown = true;
      snapshots.push(snapshot);
    }
    return { revision, epoch: this.epoch, sessionIds, snapshots };
  }

  dispose(): void {
    this.disposed = true;
    for (const pace of this.paces.values()) clearTimeout(pace.timer);
    this.paces.clear();
  }

  /** Remembers which message a chat event changed, so a desktop gets earlier messages that changed too. */
  private track(event: { panelId: string; generation: number; revision: number; index?: number }): void {
    let changes = this.chats.get(event.panelId);
    if (!changes || changes.generation !== event.generation || event.index === undefined || event.revision <= changes.latest) {
      // A new conversation, or an event that names no message: watch afresh from the next change.
      changes = { generation: event.generation, from: event.index === undefined ? event.revision + 1 : event.revision, latest: event.revision, changed: new Map() };
      this.chats.set(event.panelId, changes);
      if (event.index === undefined) return;
    }
    changes.latest = event.revision;
    changes.changed.delete(event.index);
    changes.changed.set(event.index, event.revision);
    if (changes.changed.size <= TRACKED_CHANGES) return;
    const [[oldest, oldestRevision]] = changes.changed;
    changes.changed.delete(oldest);
    changes.from = oldestRevision + 1;
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
    // A Session gone from the list (archived, deleted, moved away) is forgotten once its last notice is out.
    if (!this.known.has(sessionId)) this.forget(sessionId);
  }

  private forget(sessionId: string): void {
    if (this.paces.get(sessionId)?.timer) return;
    this.paces.delete(sessionId);
    this.revisions.delete(sessionId);
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
    const sessionByChat = new Map<string, string>();
    for (const record of await this.sources.sessions()) {
      if (record.archived === true || record.move?.state === 'arriving') continue;
      const chatPanelId = record.panelIds[record.agent];
      if (this.sources.panel(chatPanelId)?.type !== 'chat') continue;
      known.set(record.id, { record, chatPanelId });
      sessionByPane.set(record.internalSessionId, record.id);
      sessionByChat.set(chatPanelId, record.id);
    }
    this.known = known;
    this.sessionByPane = sessionByPane;
    this.sessionByChat = sessionByChat;
    for (const sessionId of [...this.revisions.keys()]) if (!known.has(sessionId)) this.forget(sessionId);
    for (const panelId of [...this.chats.keys()]) if (!sessionByChat.has(panelId)) this.chats.delete(panelId);
    this.listedChanges = changes;
    this.listedAt = listedAt;
  }
}

/**
 * The part of the window the desktop lacks: from the first message added or changed since the
 * revision it holds. The whole window when it holds another conversation, too little to join up,
 * or a revision older than this Pane has watched the chat.
 */
function changedSince(transcript: ChatTabTranscript, messageCount: number, held: SessionSnapshotHeld | undefined, changes: ChatChanges | undefined): ChatTabTranscript {
  if (!held || held.generation !== transcript.generation || held.count > messageCount) return transcript;
  if (held.revision === transcript.revision) {
    return held.count === messageCount ? { ...transcript, start: messageCount, messages: [] } : transcript;
  }
  if (!changes || changes.generation !== transcript.generation || changes.latest !== transcript.revision || held.revision < changes.from - 1) return transcript;
  let from = held.count;
  for (const [index, revision] of changes.changed) {
    if (revision > held.revision && index < from) from = index;
  }
  if (from < transcript.start) return transcript;
  return { ...transcript, start: from, messages: transcript.messages.slice(from - transcript.start) };
}

function withoutInlineData(transcript: ChatTabTranscript): ChatTabTranscript {
  return { ...transcript, messages: transcript.messages.map(message => ({ ...message, parts: message.parts.map(lighterPart) })) };
}

/** A part with every string over 4 KB replaced in place by its length; a message's own text is kept whole. */
function lighterPart(part: AgentChatPart): AgentChatPart {
  if (part.type === 'text' || part.type === 'thought') return part;
  // SAFETY: the replacer only swaps long strings for an omitted marker, so the part keeps its kind and keys.
  return JSON.parse(JSON.stringify(part, omitLong)) as AgentChatPart;
}

function omitLong(key: string, value: JsonValue): JsonValue {
  const text = decodeOptionalBoundary(value, boundary.string);
  if (text === undefined || text.length <= INLINE_DATA_LIMIT) return value;
  const omitted: SessionSnapshotOmittedData['omitted'] = { field: key, length: text.length };
  return { omitted: { ...omitted } };
}
