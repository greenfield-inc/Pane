import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import type { ContentBlock, InitializeResponse, McpServer, NewSessionRequest, SessionInfo, SessionUpdate } from '@agentclientprotocol/sdk';
import type { AgentState, PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import type { AgentChatMessage, AgentChatReceipt } from '../../../../shared/types/agentChat';
import type { TerminalPausedMark, ToolPanel } from '../../../../shared/types/panels';
import { CHAT_CONVERSATION_LIMIT, CHAT_FULL_ACCESS_CONTROL, type ChatConversationExport, type ChatDivider, type ChatPanelState, type ChatTabRelaunch, type ChatTabConversation, type ChatTabSwitchBanner, type ChatTabEvent, type ChatTabAnswer, type ChatTabProblem, type ChatTabQueuedPrompt, type ChatTabSend, type ChatTabStatus, type ChatTabTranscript, type ChatTabView, type ChatTurnTime } from '../../../../shared/types/chatTab';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { readOnlyPaneCaller } from '../../daemon/commandRegistry';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { AgentCommand } from './agentProcess';
import { ChatTabRuntime, chatFailure, isAuthRequired, type RuntimeExit } from './runtime';
import { ChatTranscript, type TurnMarker } from './transcript';
import type { PauseOutcome } from '../terminalPanelManager';
import { QueuedBodies } from './queuedBodies';
import { SentMessages } from './sentMessages';
import { agentContent, contentTexts, promptContent, type PromptBody } from './skillDispatch';
import { agentConfig, agentLabel } from '../../../../shared/agents';
import { chatPausedViewSchema } from '../../../../shared/types/chatTabDecoders';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { sessionMovingError } from '../../../../shared/types/sessionMove';
import { promptForAgent } from '../../../../shared/types/paneChat';
import { CHAT_STALL_MS, chatMidTurn, isRunpaneWait } from '../agentStatus/midTurn';
import { transcriptMarkdown, transcriptPrompt, writeTranscriptFile } from './transcriptFile';
import { profilesOn } from '../agentFarm/profilesFeature';

/** Everything the agent process needs, rebuilt at every start. Never saved. */
export interface ResolvedLaunch {
  command: AgentCommand;
  /** `_meta` for session/new and session/load (Claude's `claudeCode.options`). */
  meta?: JsonObject;
  mcpServers?: McpServer[];
  /** Session settings to apply once, on a new conversation. */
  initialSettings?: Record<string, string>;
  /** The session mode to select after every session/new and session/load (full access, or an Agent Farm profile's permission mode). */
  mode?: string;
  /** Full access through Pane: approve each request with the agent's "allow once". */
  approveOnce?: boolean;
  /** The agent runs as its own CLI, so it may advertise a terminal sign-in Pane can run. */
  ownCli?: boolean;
  /** The installed version this launch runs, for an agent Pane installed (ACP Registry). */
  agentVersion?: string;
}

/** Events a chat tab sends to every viewer. */
/**
 * `chat-tab:view` carries every tab's view to clients that read the agent catalog. `chat-tab:state`
 * is the same view for clients from before it, sent only for agents their decoder accepts
 * (`chat.legacyClients`): one they reject would throw out of their event stream and drop the connection.
 */
type ChatTabChannel = 'chat-tab:event' | 'chat-tab:view' | 'chat-tab:state' | 'panel:agentStatus';

export interface ChatTabLauncher {
  /** Throws a PaneError; `CHAT_NOT_SIGNED_IN`, `CHAT_AGENT_NOT_INSTALLED`, `CHAT_AGENT_OUTDATED`, `CHAT_ADAPTER_MISSING` and `CHAT_UNSUPPORTED_HOST` become their stopped states. */
  resolve(panel: ToolPanel, state: ChatPanelState): Promise<ResolvedLaunch>;
}

export interface ChatTabStore {
  panel(panelId: string): ToolPanel | undefined;
  state(panelId: string): ChatPanelState | undefined;
  /** Durable before it returns. */
  commit(panelId: string, state: ChatPanelState): void;
}

export interface ChatTabManagerOptions {
  store: ChatTabStore;
  launcher: ChatTabLauncher;
  send: (channel: ChatTabChannel, payload: ChatTabEvent | ChatTabView | PanelAgentStatusEvent) => void;
  spoolDirectory: string;
  onStatus?: (event: PanelAgentStatusEvent) => void;
  /** Every view the host publishes (approvals and questions for Notify). */
  onView?: (view: ChatTabView) => void;
  /** The tab was closed; nothing about it is published again (its Notify cards close). */
  onClosed?: (panelId: string) => void;
  windowMessages?: number;
  /**
   * Conversations open in Pane tabs on this machine other than `panelId` (and the terminal it replaced),
   * by conversation ID. "Most recent" and the picker never open one of them (D-282).
   */
  openConversations?: (panelId: string) => Map<string, { panelId: string; title: string }>;
  /** How long closing, stopping or quitting waits for a tab's agent to end. Default 5 s. */
  stopTimeoutMs?: number;
  /** An agent's name for messages; defaults to its config label, or its id. */
  agentName?: (agent: string) => string;
  /** Every initialize reply, for the agent catalog's capabilities. */
  onInitialized?: (agent: string, response: InitializeResponse) => void;
  /** Settings › Advanced › Profiles (T-63): off, a Reload or Switch still waiting is dropped. Default: the live switch. */
  profilesOn?: () => boolean;
}

interface Tab {
  /** The public generation: viewers drop any state older than the newest they saw, so it only grows. */
  generation: number;
  /** The live runtime's generation; 0 once released, so late callbacks from a stopped runtime are ignored. */
  run: number;
  runtime?: ChatTabRuntime;
  transcript?: ChatTranscript;
  starting?: Promise<void>;
  loading: boolean;
  delivering: boolean;
  /** The queued message Send now is delivering into the running turn. */
  steering?: string;
  /** When the agent began a turn of its own. */
  ownTurnStartedAt?: string;
  notice?: string;
  published?: AgentState;
  launch?: ResolvedLaunch;
  /** /clear is replacing the agent with a fresh conversation; it has not stopped. */
  clearing?: boolean;
  /** Full access through Pane is on: each approval is answered with allow once. */
  approveOnce?: boolean;
  /** The terminal sign-in the agent last advertised, kept after it stops signed out. */
  signIn?: { args: string[]; env?: Record<string, string> };
  /** The composer's controls as the running agent last offered them, shown (locked) while it restarts. */
  shown?: Pick<ChatTabView, 'controls' | 'commands' | 'canAttachImages'>;
  /** The newest window of the conversation, shown while a restart replays its history; read from disk for a tab paused before Pane restarted. */
  held?: ChatTabTranscript;
  /** A pause is ending the agent; a start waits for it, so a send or open during the stop is delivered after it. */
  pausing?: Promise<void>;
  /** This start resumes a paused tab. */
  resuming?: boolean;
  /** When the agent last sent an update or was sent a message, in ms since the epoch. */
  activeAt?: number;
  /** Tool calls of the current turn that are pending or in progress, each true when it is a runpane wait, for the Session's test. */
  toolsRunning?: Map<string, boolean>;
  /** A Reload or Switch profile is restarting the agent (T-63). */
  relaunching?: boolean;
  /** A Reload or Switch is ending the old agent; a start waits for it, so nothing reaches the new one before its handoff (review F-4). */
  switching?: Promise<void>;
  /** `stop` is ending the agent; a start or a Reload or Switch waits for it (review F-6). */
  stopping?: Promise<void>;
}

const DEFAULT_VIEW_LIMIT = 200;
/** Time rows kept per conversation; older turns lose theirs after a restart. */
const TURN_TIMES_LIMIT = 200;
const RECEIPT_LIMIT = 256;
const PROMPT_BYTES_LIMIT = 8 * 1024 * 1024;
/** Characters of a queued prompt kept in the tab's saved state for the queue list. */
const QUEUE_PREVIEW = 500;
/** Profile dividers kept per tab; older ones are dropped. */
const DIVIDERS_LIMIT = 50;

/**
 * Host owner of every chat tab on this machine. Desktop, the remote PWA, the
 * phone and runpane all reach the same instance through chat-tab:* commands;
 * none of them can start a second runtime for a tab.
 */
export class ChatTabManager {
  private readonly tabs = new Map<string, Tab>();
  private lastGeneration = 0;
  private lastUpdateAt = 0;
  private readonly bodies: QueuedBodies;
  private readonly sentMessages: SentMessages;
  private readonly name: (agent: string) => string;

  constructor(private readonly options: ChatTabManagerOptions) {
    this.name = options.agentName ?? agentLabel;
    this.sentMessages = new SentMessages(path.join(options.spoolDirectory, 'sent-messages'));
    this.bodies = new QueuedBodies(panelId => path.join(options.spoolDirectory, safeName(panelId), 'queue'));
  }

  /** When any chat agent last sent an update, in ms since the epoch; 0 when none has. */
  latestOutputAt(): number {
    return this.lastUpdateAt;
  }

  /** The tab's view. Opening a tab that is not running starts it, unless it stopped for a reason; a paused tab resumes. */
  view(panelId: string, limit = DEFAULT_VIEW_LIMIT, start = true): ChatTabView {
    const state = this.required(panelId);
    const tab = this.tab(panelId);
    if (start && !readOnlyPaneCaller() && !tab.runtime && !tab.starting && state.status !== 'stopped') void this.ensure(panelId).catch(() => undefined);
    return this.snapshot(panelId, state, tab, limit);
  }

  history(panelId: string, before: number, limit: number): AgentChatMessage[] {
    this.required(panelId);
    const tab = this.tab(panelId);
    if (tab.transcript && replayed(tab)) return tab.transcript.history(before, Math.min(500, limit));
    const held = tab.held;
    if (!held) return [];
    const end = Math.min(before, held.start + held.messages.length) - held.start;
    return structuredClone(held.messages.slice(Math.max(0, end - Math.min(500, limit)), Math.max(0, end)));
  }

  /** The conversation's messages for readers such as runpane; pages through spooled history without copying it all at once. */
  messages(panelId: string): Iterable<AgentChatMessage> {
    this.required(panelId);
    const tab = this.tab(panelId);
    if (tab.transcript && replayed(tab)) return tab.transcript.all();
    return tab.held?.messages ?? tab.transcript?.all() ?? [];
  }

  lastMessage(panelId: string, role: AgentChatMessage['role'] = 'assistant', accept: (message: AgentChatMessage) => boolean = () => true): AgentChatMessage | undefined {
    const tab = this.tab(panelId);
    if (tab.transcript && replayed(tab)) return tab.transcript.last(role, accept);
    if (!tab.held) return tab.transcript?.last(role, accept);
    const found = [...(tab.held?.messages ?? [])].reverse().find(message => message.role === role && accept(message));
    return found && structuredClone(found);
  }

  /** The tab's status as agent status (sidebar, tabs, runpane), without starting it. */
  agentState(panelId: string): AgentState {
    const state = this.options.store.state(panelId);
    if (!state) return 'unknown';
    const tab = this.tab(panelId);
    return publishedState(this.snapshot(panelId, state, tab, 0), tab);
  }

  /**
   * The Session icon's stricter test (midTurn.ts): a turn that is open and still sending
   * updates or running a tool, and no runpane waiting call open from this tab.
   */
  isMidTurn(panelId: string, now: number = Date.now()): boolean {
    const state = this.options.store.state(panelId);
    const tab = this.tabs.get(panelId);
    if (!state || !tab) return false;
    // Waiting only while the calls it runs are runpane waits: one sent to the background
    // returns at once, so it never hides real work (D-386).
    const running = [...tab.toolsRunning?.values() ?? []];
    const toolRunning = running.some(wait => !wait);
    return chatMidTurn({
      status: this.status(state, tab),
      lastUpdateAt: tab.activeAt,
      toolRunning,
      waiting: !toolRunning && running.length > 0,
    }, now, chatStallMs());
  }

  /** The terminal sign-in the tab's agent advertised, when it runs as its own CLI. */
  terminalSignIn(panelId: string): { args: string[]; env?: Record<string, string> } | undefined { return this.tabs.get(panelId)?.signIn; }

  isRunning(panelId: string): boolean { return !!this.tabs.get(panelId)?.runtime?.isAlive(); }
  /** /clear is starting a fresh conversation: the agent is between processes, not stopped. */
  isClearing(panelId: string): boolean { return this.tabs.get(panelId)?.clearing === true; }
  /** Tabs of `agent` that run it or are starting it: removing its files would break them. */
  inUse(agent: string): number {
    return [...this.tabs.entries()].filter(([panelId, tab]) => (tab.runtime?.isAlive() || tab.starting) && this.options.store.state(panelId)?.agent === agent).length;
  }

  /** The installed versions running tabs of `agent` launched from: their folders must stay. */
  launchedVersions(agent: string): Set<string> {
    return new Set([...this.tabs.entries()].flatMap(([panelId, tab]) => tab.runtime?.isAlive() && tab.launch?.agentVersion && this.options.store.state(panelId)?.agent === agent ? [tab.launch.agentVersion] : []));
  }

  /** When the tab's agent last sent an update or was sent a message; undefined when it has not run. */
  lastActivity(panelId: string): Date | undefined {
    const at = this.tabs.get(panelId)?.activeAt;
    return at === undefined ? undefined : new Date(at);
  }

  /** The tab has work in flight: a turn, a queued message, a pending approval or question, a background task, or a start. */
  busy(panelId: string): boolean {
    const state = this.options.store.state(panelId);
    const tab = this.tabs.get(panelId);
    if (!state || !tab) return false;
    const runtime = tab.runtime;
    return !!state.turn || !!state.queue?.length || !!tab.starting || tab.delivering || tab.clearing === true
      || !!runtime && (runtime.isRunning() || runtime.isWorkingAlone() || runtime.permissions().length > 0 || runtime.questions().length > 0 || runtime.tasks().length > 0);
  }

  /**
   * Auto-pause: end these tabs' agents and mark them paused. Only a running tab with no work in flight
   * pauses, so a pause never cuts off a turn, an approval, a question or a queued message, and only when
   * its agent can reopen the conversation. The conversation stays on screen and readable; opening the
   * tab or sending to it resumes it.
   */
  async pause(panelIds: readonly string[], mark: TerminalPausedMark): Promise<PauseOutcome> {
    const outcome: PauseOutcome = { paused: [], failed: [] };
    for (const panelId of panelIds) {
      const state = this.options.store.state(panelId);
      const tab = this.tabs.get(panelId);
      // Only a running agent pauses: a stopped tab keeps its problem, an unstarted one has nothing to stop.
      if (!state || !tab?.runtime?.isAlive() || state.status === 'stopped' || tab.pausing) continue;
      // An agent that can't reopen a saved conversation would lose it, so it runs until the tab closes.
      if (!tab.runtime.canLoad()) continue;
      if (this.busy(panelId)) {
        outcome.failed.push({ panelId, error: 'Its agent is working, waiting on an answer, or has messages queued, so it was left running. The next sweep tries again.' });
        continue;
      }
      const pausing = this.stopForPause(panelId, tab, mark);
      tab.pausing = pausing.catch(() => undefined).finally(() => { if (tab.pausing === settled) tab.pausing = undefined; });
      const settled = tab.pausing;
      try {
        await pausing;
        outcome.paused.push(panelId);
      } catch (error) {
        outcome.failed.push({ panelId, error: reasonOf(error) });
      }
    }
    return outcome;
  }

  private async stopForPause(panelId: string, tab: Tab, mark: TerminalPausedMark): Promise<void> {
    this.update(panelId, current => ({ ...current, paused: mark }));
    this.savePaused(panelId, tab);
    await this.end(tab);
    this.publish(panelId);
  }

  runningPanelIds(): string[] { return [...this.tabs.entries()].flatMap(([panelId, tab]) => tab.runtime?.isAlive() ? [panelId] : []); }
  processId(panelId: string): number | undefined { return this.tabs.get(panelId)?.runtime?.pid; }
  /** Each running chat tab's adapter process, with its Pane and tab. */
  getPanelPids(): Array<{ pid: number; sessionId: string; panelId: string }> {
    return [...this.tabs].flatMap(([panelId, tab]) => {
      const sessionId = this.options.store.panel(panelId)?.sessionId;
      return tab.runtime?.pid && sessionId ? [{ pid: tab.runtime.pid, sessionId, panelId }] : [];
    });
  }

  /** Pane ID → adapter process IDs of its running chat tabs, for archive cleanup and port ownership. */
  getSessionPids(): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const [panelId, tab] of this.tabs) {
      const sessionId = this.options.store.panel(panelId)?.sessionId;
      if (!tab.runtime?.pid || !sessionId) continue;
      result.set(sessionId, [...(result.get(sessionId) ?? []), tab.runtime.pid]);
    }
    return result;
  }

  /** Starts the tab's agent once; concurrent callers share the same start. */
  ensure(panelId: string): Promise<void> {
    const moving = this.options.store.state(panelId)?.paused;
    // Only the move itself starts a tab it stopped (`releaseMove`).
    if (moving?.by === 'move') return Promise.reject(sessionMovingError(moving));
    const tab = this.tab(panelId);
    if (tab.runtime?.isAlive()) return Promise.resolve();
    // A send or open during a pause starts the agent once the pause has stopped it.
    if (tab.pausing) {
      return tab.pausing.then(() => {
        // A tab closed or stopped for a problem during the pause stays as it is.
        if (this.tabs.get(panelId) !== tab || this.options.store.state(panelId)?.status === 'stopped') return;
        return this.ensure(panelId);
      });
    }
    // A Reload or Switch letting the old agent go: the new one starts after, its handoff first (review F-4).
    if (tab.switching) return tab.switching.then(() => this.tabs.get(panelId) === tab ? this.ensure(panelId) : undefined);
    // A stop ending the agent: it stays stopped unless a Reload or Switch starts it again (review F-6).
    if (tab.stopping) {
      return tab.stopping.then(() => {
        if (this.tabs.get(panelId) !== tab || this.options.store.state(panelId)?.status === 'stopped') return;
        return this.ensure(panelId);
      });
    }
    // Publish after the start settles: while it runs, every view says `starting`.
    tab.starting ??= this.start(panelId, tab).finally(() => {
      tab.starting = undefined;
      tab.resuming = false;
      // A tab closed while it started is gone; nothing is published for it.
      if (this.tabs.get(panelId) !== tab) return;
      this.publish(panelId);
      this.drain(panelId);
    });
    return tab.starting;
  }

  /** A Session move: stops the tab (interrupting its turn when `interrupt`) and marks it moving. */
  async pauseForMove(panelId: string, mark: TerminalPausedMark, interrupt: boolean): Promise<void> {
    const state = this.options.store.state(panelId);
    const tab = this.tabs.get(panelId);
    if (!state) return;
    if (interrupt && this.busy(panelId)) await this.cancel(panelId).catch(() => undefined);
    if (!tab?.runtime?.isAlive()) {
      this.update(panelId, current => ({ ...current, paused: mark }));
      this.publish(panelId);
      return;
    }
    await this.stopForPause(panelId, tab, mark);
  }

  /** Ends a move's hold on a tab that wasn't running, without starting it. */
  async clearMoveHold(panelId: string): Promise<void> {
    if (this.options.store.state(panelId)?.paused?.by !== 'move') return;
    this.update(panelId, current => ({ ...current, paused: undefined }));
    this.publish(panelId);
  }

  /** Ends a move's hold on the tab and starts it again (cancelled move, or arrived on this machine). */
  async releaseMove(panelId: string): Promise<void> {
    if (this.options.store.state(panelId)?.paused?.by !== 'move') return;
    this.update(panelId, current => ({ ...current, paused: undefined }));
    this.publish(panelId);
    await this.ensure(panelId);
  }

  async restart(panelId: string): Promise<void> {
    const tab = this.tab(panelId);
    await tab.starting?.catch(() => undefined);
    await this.release(tab);
    this.update(panelId, state => ({ ...state, status: 'starting', problem: undefined }));
    await this.ensure(panelId);
  }

  /**
   * Reload or Switch profile (T-63): the agent restarts on `request.launch` once it has finished its
   * reply, and continues the conversation through session/load, or starts a new one given the old
   * transcript. A later request replaces one still waiting. A divider marks the place in the chat.
   */
  relaunch(panelId: string, request: ChatTabRelaunch): void {
    this.required(panelId);
    this.update(panelId, current => ({ ...current, relaunch: structuredClone(request) }));
    this.publish(panelId);
    this.relaunchWhenFree(panelId);
  }

  /** The agent is in a reply (or a message is about to start one): a switch to another agent waits for it to end. */
  replying(panelId: string): boolean {
    const tab = this.tabs.get(panelId);
    const runtime = tab?.runtime;
    return !!tab && (!!this.options.store.state(panelId)?.turn || tab.delivering || !!runtime?.isAlive() && (runtime.isRunning() || runtime.isWorkingAlone()));
  }

  /** Whether a Reload or Switch is waiting for the agent's reply to end or restarting it. */
  relaunchPending(panelId: string): boolean {
    return !!this.options.store.state(panelId)?.relaunch || this.tabs.get(panelId)?.relaunching === true;
  }

  /**
   * Saves the whole conversation as Markdown in its Session folder (`transcripts/<conversation>.md`)
   * for a new conversation to read. `transcript` is absent when nothing was said yet. Throws when only
   * part of the conversation is at hand (it hasn't been loaded since Pane started) or there is no
   * Session folder to save it in, so a switch never hands over less than the whole (review F-3).
   */
  exportConversation(panelId: string): ChatConversationExport {
    const state = this.required(panelId);
    const messages = this.wholeConversation(panelId);
    if (!messages) {
      throw new PaneError('CHAT_TRANSCRIPT_UNAVAILABLE', 'its conversation hasn\'t been loaded since Pane started, so Pane can\'t save all of it', 'Open the Session\'s tab (press Restart if it is stopped) so its conversation loads, then switch again.');
    }
    const markdown = transcriptMarkdown(messages, this.name(state.agent));
    if (!markdown) return {};
    if (!state.sessionFolder) throw new PaneError('CHAT_TRANSCRIPT_NOT_SAVED', 'the tab has no Session folder to save its conversation in', 'Start a new Session with the profile instead.');
    return { transcript: writeTranscriptFile(state.sessionFolder, state.acpSessionId ?? `conversation-${Date.now()}`, markdown) };
  }

  /** The whole conversation; undefined when only part of it is at hand (a restart still replaying it, or not loaded since Pane started). */
  private wholeConversation(panelId: string): Iterable<AgentChatMessage> | undefined {
    const tab = this.tab(panelId);
    if (tab.transcript && replayed(tab)) return tab.transcript.all();
    return this.required(panelId).acpSessionId ? undefined : [];
  }

  /** Applies a waiting relaunch now if the agent isn't in a reply; otherwise the reply's end does. */
  private relaunchWhenFree(panelId: string): void {
    const state = this.options.store.state(panelId);
    const tab = this.tab(panelId);
    if (!state?.relaunch || tab.relaunching || tab.starting) return;
    // Profiles turned off while it waited: the tab stays on its launch, as main (review F-5).
    if (!(this.options.profilesOn ?? profilesOn)()) {
      console.log(`[ChatTabs] ${panelId} drops its waiting profile change: Profiles is off.`);
      this.update(panelId, current => ({ ...current, relaunch: undefined }));
      this.publish(panelId);
      this.drain(panelId);
      return;
    }
    if (tab.pausing) { void tab.pausing.then(() => this.relaunchWhenFree(panelId)); return; }
    // A stop still ending the agent (the other agent's tab after a Switch) finishes first (review F-6).
    if (tab.stopping) { void tab.stopping.then(() => this.relaunchWhenFree(panelId)); return; }
    const runtime = tab.runtime;
    if (runtime?.isAlive() && (runtime.isRunning() || runtime.isWorkingAlone() || tab.delivering || !!tab.steering || tab.loading)) return;
    tab.relaunching = true;
    void this.applyRelaunch(panelId, tab, state.relaunch)
      .catch(error => console.warn(`[ChatTabs] ${panelId} could not restart on its new profile: ${reasonOf(error)}`))
      .finally(() => { tab.relaunching = false; if (this.tabs.get(panelId) === tab) this.relaunchWhenFree(panelId); });
  }

  private async applyRelaunch(panelId: string, tab: Tab, request: ChatTabRelaunch): Promise<void> {
    const before = this.required(panelId);
    const at = new Date().toISOString();
    const keep = !request.newConversation && !!before.acpSessionId;
    // Kept privately before the agent stops: a failed load falls back to it, and it is deleted after (review F-7).
    let fallback: string | undefined;
    if (keep) {
      try { fallback = this.saveFallback(panelId); }
      catch (error) { console.warn(`[ChatTabs] ${panelId}'s conversation was not kept for a failed load on its new profile: ${reasonOf(error)}`); }
    }
    const divider: ChatDivider = keep
      ? { sessionId: before.acpSessionId, text: request.divider, at, ...withAfter(tab.transcript?.lastReplayedId()) }
      : { leading: true, text: request.divider, at };
    // The old agent is let go first: from here nothing reaches it, and a start waits until it has ended.
    const releasing = this.release(tab).catch(error => console.warn(`[ChatTabs] ${panelId}'s old agent did not stop cleanly: ${reasonOf(error)}`));
    tab.switching = releasing;
    try {
      // The new launch and its handoff are saved together before anything yields: a send while the old
      // agent stops waits for the new one, and a quit now restarts on the new launch with the handoff
      // first in its queue (review F-4).
      this.update(panelId, current => {
        const next: ChatPanelState = {
          ...current, relaunch: undefined, launch: request.launch, status: 'starting', problem: undefined,
          dividers: [...current.dividers ?? [], divider].slice(-DIVIDERS_LIMIT),
          loadFallback: fallback ? { file: fallback } : undefined,
        };
        if (!keep) Object.assign(next, { acpSessionId: undefined, turn: undefined, turnTimes: undefined, clearedAt: undefined, banner: undefined, open: undefined });
        return next;
      });
      if (!keep) forgetConversation(tab);
      // A new conversation is given only the outgoing one's transcript, never this tab's own earlier one (review F-3).
      if (!keep && request.newConversation?.transcript) this.queueTranscript(panelId, request.newConversation.transcript, request.newConversation.reason);
      this.publish(panelId);
      await releasing;
    } finally {
      if (tab.switching === releasing) tab.switching = undefined;
    }
    console.log(`[ChatTabs] ${panelId} restarts on ${request.launch.kind === 'profile' ? request.launch.profile : 'its agent'}${keep ? ', keeping its conversation' : ', in a new conversation'}.`);
    await this.ensure(panelId);
  }

  /** The conversation as Markdown in Pane's own chat-tabs folder, for a failed load; undefined when only part of it is at hand. */
  private saveFallback(panelId: string): string | undefined {
    const messages = this.wholeConversation(panelId);
    const markdown = messages && transcriptMarkdown(messages, this.name(this.required(panelId).agent));
    if (!markdown) return undefined;
    const directory = path.join(this.options.spoolDirectory, safeName(panelId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'fallback-transcript.md');
    writeFileSync(file, markdown, { mode: 0o600 });
    return file;
  }

  /** Deletes the private fallback transcript once the start it was kept for has ended. */
  private discardFallback(panelId: string): void {
    const file = this.options.store.state(panelId)?.loadFallback?.file;
    this.update(panelId, current => ({ ...current, loadFallback: undefined }));
    // Only a file in Pane's own chat-tabs folder is ever deleted.
    if (!file || path.dirname(file) !== path.join(this.options.spoolDirectory, safeName(panelId))) return;
    try { rmSync(file, { force: true }); }
    catch (error) { console.warn(`[ChatTabs] ${panelId}'s private fallback transcript was not deleted: ${reasonOf(error)}`); }
  }

  /** Sends a new conversation its first message: read the old one's transcript. */
  private queueTranscript(panelId: string, transcript: string, reason: string): void {
    try { this.send(panelId, { operationId: `transcript:${Date.now()}`, text: transcriptPrompt(transcript, reason), now: true }); }
    catch (error) {
      console.warn(`[ChatTabs] ${panelId}'s new conversation was not given its transcript: ${reasonOf(error)}`);
      this.tab(panelId).notice = `The new conversation was not given the earlier one (${reasonOf(error)}). It is saved in ${transcript}.`;
    }
  }

  receipt(panelId: string, operationId: string): AgentChatReceipt | undefined {
    return structuredClone(this.required(panelId).receipts?.find(receipt => receipt.operationId === operationId));
  }

  /** Accepts a prompt. A prompt sent while the agent works is queued and delivered after the turn. */
  send(panelId: string, request: ChatTabSend): AgentChatReceipt {
    const state = this.required(panelId);
    const tab = this.tab(panelId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ text: request.text, images: request.images ?? [] })).digest('hex');
    const previous = state.receipts?.find(receipt => receipt.operationId === request.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new PaneError('CHAT_OPERATION_CONFLICT', 'This send was already used for a different message. Nothing new was sent.', 'Send the new message again; Pane gives it its own ID.');
      return structuredClone(previous);
    }
    if (!request.operationId || request.operationId.length > 128) throw new PaneError('CHAT_PROMPT_INVALID', 'The message has no valid send ID. Nothing was sent.', 'Send it again.');
    if (!request.text.trim() && !request.images?.length) throw new PaneError('CHAT_PROMPT_EMPTY', 'The message is empty. Nothing was sent.', 'Type a message or attach an image.');
    if (promptSize(request) > PROMPT_BYTES_LIMIT) {
      throw new PaneError('CHAT_PROMPT_TOO_LARGE', 'The message is larger than 8 MiB. Nothing was sent.', 'Send a shorter message or a smaller image.');
    }
    if (request.images?.some(image => !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) {
      throw new PaneError('CHAT_IMAGE_UNSUPPORTED', 'An attachment is not a PNG, JPEG, WebP or GIF image. Nothing was sent.', 'Attach a supported image, or send text only.');
    }
    if (state.paused?.by === 'move') throw sessionMovingError(state.paused);
    if (state.status === 'stopped') {
      throw new PaneError('CHAT_STOPPED', `This chat is stopped${state.problem ? `: ${state.problem.message}` : '.'} Nothing was sent.`, state.problem?.next ?? 'Press Restart to start it again.');
    }
    const receipt: AgentChatReceipt = { operationId: request.operationId, generation: tab.generation, fingerprint, state: 'accepted' };
    // The full prompt goes beside the state first; the receipt and queue entry are then saved together.
    try { this.bodies.write(panelId, request.operationId, { text: request.text, images: request.images }); }
    catch (error) { throw new PaneError('CHAT_PROMPT_NOT_SAVED', `The message could not be saved on this machine (${reasonOf(error)}). Nothing was sent.`, 'Check free disk space, then send it again.'); }
    const queued: ChatTabQueuedPrompt = { operationId: request.operationId, text: request.text.slice(0, QUEUE_PREVIEW), queuedAt: new Date().toISOString(), stored: true };
    if (request.images?.length) queued.imageCount = request.images.length;
    // Send now goes ahead of everything already waiting.
    const queue = (current: ChatPanelState) => request.now ? [queued, ...(current.queue ?? [])] : [...(current.queue ?? []), queued];
    try { this.update(panelId, current => ({ ...current, receipts: [...(current.receipts ?? []), receipt].slice(-RECEIPT_LIMIT), queue: queue(current) })); }
    catch (error) { this.bodies.remove(panelId, request.operationId); throw error; }
    this.publish(panelId);
    if (!tab.runtime?.isAlive()) void this.ensure(panelId).catch(() => undefined);
    else if (request.now) this.sendFirstNow(panelId);
    else this.drain(panelId);
    return structuredClone(receipt);
  }

  /** Moves a queued message to the front and sends it now (see sendFirstNow). */
  sendNow(panelId: string, operationId: string): void {
    const item = this.queued(panelId, operationId);
    this.update(panelId, current => ({ ...current, queue: [item, ...(current.queue ?? []).filter(entry => entry.operationId !== operationId)] }));
    this.publish(panelId);
    if (this.tabs.get(panelId)?.runtime?.isAlive()) this.sendFirstNow(panelId);
  }

  /** Replaces a queued message's text and keeps its images. Its receipt is unchanged, so a retried send of the original still finds it. */
  editQueued(panelId: string, operationId: string, text: string): void {
    const item = this.queued(panelId, operationId);
    const body = item.stored ? this.bodies.read(panelId, operationId) : { text: item.text, images: item.images };
    if (!body) throw new PaneError('CHAT_QUEUED_COPY_MISSING', 'The saved copy of this queued message is missing, so it was not changed.', 'Remove it from the queue and send it again.');
    const edited = { text, images: body.images };
    if (!text.trim() && !edited.images?.length) throw new PaneError('CHAT_PROMPT_EMPTY', 'The edited message is empty. The queued message was not changed.', 'Type a message, or remove it from the queue.');
    if (promptSize(edited) > PROMPT_BYTES_LIMIT) throw new PaneError('CHAT_PROMPT_TOO_LARGE', 'The edited message is larger than 8 MiB. The queued message was not changed.', 'Shorten the message.');
    try { this.bodies.write(panelId, operationId, edited); }
    catch (error) { throw new PaneError('CHAT_PROMPT_NOT_SAVED', `The edited message could not be saved on this machine (${reasonOf(error)}). The queued message was not changed.`, 'Check free disk space, then edit it again.'); }
    const replacement: ChatTabQueuedPrompt = { operationId, text: text.slice(0, QUEUE_PREVIEW), queuedAt: item.queuedAt, stored: true };
    if (edited.images?.length) replacement.imageCount = edited.images.length;
    try {
      this.update(panelId, current => ({ ...current, queue: current.queue?.map(entry => entry.operationId === operationId ? replacement : entry) }));
    } catch (error) {
      // The queue still shows the old text, so the delivered body must stay the old one too (review F-1).
      try {
        if (item.stored) this.bodies.write(panelId, operationId, body);
        else this.bodies.remove(panelId, operationId);
      } catch (restore) {
        throw new PaneError('CHAT_QUEUED_EDIT_UNCERTAIN', `The edit could not be saved, and the original text could not be put back (${reasonOf(restore)}), so this queued message may send the edited text.`, 'Remove it from the queue and send it again.');
      }
      throw error;
    }
    this.publish(panelId);
  }

  /**
   * /clear: ends the agent and starts a fresh conversation in the same tab, with the same launch
   * and saved settings. What waits in the queue is sent into the new conversation.
   */
  async clear(panelId: string): Promise<void> {
    this.refuseStopped(panelId, 'cleared');
    const tab = this.tab(panelId);
    tab.clearing = true;
    try {
      await tab.starting?.catch(() => undefined);
      this.refuseStopped(panelId, 'cleared');
      // The release clears the runtime at once; the state below is saved before anything can start again,
      // so a send or a view during the stop starts the new conversation, never the old one.
      const releasing = this.release(tab);
      forgetConversation(tab);
      const interrupted = this.required(panelId).turn;
      tab.notice = undefined;
      tab.ownTurnStartedAt = undefined;
      this.update(panelId, current => ({
        ...current, acpSessionId: undefined, turn: undefined, clearedAt: new Date().toISOString(), status: 'starting', problem: undefined, notice: undefined, open: undefined, banner: undefined,
        receipts: current.receipts?.map(receipt => receipt.operationId === interrupted?.operationId && receipt.state === 'accepted' ? { ...receipt, state: 'failed', error: 'Cleared before the turn finished.' } : receipt),
      }));
      await releasing;
      await this.ensure(panelId);
    } finally { tab.clearing = false; }
  }

  /** Stops one background task; the turn goes on. */
  async stopTask(panelId: string, taskId: string): Promise<void> {
    await this.liveRuntime(panelId).stopTask(taskId);
  }

  unqueue(panelId: string, operationId: string): void {
    const state = this.required(panelId);
    if (!state.queue?.some(item => item.operationId === operationId)) throw new PaneError('CHAT_NOT_QUEUED', 'That message is no longer waiting; it was already sent or removed.', 'Look at the conversation for it.');
    this.update(panelId, current => ({
      ...current,
      queue: current.queue?.filter(item => item.operationId !== operationId),
      receipts: current.receipts?.map(receipt => receipt.operationId === operationId ? { ...receipt, state: 'failed', error: 'Removed from the queue before it was sent.' } : receipt),
    }));
    this.bodies.remove(panelId, operationId);
    this.publish(panelId);
  }

  private queued(panelId: string, operationId: string): ChatTabQueuedPrompt {
    const item = this.required(panelId).queue?.find(entry => entry.operationId === operationId);
    if (!item) throw new PaneError('CHAT_NOT_QUEUED', 'That message is no longer waiting; it was already sent or removed.', 'Look at the conversation for it.');
    return item;
  }

  private refuseStopped(panelId: string, what: string): void {
    const state = this.required(panelId);
    if (state.status !== 'stopped') return;
    throw new PaneError('CHAT_STOPPED', `This chat is stopped${state.problem ? `: ${state.problem.message}` : '.'} It was not ${what}.`, state.problem?.next ?? 'Press Restart to start it again.');
  }

  /**
   * Send now for the message first in the queue. An agent that takes steering gets it inside the
   * running prompt turn, which goes on with its subagents and background tasks. Otherwise (no
   * steering, or a turn the agent started on its own) the turn is cancelled, which also withdraws
   * an open approval or question, and drain delivers the message next.
   */
  private sendFirstNow(panelId: string): void {
    const tab = this.tab(panelId);
    const runtime = tab.runtime;
    if (!runtime?.isAlive()) return;
    if (!runtime.isRunning() && !runtime.isWorkingAlone() && !tab.delivering) { this.drain(panelId); return; }
    if (runtime.isRunning() && runtime.canSteer()) { void this.steerFirst(panelId, tab, runtime); return; }
    void runtime.cancel().catch(error => {
      console.warn(`[ChatTabs] Send now could not interrupt ${panelId}'s turn: ${reasonOf(error)}. The message is sent when the turn ends.`);
    });
  }

  /** Delivers the first queued message into the running turn; when the turn already ended, drain sends it. */
  private async steerFirst(panelId: string, tab: Tab, runtime: ChatTabRuntime): Promise<void> {
    const next = this.required(panelId).queue?.[0];
    // One steer at a time: a second message sent now waits in the queue, so no message is delivered twice.
    if (!next || tab.steering) return;
    const body = next.stored ? this.bodies.read(panelId, next.operationId) : { text: next.text, images: next.images };
    // drain reports a missing copy when the turn ends.
    if (!body) return;
    const content = promptContent(body);
    const sent = this.sentContent(panelId, runtime, body);
    tab.steering = next.operationId;
    let outcome: string;
    try { outcome = await runtime.steer(sent); }
    catch (error) { outcome = reasonOf(error); }
    finally { tab.steering = undefined; }
    const state = this.options.store.state(panelId);
    if (outcome !== 'injected' && outcome !== 'promptRequired' && tab.runtime === runtime) {
      console.warn(`[ChatTabs] Send now could not deliver into ${panelId}'s turn: ${outcome}. The message is sent when the turn ends.`);
      tab.notice = 'Send now could not reach the agent. Your message stays queued and is sent when this turn ends.';
      this.publish(panelId);
    }
    if (outcome === 'injected' && tab.runtime === runtime && state?.queue?.some(item => item.operationId === next.operationId)) {
      this.rememberTyped(panelId, body.text, sent);
      for (const event of tab.transcript?.userMessage(next.operationId, content, true, sent) ?? []) this.options.send('chat-tab:event', event);
      this.update(panelId, current => ({
        ...current, queue: current.queue?.filter(item => item.operationId !== next.operationId),
        receipts: current.receipts?.map(receipt => receipt.operationId === next.operationId ? { ...receipt, state: 'completed' } : receipt),
      }));
      this.bodies.remove(panelId, next.operationId);
      this.publish(panelId);
    }
    // The turn may have ended while the steer was in flight; drain waits for a turn that still runs.
    if (state) this.drain(panelId);
  }

  /** A message in the form its agent runs a skill named in it. What Pane stores, queues and shows stays as typed. */
  private sentContent(panelId: string, runtime: ChatTabRuntime, body: PromptBody): ContentBlock[] {
    return agentContent(body, runtime.commands(), agentConfig(this.required(panelId).agent)?.chat?.skills);
  }

  /** Keeps the typed text of a message whose agent's history will hold another form of it. */
  private rememberTyped(panelId: string, text: string | undefined, sent: ContentBlock[]): void {
    const { acpSessionId, agent } = this.required(panelId);
    const parts = contentTexts(sent);
    // A typed `/name` goes as it is, but is kept too, so its history entry is never taken for a split message's.
    const last = agentConfig(agent)?.chat?.skills === 'meta' ? parts.at(-1) : undefined;
    if (text && acpSessionId && last?.startsWith('/')) this.sentMessages.add(acpSessionId, { text, parts });
  }

  async cancel(panelId: string): Promise<void> {
    const runtime = this.liveRuntime(panelId);
    await runtime.cancel();
  }

  answerPermission(panelId: string, requestId: string, optionId: string): void {
    this.liveRuntime(panelId).answerPermission(requestId, optionId);
  }

  answerQuestion(panelId: string, questionId: string, answer: ChatTabAnswer): void {
    this.liveRuntime(panelId).answerQuestion(questionId, answer);
  }

  async configure(panelId: string, configId: string, value: string): Promise<void> {
    if (configId === CHAT_FULL_ACCESS_CONTROL) { await this.setFullAccess(panelId, value === FULL_ACCESS_ON); return; }
    const runtime = await this.wokenRuntime(panelId);
    if (runtime.isRunning()) throw new PaneError('CHAT_CONFIG_BUSY', 'Settings cannot change while the agent is working. Nothing changed.', 'Wait for the turn to end, or press Stop.');
    await runtime.configure(configId, value);
    this.update(panelId, state => ({ ...state, settings: { ...state.settings, [configId]: value } }));
    this.publish(panelId);
  }

  /**
   * Turns full access on or off for an agent whose full access is not a session mode (D-16):
   * Pane's allow once changes at once; an agent whose switch is a launch flag restarts on the
   * same conversation with or without it.
   */
  private async setFullAccess(panelId: string, on: boolean): Promise<void> {
    const state = this.required(panelId);
    if (!fullAccessControlled(state)) throw new PaneError('CHAT_CONFIG_UNSUPPORTED', `${this.name(state.agent)} sets full access with its own permission setting. Nothing changed.`, 'Pick a permission mode in the composer instead.');
    if (state.launch.kind !== 'agent' || (state.launch.fullAccess === true) === on) return;
    const tab = this.tab(panelId);
    if (tab.runtime?.isRunning() || tab.delivering) throw new PaneError('CHAT_CONFIG_BUSY', 'Full access cannot change while the agent is working. Nothing changed.', 'Wait for the turn to end, or press Stop.');
    const launch = { ...state.launch };
    if (on) launch.fullAccess = true; else delete launch.fullAccess;
    this.update(panelId, current => ({ ...current, launch }));
    console.log(`[ChatTabs] ${panelId}: full access ${on ? 'on' : 'off'}.`);
    if (agentConfig(state.agent)?.chat?.fullAccess?.args) { await this.restart(panelId); return; }
    tab.approveOnce = on;
    this.publish(panelId);
  }

  /** The folder's past conversations for the picker, newest first, with this tab's and other tabs' marked. */
  async conversations(panelId: string): Promise<ChatTabConversation[]> {
    const state = this.required(panelId);
    const runtime = await this.wokenRuntime(panelId);
    const elsewhere = this.options.openConversations?.(panelId) ?? new Map();
    const { sessions } = await runtime.list(state.cwd);
    return newestFirst(sessions).map(session => {
      const entry: ChatTabConversation = { sessionId: session.sessionId };
      if (session.title) entry.title = session.title;
      if (session.updatedAt) entry.updatedAt = session.updatedAt;
      if (session.sessionId === state.acpSessionId) entry.current = true;
      else {
        const open = elsewhere.get(session.sessionId);
        if (open) entry.openIn = open;
      }
      return entry;
    });
  }

  /**
   * Reloads the tab on another conversation of its folder (/resume, "Pick another"). Refused while the
   * agent works, and for a conversation another Pane tab has open: two processes never write one.
   */
  async resume(panelId: string, sessionId: string): Promise<void> {
    const state = this.required(panelId);
    const tab = this.tab(panelId);
    if (state.turn || tab.delivering || tab.runtime?.isRunning() || tab.runtime?.isWorkingAlone()) {
      throw new PaneError('CHAT_RESUME_BUSY', 'The agent is in the middle of a turn, so the conversation was not changed.', 'Wait for it to finish, or press Stop, then pick again.');
    }
    if (sessionId === state.acpSessionId) return;
    // A queued prompt was written for this conversation; it is never sent into another one (review F-3).
    if (state.queue?.length) {
      throw new PaneError('CHAT_RESUME_QUEUED', `${state.queue.length === 1 ? 'A message is' : `${state.queue.length} messages are`} waiting to be sent in this conversation, so the conversation was not changed.`, 'Remove the waiting messages from the queue, or let them send, then pick again.');
    }
    const open = this.options.openConversations?.(panelId).get(sessionId);
    if (open) throw new PaneError('CHAT_RESUME_OPEN_ELSEWHERE', `That conversation is open in tab "${open.title}", so it was not opened here.`, 'Switch to that tab, or close it first and pick again.');
    console.log(`[ChatTabs] ${panelId} continues conversation ${sessionId}${state.acpSessionId ? ` instead of ${state.acpSessionId}` : ''}.`);
    this.update(panelId, current => ({ ...current, acpSessionId: sessionId, open: undefined, banner: undefined, clearedAt: undefined, turn: undefined }));
    forgetConversation(this.tab(panelId));
    await this.restart(panelId);
  }

  /** Closes the Switch to chat banner or note. */
  dismissBanner(panelId: string): void {
    if (!this.required(panelId).banner) return;
    this.update(panelId, current => ({ ...current, banner: undefined }));
    this.publish(panelId);
  }

  /** `runpane report` from the tab's agent; kept in its state like a terminal agent tab's report. */
  setReport(panelId: string, report: NonNullable<ChatPanelState['agentReport']>): void {
    this.update(panelId, state => ({ ...state, agentReport: report }));
  }

  /** The tab was closed: end its agent and forget its runtime. The agent keeps its own session. */
  async close(panelId: string): Promise<void> {
    const tab = this.tabs.get(panelId);
    if (!tab) return;
    await this.end(tab);
    tab.transcript?.dispose();
    this.bodies.clear(panelId);
    try { rmSync(this.pausedFile(panelId), { force: true }); } catch (error) { console.warn(`[ChatTabs] ${panelId}: could not remove its paused view:`, error); }
    this.tabs.delete(panelId);
    this.options.onClosed?.(panelId);
  }

  /**
   * Ends the tab's agent and leaves it stopped with `reason` (Autopilot turned off or replaced).
   * Unlike a crash it offers no Restart: whatever stopped it starts it again. The conversation is kept.
   */
  async stop(panelId: string, reason: { message: string; next: string }): Promise<void> {
    this.required(panelId);
    const tab = this.tabs.get(panelId);
    if (!tab) { this.stopWith(panelId, { code: 'exited', message: reason.message, next: reason.next }); return; }
    // One stop at a time, and a start or a Reload or Switch waits for it: a stop that is slow (or times
    // out) never ends an agent started after it, nor marks that one stopped (review F-6).
    const earlier = tab.stopping;
    const stopping = (async () => {
      await earlier;
      const generation = tab.generation;
      await this.end(tab, generation);
      if (tab.generation !== generation) return;
      this.stopWith(panelId, { code: 'exited', message: reason.message, next: reason.next });
    })();
    const settled: Promise<void> = stopping.catch(() => undefined).finally(() => { if (tab.stopping === settled) tab.stopping = undefined; });
    tab.stopping = settled;
    await stopping;
  }

  /** Pane is quitting: end every agent. Saved state is left as it was, so each tab comes back on the next launch. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.tabs.values()].map(tab => this.end(tab)));
  }

  async stopSession(sessionId: string): Promise<void> {
    await Promise.allSettled([...this.tabs.keys()].filter(panelId => this.options.store.panel(panelId)?.sessionId === sessionId).map(panelId => this.close(panelId)));
  }

  private async start(panelId: string, tab: Tab): Promise<void> {
    const panel = this.options.store.panel(panelId);
    if (!panel) throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.');
    tab.generation = tab.run = this.lastGeneration = Math.max(Date.now(), this.lastGeneration + 1);
    // Viewers keep seeing the conversation while the restart replays it.
    if (tab.transcript && tab.transcript.count() > 0) tab.held = tab.transcript.snapshot(DEFAULT_VIEW_LIMIT);
    tab.transcript?.dispose();
    tab.transcript = undefined;
    tab.notice = undefined;
    // A new agent process runs none of the old one's tool calls (one that died mid-call never ended them).
    tab.toolsRunning = undefined;
    const generation = tab.generation;
    // A resume from pause reads as idle while it starts; a crash Restart does not (watch must not see READY early).
    tab.resuming = !!this.required(panelId).paused;
    this.update(panelId, state => ({ ...state, status: 'starting', problem: undefined, paused: undefined }));
    this.publish(panelId);
    let launch: ResolvedLaunch;
    let transcript: ChatTranscript;
    try {
      // Inside the try: a chat-tabs folder that cannot be written leaves the tab stopped with Restart, not starting.
      const saved = this.required(panelId);
      const turnTimes = saved.turnTimes && saved.turnTimes.sessionId === saved.acpSessionId ? saved.turnTimes.turns : undefined;
      const dividers = saved.dividers?.filter(divider => divider.sessionId === saved.acpSessionId);
      transcript = tab.transcript = new ChatTranscript(panelId, tab.generation, { spoolFile: path.join(this.options.spoolDirectory, safeName(panelId), 'transcript.jsonl'), windowMessages: this.options.windowMessages, turnTimes, dividers, sentMessages: this.sentMessages.of(saved.acpSessionId) });
      launch = await this.options.launcher.resolve(panel, this.required(panelId));
    } catch (error) {
      const failure = chatFailure(error, { code: 'CHAT_LAUNCH_FAILED', next: 'Press Restart.' });
      this.stopWith(panelId, problemFrom(failure, this.required(panelId).agent, this.name));
      throw failure;
    }
    // Closed or restarted while the launch resolved: start nothing.
    if (tab.run !== generation) return;
    tab.launch = launch;
    const runtime = new ChatTabRuntime({
      command: launch.command,
      generation,
      onUpdate: update => {
        this.lastUpdateAt = tab.activeAt = Date.now();
        // A replayed call is history: one it left open (Pane quit mid-call) runs in no turn now.
        if (!tab.loading) trackToolCall(tab, update);
        let event: ChatTabEvent | undefined;
        try { event = transcript.accept(update); }
        catch (error) {
          // The agent's own session keeps the update; viewers are told the window may be incomplete.
          console.warn(`[ChatTabs] An update for ${panelId} could not be shown: ${reasonOf(error)}`);
          if (tab.run === generation) { tab.notice = 'Part of this conversation could not be shown. Press Restart to reload it from the agent.'; this.publish(panelId); }
          return;
        }
        if (event && !tab.loading && tab.run === generation) this.options.send('chat-tab:event', event);
      },
      onState: () => { if (tab.run === generation && !tab.loading) this.publish(panelId); },
      onOwnTurn: outcome => { if (tab.run === generation) this.ownTurn(panelId, tab, outcome); },
      onExit: exit => this.exited(panelId, generation, exit),
      approveOnce: () => tab.approveOnce === true,
      onApprovedOnce: request => {
        if (tab.run !== generation) return;
        const event = transcript.approvedByPane(request.toolCall.toolCallId, request.toolCall.title ?? 'Tool');
        if (event && !tab.loading) this.options.send('chat-tab:event', event);
      },
      terminalAuth: launch.ownCli === true,
      skills: agentConfig(this.required(panelId).agent)?.chat?.skills,
    });
    tab.runtime = runtime;
    tab.approveOnce = launch.approveOnce === true;
    try {
      const initialized = await runtime.start();
      this.options.onInitialized?.(this.required(panelId).agent, initialized);
      tab.signIn = launch.ownCli ? runtime.terminalSignIn() : undefined;
      if (this.required(panelId).open === 'most-recent' && !this.required(panelId).acpSessionId) {
        const listed = await this.listForSwitch(panelId, runtime);
        if (tab.run !== generation) return;
        // Chosen against who has which conversation now, and saved in the same step: with no await
        // between, a tab or terminal that took one while the list loaded is seen (review F-2).
        const chosen = this.mostRecent(panelId, listed);
        this.update(panelId, current => ({ ...current, open: undefined, acpSessionId: chosen.sessionId, banner: chosen.banner }));
      }
      const state = this.required(panelId);
      const request: NewSessionRequest = { cwd: state.cwd, mcpServers: launch.mcpServers ?? [] };
      if (launch.meta) request._meta = launch.meta;
      const create = async () => {
        const created = await runtime.create(request);
        // A new conversation's dividers (a switch that started it) belong to it from now on.
        this.update(panelId, current => ({
          ...current, acpSessionId: created.sessionId, settings: { ...launch.initialSettings, ...current.settings },
          dividers: current.dividers?.map(divider => divider.sessionId ? divider : { ...divider, sessionId: created.sessionId }),
        }));
        transcript.replayed();
      };
      const open = async () => {
        if (!state.acpSessionId) { await create(); return; }
        tab.loading = true;
        let failure: unknown;
        try { await runtime.load({ ...request, sessionId: state.acpSessionId }); }
        catch (error) { failure = error; }
        finally { tab.loading = false; }
        if (failure === undefined) { transcript.replayed(); return; }
        // An agent saves a conversation with its first message, so one that never had a turn can't be
        // reopened: it starts again. A conversation that had turns and is gone says so.
        const hadTurns = state.turnTimes?.sessionId === state.acpSessionId;
        if (!hadTurns && failure instanceof PaneError && failure.code === 'CHAT_CONVERSATION_NOT_FOUND') {
          console.log(`[ChatTabs] ${panelId} starts a new conversation: ${state.acpSessionId} had no message, so the agent never saved it.`);
          await create();
          return;
        }
        // T-63 fail-safe: a Reload or Switch never drops the history. The agent couldn't load the
        // conversation on its new profile, so a new one starts, given the saved transcript.
        const fallback = this.required(panelId).loadFallback;
        if (!fallback || tab.run !== generation) throw failure;
        const reason = reasonOf(failure).replace(/\.$/, '');
        console.warn(`[ChatTabs] ${panelId} could not continue its conversation after a profile change (${reason}); it starts a new one given the transcript.`);
        transcript.dispose();
        transcript = tab.transcript = new ChatTranscript(panelId, tab.generation, { spoolFile: path.join(this.options.spoolDirectory, safeName(panelId), 'transcript.jsonl'), windowMessages: this.options.windowMessages });
        tab.held = undefined;
        const at = new Date().toISOString();
        const text = 'Couldn\'t continue the conversation · new conversation, given the transcript';
        this.update(panelId, current => ({ ...current, acpSessionId: undefined, turnTimes: undefined, dividers: [...current.dividers ?? [], { leading: true as const, text, at }].slice(-DIVIDERS_LIMIT) }));
        transcript.divider({ text, at });
        await create();
        // Only now, as it hands over, does the transcript go in the Session folder (review F-7). Without
        // one the private copy is handed over and kept.
        const saved = this.required(panelId);
        let handed = fallback.file;
        if (saved.sessionFolder) handed = writeTranscriptFile(saved.sessionFolder, state.acpSessionId ?? `conversation-${Date.now()}`, readFileSync(fallback.file, 'utf8'));
        else this.update(panelId, current => ({ ...current, loadFallback: undefined }));
        this.queueTranscript(panelId, handed, `${this.name(state.agent)} couldn't continue this Session's conversation after its profile changed, so Pane started a new one.`);
      };
      await open();
      if (launch.mode) await runtime.setMode(launch.mode);
      await this.applySettings(panelId, runtime);
      const interrupted = this.required(panelId).turn;
      if (interrupted) {
        // The turn's own row reads "Stopped when Pane closed."
        this.endTurn(panelId, tab, { type: 'pane_turn', stopReason: 'interrupted', startedAt: interrupted.startedAt, endedAt: new Date().toISOString() });
        this.update(panelId, current => ({
          ...current, turn: undefined,
          receipts: current.receipts?.map(receipt => receipt.operationId === interrupted.operationId && receipt.state === 'accepted' ? { ...receipt, state: 'failed', error: 'Pane closed before the turn finished.' } : receipt),
        }));
      }
      // Closed or stopped while starting: the tab stays as that left it.
      if (tab.run !== generation) return;
      const { notice } = this.required(panelId);
      if (notice) tab.notice = notice;
      tab.held = undefined;
      tab.activeAt = Date.now();
      this.update(panelId, current => ({ ...current, status: 'idle', notice: undefined }));
      this.discardFallback(panelId);
      this.publish(panelId);
      this.sendInitialInput(panelId);
      this.drain(panelId);
    } catch (error) {
      if (tab.run !== generation) return;
      tab.runtime = undefined;
      tab.held = undefined;
      await runtime.stop().catch(() => undefined);
      const failure = chatFailure(error, { code: 'CHAT_START_FAILED', next: 'Press Restart. If it fails again, check the agent is installed and signed in on this machine.' });
      this.discardFallback(panelId);
      this.stopWith(panelId, problemFrom(failure, this.required(panelId).agent, this.name));
      throw failure;
    }
  }

  /** The folder's conversations for Switch to chat, newest first, or why they could not be listed. */
  private async listForSwitch(panelId: string, runtime: ChatTabRuntime): Promise<SwitchListing> {
    try {
      const listed = await runtime.list(this.required(panelId).cwd);
      return { sessions: newestFirst(listed.sessions), complete: listed.complete };
    } catch (error) {
      console.warn(`[ChatTabs] ${panelId} could not list its folder's conversations, so it starts a new one: ${reasonOf(error)}`);
      return { error: reasonOf(error).replace(/\.$/, '') };
    }
  }

  /**
   * Switch to chat when Pane wasn't sure of the terminal's conversation (D-282): the folder's newest
   * conversation that no other Pane tab has open. None left, or no list, starts a new one, and says so.
   * Synchronous, so the caller can save the choice before anything else claims it.
   */
  private mostRecent(panelId: string, listed: SwitchListing): SwitchChoice {
    if ('error' in listed) return { banner: { kind: 'list-failed', reason: listed.error } };
    const { sessions, complete } = listed;
    const elsewhere = this.options.openConversations?.(panelId) ?? new Map();
    const chosen = sessions.find(session => !elsewhere.has(session.sessionId));
    console.log(`[ChatTabs] ${panelId} opens ${chosen ? `the folder's most recent conversation ${chosen.sessionId}` : 'a new conversation'}: ${sessions.length} listed${complete ? '' : ' (list cut short)'}, ${sessions.filter(session => elsewhere.has(session.sessionId)).length} open in other tabs.`);
    if (chosen) return { sessionId: chosen.sessionId, banner: { kind: 'most-recent' } };
    // Every listed one is taken, but the list stopped early: older ones may be free, so this is not "none".
    if (!complete) return { banner: { kind: 'list-failed', reason: `Pane lists only the newest ${CHAT_CONVERSATION_LIMIT.toLocaleString('en-US')}, and every one of those is open in another tab` } };
    return { banner: { kind: 'none' } };
  }

  private async applySettings(panelId: string, runtime: ChatTabRuntime): Promise<void> {
    const settings = this.required(panelId).settings ?? {};
    for (const [id, value] of Object.entries(settings)) {
      const control = runtime.controls().find(entry => entry.id === id);
      if (!control || control.currentValue === value || !control.options.some(option => option.value === value)) continue;
      try { await runtime.configure(id, value); }
      catch (error) { console.warn(`[ChatTabs] Could not apply ${id}=${value} to ${panelId}: ${reasonOf(error)}. The agent's own setting is kept.`); }
    }
  }

  private sendInitialInput(panelId: string): void {
    const state = this.required(panelId);
    if (!state.initialInput || state.initialInputSentAt) return;
    const operationId = `initial:${panelId}`;
    // Marked only once the prompt is accepted. A start that dies in between sends it
    // again with the same ID, which returns the first receipt instead of a second prompt.
    try { this.send(panelId, { operationId, text: promptForAgent(state.initialInput) }); }
    catch (error) {
      console.warn(`[ChatTabs] The first message for ${panelId} was not sent: ${reasonOf(error)}.`);
      this.tab(panelId).notice = `The opening message was not sent: ${error instanceof PaneError ? `${error.message} ${error.next ?? ''}`.trim() : reasonOf(error)} Press Restart to try it again.`;
      this.publish(panelId);
      return;
    }
    this.update(panelId, current => ({ ...current, initialInputSentAt: new Date().toISOString() }));
  }

  /** Delivers the next queued prompt when the agent is free. */
  private drain(panelId: string): void {
    const tab = this.tab(panelId);
    const runtime = tab.runtime;
    const state = this.required(panelId);
    // A Reload or Switch goes before the next queued message, which then reaches the new profile.
    if (state.relaunch) { this.relaunchWhenFree(panelId); return; }
    if (!runtime?.isAlive() || runtime.isRunning() || runtime.isWorkingAlone() || tab.delivering || tab.steering || tab.loading || state.status === 'starting' || state.status === 'stopped') return;
    const next = state.queue?.[0];
    if (!next) return;
    const body = next.stored ? this.bodies.read(panelId, next.operationId) : { text: next.text, images: next.images };
    if (!body) {
      this.update(panelId, current => ({
        ...current, queue: current.queue?.slice(1),
        receipts: current.receipts?.map(receipt => receipt.operationId === next.operationId ? { ...receipt, state: 'failed', error: 'The saved copy of this queued message is missing, so it was not sent.' } : receipt),
      }));
      this.publish(panelId);
      this.drain(panelId);
      return;
    }
    tab.delivering = true;
    tab.activeAt = Date.now();
    tab.toolsRunning = undefined;
    const generation = tab.generation;
    const content = promptContent(body);
    const sent = this.sentContent(panelId, runtime, body);
    this.rememberTyped(panelId, body.text, sent);
    const startedAt = new Date().toISOString();
    for (const event of tab.transcript?.userMessage(next.operationId, content, false, sent) ?? []) this.options.send('chat-tab:event', event);
    this.update(panelId, current => ({ ...current, queue: current.queue?.slice(1), turn: { operationId: next.operationId, startedAt }, status: 'working' }));
    this.bodies.remove(panelId, next.operationId);
    const finish = (outcome: 'completed' | 'failed', stopReason: string, error?: PaneError) => {
      // A turn of a released runtime ends after the release: the next runtime's delivery is not its to end.
      if (tab.run !== generation) return;
      tab.delivering = false;
      // A tool call the turn left open (an agent need not close one on cancel) is over with it.
      tab.toolsRunning = undefined;
      if (!this.options.store.state(panelId)) return;
      const marker = this.endTurn(panelId, tab, { type: 'pane_turn', stopReason, startedAt, endedAt: new Date().toISOString() });
      if (marker) this.options.send('chat-tab:event', marker);
      tab.notice = stopReason === 'refusal' ? 'The agent declined this request.' : stopReason === 'max_tokens' ? 'The reply hit the length limit.' : stopReason === 'max_turn_requests' ? 'The turn hit its step limit.' : undefined;
      this.update(panelId, current => ({
        ...current, turn: undefined, status: current.status === 'stopped' ? 'stopped' : 'idle',
        receipts: current.receipts?.map(receipt => receipt.operationId === next.operationId ? { ...receipt, state: outcome, error: error?.message } : receipt),
      }));
      if (error && isAuthRequired(error)) {
        void this.release(tab).then(() => this.stopWith(panelId, signedOut(this.required(panelId).agent, this.name)));
        return;
      }
      this.publish(panelId);
      this.drain(panelId);
    };
    this.publish(panelId);
    void runtime.prompt(sent).then(result => finish('completed', result.stopReason), error => { void runtime.exitsWithin(250).then(exited => finish('failed', exited ? 'exited' : 'error', chatFailure(error))); });
  }

  /**
   * The agent started or ended a turn with no prompt open. What the person sends
   * meanwhile waits in the queue, so it lands below everything that turn does (D-193).
   */
  private ownTurn(panelId: string, tab: Tab, outcome: 'started' | 'end_turn' | 'cancelled' | 'error'): void {
    if (outcome === 'started') tab.ownTurnStartedAt = new Date().toISOString();
    else if (tab.ownTurnStartedAt) {
      const marker = this.endTurn(panelId, tab, { type: 'pane_turn', stopReason: outcome, startedAt: tab.ownTurnStartedAt, endedAt: new Date().toISOString() });
      tab.ownTurnStartedAt = undefined;
      if (marker && !tab.loading) this.options.send('chat-tab:event', marker);
    }
    // A tool call the turn left open is over with it, unless a prompt is still in flight: its
    // calls share the map, and its own end forgets them.
    if (outcome !== 'started' && !tab.delivering) tab.toolsRunning = undefined;
    if (tab.loading) return;
    this.publish(panelId);
    if (outcome !== 'started') this.drain(panelId);
  }

  /** Ends a turn in the transcript and saves its time row, so a restart's replay shows it again. */
  private endTurn(panelId: string, tab: Tab, marker: TurnMarker): ChatTabEvent | undefined {
    const ended = tab.transcript?.endTurn(marker);
    const saved = ended?.saved;
    // A turn that ends while history replays is the agent's own, already saved: its rows come back from the replay.
    if (saved && !tab.loading) {
      this.update(panelId, current => current.acpSessionId ? { ...current, turnTimes: withTurnTime(current, current.acpSessionId, saved) } : current);
    }
    return ended?.event;
  }

  private pausedFile(panelId: string): string { return path.join(this.options.spoolDirectory, safeName(panelId), 'paused.json'); }

  /** What a paused tab shows until its agent is back: the newest window and the composer's controls, kept on disk through a Pane restart. */
  private savePaused(panelId: string, tab: Tab): void {
    const sessionId = this.options.store.state(panelId)?.acpSessionId;
    const held = tab.transcript && tab.transcript.count() > 0 ? tab.transcript.snapshot(DEFAULT_VIEW_LIMIT) : tab.held;
    if (!sessionId || !held) return;
    try {
      const file = this.pausedFile(panelId);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ sessionId, held: boundedWindow(held), shown: tab.shown }), { mode: 0o600 });
    } catch (error) {
      // Only the look after a Pane restart depends on it; the tab still pauses and resumes.
      console.warn(`[ChatTabs] ${panelId}'s paused view was not saved: ${reasonOf(error)}`);
    }
  }

  private loadPaused(panelId: string, tab: Tab): void {
    const state = this.options.store.state(panelId);
    if (!state?.paused || !state.acpSessionId) return;
    try {
      const saved = decodeOptionalBoundary(JSON.parse(readFileSync(this.pausedFile(panelId), 'utf8')), chatPausedViewSchema);
      if (!saved || saved.sessionId !== state.acpSessionId) return;
      tab.held = { ...saved.held, panelId, generation: 0 };
      if (saved.shown) tab.shown = saved.shown;
    } catch {
      // No saved view: the tab looks as any tab does while it starts.
    }
  }

  private exited(panelId: string, generation: number, exit: RuntimeExit): void {
    const tab = this.tabs.get(panelId);
    if (!tab || tab.run !== generation || exit.expected) return;
    tab.runtime = undefined;
    if (!this.options.store.state(panelId)) return;
    const detail = exit.stderr.split('\n').filter(Boolean).at(-1);
    this.stopWith(panelId, { code: 'exited', message: `${exit.message}${detail ? ` Last output: ${detail}` : ''}`, next: 'Press Restart to start it again. The conversation is kept.', action: 'restart' });
  }

  private stopWith(panelId: string, problem: ChatTabProblem): void {
    if (!this.options.store.state(panelId)) return;
    this.update(panelId, state => ({ ...state, status: 'stopped', problem, turn: undefined }));
    this.publish(panelId);
  }

  /**
   * Ends the tab's agent without waiting for a start to finish: the release makes the
   * start give up, and the wait for it and the agent is capped so a hung adapter cannot hold up a quit.
   */
  private async end(tab: Tab, onlyGeneration?: number): Promise<void> {
    const starting = tab.starting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ending = (async () => {
      await this.release(tab);
      await starting?.catch(() => undefined);
      // A restart racing this may have started another runtime meanwhile. With `onlyGeneration`, one
      // started after the stop (a Switch back) is left running, even when this ends after the timeout.
      if (onlyGeneration === undefined || tab.generation === onlyGeneration) await this.release(tab);
    })();
    await Promise.race([ending, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.stopTimeoutMs ?? 5000); })]);
    clearTimeout(timer);
  }

  private async release(tab: Tab): Promise<void> {
    const runtime = tab.runtime;
    tab.runtime = undefined;
    tab.delivering = false;
    tab.toolsRunning = undefined;
    // Outcomes that arrive while stopping belong to no runtime: a turn cut off by a
    // quit stays recorded, so the next start can say it stopped. The public generation
    // is kept, so viewers accept the stopped state published next.
    tab.run = 0;
    await runtime?.stop();
  }

  /** The running agent; a paused tab's controls stay live, so using one resumes its agent first. A stopped tab stays stopped. */
  private async wokenRuntime(panelId: string): Promise<ChatTabRuntime> {
    const state = this.required(panelId);
    if (state.status !== 'stopped' && (state.paused || this.tabs.get(panelId)?.pausing)) await this.ensure(panelId);
    return this.liveRuntime(panelId);
  }

  private liveRuntime(panelId: string): ChatTabRuntime {
    this.required(panelId);
    const runtime = this.tabs.get(panelId)?.runtime;
    if (!runtime?.isAlive()) throw new PaneError('CHAT_NOT_RUNNING', 'This chat\'s agent is not running. Nothing was sent.', 'Press Restart, or wait for the tab to finish starting.');
    return runtime;
  }

  private snapshot(panelId: string, state: ChatPanelState, tab: Tab, limit: number): ChatTabView {
    const runtime = tab.runtime?.isAlive() && !tab.loading ? tab.runtime : undefined;
    if (runtime) tab.shown = { controls: [...runtime.controls(), ...fullAccessControl(state)], commands: runtime.commands(), canAttachImages: runtime.supportsImages() };
    // A stopped tab offers nothing; a starting or paused one keeps showing what its agent last offered.
    const shown = state.status === 'stopped' ? undefined : tab.shown;
    const ready = tab.transcript && replayed(tab);
    const permissions = runtime ? runtime.permissions().map(permission => ({
      id: permission.id, generation: tab.generation,
      title: permission.request.toolCall.title ?? 'Approval needed',
      toolCall: decodeBoundary(permission.request.toolCall, boundary.json),
      options: permission.request.options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
    })) : [];
    const questions = runtime ? runtime.questions().map(question => ({
      id: question.id, generation: tab.generation, message: question.request.message,
      schema: 'requestedSchema' in question.request ? decodeBoundary(question.request.requestedSchema, boundary.json) : {},
      toolCallId: decodeOptionalBoundary(question.request, boundary.object({ toolCallId: boundary.optional(boundary.string) }))?.toolCallId,
    })) : [];
    const view: ChatTabView = {
      panelId, agent: state.agent, generation: tab.generation, status: this.status(state, tab), problem: state.problem, notice: tab.notice,
      canAttachImages: tab.runtime?.supportsImages() ?? shown?.canAttachImages ?? false,
      controls: shown?.controls ?? [], commands: shown?.commands ?? [],
      permissions, questions, queue: state.queue ?? [],
      // While history replays the window is incomplete; viewers fetch it once the tab has started.
      transcript: limit <= 0 ? undefined : ready ? tab.transcript!.snapshot(limit) : tab.held && heldWindow(tab.held, limit),
      messageCount: ready || !tab.held ? tab.transcript?.count() ?? 0 : tab.held.start + tab.held.messages.length,
      ...extras(state, runtime),
    };
    if (state.banner) view.banner = state.banner;
    // Autopilot's folder holds its run files, so its chat lists none.
    view.mentions = {};
    if (!state.autopilotRunId) view.mentions.files = true;
    if (agentConfig(state.agent)?.chat?.skills) view.mentions.skills = true;
    return view;
  }

  private status(state: ChatPanelState, tab: Tab): ChatTabStatus {
    if (state.status === 'stopped') return 'stopped';
    if (tab.starting || tab.loading || !tab.runtime) return tab.runtime || tab.starting ? 'starting' : state.status === 'starting' ? 'starting' : 'idle';
    if (tab.runtime.permissions().length || tab.runtime.questions().length) return 'blocked';
    return tab.runtime.isRunning() || tab.runtime.isWorkingAlone() || tab.delivering ? 'working' : 'idle';
  }

  private publish(panelId: string): void {
    const state = this.options.store.state(panelId);
    if (!state) return;
    const tab = this.tab(panelId);
    const view = this.snapshot(panelId, state, tab, 0);
    this.options.send('chat-tab:view', view);
    if (agentConfig(view.agent)?.chat?.legacyClients) this.options.send('chat-tab:state', view);
    this.options.onView?.(view);
    const agentState = publishedState(view, tab);
    if (tab.published === agentState) return;
    const previous = tab.published;
    tab.published = agentState;
    const panel = this.options.store.panel(panelId);
    if (!panel) return;
    const event: PanelAgentStatusEvent = {
      panelId, sessionId: panel.sessionId, agentType: state.agent, state: agentState,
      reason: agentState === 'blocked' ? view.problem?.message ?? (view.questions.length ? 'Agent asked a question' : 'Agent asked for approval') : null,
      workedVisibly: agentState === 'idle' ? previous === 'working' : undefined,
    };
    this.options.send('panel:agentStatus', event);
    this.options.onStatus?.(event);
  }

  private tab(panelId: string): Tab {
    let tab = this.tabs.get(panelId);
    if (!tab) {
      tab = { generation: 0, run: 0, loading: false, delivering: false };
      this.tabs.set(panelId, tab);
      this.loadPaused(panelId, tab);
    }
    return tab;
  }

  private required(panelId: string): ChatPanelState {
    const state = this.options.store.state(panelId);
    if (!state) throw new PaneError('CHAT_PANEL_MISSING', 'This chat tab no longer exists.', 'Open another chat tab.');
    return state;
  }

  private update(panelId: string, change: (state: ChatPanelState) => ChatPanelState): void {
    this.options.store.commit(panelId, change(this.required(panelId)));
  }
}

function toAgentState(view: ChatTabView): AgentState {
  if (view.status === 'blocked' || (view.status === 'stopped' && view.problem)) return 'blocked';
  if (view.status === 'working' || view.status === 'starting') return 'working';
  return view.status === 'idle' ? 'idle' : 'unknown';
}

/** `{ after }` when there is a message to follow, else nothing (the divider goes at the end). */
function withAfter(after: string | undefined): Pick<ChatDivider, 'after'> {
  return after ? { after } : {};
}

/** The tab moves to another conversation: what it showed is not held through the start. */
function forgetConversation(tab: Tab): void {
  tab.transcript?.dispose();
  tab.transcript = undefined;
  tab.held = undefined;
}

/** The transcript holds the whole conversation: no start is replaying it. Until then readers get the held window. */
function replayed(tab: Tab): boolean { return !tab.loading && !tab.starting; }

/** A held window small enough to save: the newest messages that fit in 2 MiB. */
function boundedWindow(held: ChatTabTranscript): ChatTabTranscript {
  let window = held;
  while (window.messages.length > 1 && JSON.stringify(window.messages).length > 2 * 1024 * 1024) window = heldWindow(window, Math.floor(window.messages.length / 2));
  return window;
}

/** The newest `limit` messages of a held window. */
function heldWindow(held: ChatTabTranscript, limit: number): ChatTabTranscript {
  const messages = held.messages.slice(-limit);
  return { ...held, start: held.start + held.messages.length - messages.length, messages: structuredClone(messages) };
}

/** The conversation's time rows with `turn` added, newest kept; another conversation's rows are dropped. */
function withTurnTime(state: ChatPanelState, sessionId: string, turn: ChatTurnTime): NonNullable<ChatPanelState['turnTimes']> {
  const turns = state.turnTimes?.sessionId === sessionId ? state.turnTimes.turns : [];
  return { sessionId, turns: [...turns, turn].slice(-TURN_TIMES_LIMIT) };
}

/** Follow the turn's tool calls: pending or in progress keeps a silent turn counting, unless the call is a runpane wait. */
function trackToolCall(tab: Tab, update: SessionUpdate): void {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
  const status = update.status;
  if (status === 'pending' || status === 'in_progress' || (update.sessionUpdate === 'tool_call' && status == null)) {
    const known = tab.toolsRunning?.get(update.toolCallId);
    // An update may bring the call's input later; until then it keeps what it was first read as.
    const wait = update.rawInput !== undefined || update.title ? isRunpaneWait(update) : known ?? false;
    (tab.toolsRunning ??= new Map()).set(update.toolCallId, wait);
  } else if (status === 'completed' || status === 'failed') {
    tab.toolsRunning?.delete(update.toolCallId);
  }
}

/** A shorter stall limit for tests (`PANE_CHAT_STALL_MS`); the default otherwise. */
function chatStallMs(): number {
  const override = Number(process.env.PANE_CHAT_STALL_MS);
  return Number.isFinite(override) && override > 0 ? override : CHAT_STALL_MS;
}

/** A resume from pause with nothing to send reads as idle, so the tab and sidebar do not flash a spinner. */
function publishedState(view: ChatTabView, tab: Tab): AgentState {
  if (view.status === 'starting' && tab.resuming && view.queue.length === 0) return 'idle';
  return toAgentState(view);
}

function promptSize(body: Pick<ChatTabSend, 'text' | 'images'>): number {
  return body.text.length + (body.images ?? []).reduce((sum, image) => sum + image.data.length, 0);
}

/** Context usage, background tasks, the last /clear and whether Send now steers, each only when there is one. */
function extras(state: ChatPanelState, runtime: ChatTabRuntime | undefined): Pick<ChatTabView, 'context' | 'tasks' | 'clearedAt' | 'sendNowSteers'> {
  const result: Pick<ChatTabView, 'context' | 'tasks' | 'clearedAt' | 'sendNowSteers'> = {};
  if (runtime?.canSteer() && !runtime.isWorkingAlone()) result.sendNowSteers = true;
  const usage = runtime?.usage();
  if (usage && usage.size > 0) result.context = usage;
  const tasks = runtime?.tasks() ?? [];
  if (tasks.length) result.tasks = tasks;
  if (state.clearedAt) result.clearedAt = state.clearedAt;
  return result;
}

/** Newest first by the agent's `updatedAt`, undated last; the agent's own order breaks ties. */
function newestFirst(sessions: SessionInfo[]): SessionInfo[] {
  const time = (session: SessionInfo) => { const at = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN; return Number.isNaN(at) ? -Infinity : at; };
  return sessions.map((session, index) => ({ session, index, at: time(session) }))
    .sort((a, b) => (a.at === b.at ? 0 : b.at > a.at ? 1 : -1) || a.index - b.index)
    .map(entry => entry.session);
}

/** The folder's conversations for Switch to chat, newest first (`complete`: nothing was left out), or why there are none. */
type SwitchListing = { sessions: SessionInfo[]; complete: boolean } | { error: string };

/** The conversation Switch to chat opens, none for a new one, and the banner that says so. */
interface SwitchChoice { sessionId?: string; banner: ChatTabSwitchBanner }

function safeName(panelId: string): string { return createHash('sha256').update(panelId).digest('hex').slice(0, 32); }

const FULL_ACCESS_ON = 'on';

/** Whether Pane owns the tab's full-access switch: an agent launch whose agent has no full-access session mode. */
function fullAccessControlled(state: ChatPanelState): boolean {
  return state.launch.kind === 'agent' && !state.launch.mode && !agentConfig(state.agent)?.chat?.fullAccess?.mode;
}

/** Pane's Full access setting, beside the agent's own, for an agent whose full access is not one of its modes. */
function fullAccessControl(state: ChatPanelState): AgentChatConfigOption[] {
  if (!fullAccessControlled(state) || state.launch.kind !== 'agent') return [];
  return [{ id: CHAT_FULL_ACCESS_CONTROL, name: 'Full access', currentValue: state.launch.fullAccess ? FULL_ACCESS_ON : 'off', options: [{ value: FULL_ACCESS_ON, name: 'On' }, { value: 'off', name: 'Off' }] }];
}

function signedOut(agent: ChatPanelState['agent'], name: (agent: string) => string): ChatTabProblem {
  const config = agentConfig(agent);
  const command = config?.chat ? ` (\`${[config.executables[0], ...config.signIn].join(' ')}\`)` : '';
  return { code: 'signed-out', message: `${name(agent)} is not signed in on this machine.`, next: `Press Sign in to sign in${command} in a terminal tab, then press Retry.`, action: 'sign-in' };
}

function problemFrom(error: PaneError, agent: ChatPanelState['agent'], name: (agent: string) => string): ChatTabProblem {
  if (isAuthRequired(error)) return signedOut(agent, name);
  const install = agentConfig(agent)?.install.url;
  const action = (next: string): ChatTabProblem => install ? { code: 'not-installed', message: error.message, next, action: 'install', url: install } : { code: 'not-installed', message: error.message, next };
  if (error.code === 'CHAT_AGENT_NOT_INSTALLED') return action(error.next ?? 'Install it, then press Retry.');
  if (error.code === 'CHAT_UNSUPPORTED_HOST') return { code: 'unsupported-host', message: error.message, next: error.next ?? 'Open a terminal agent tab instead.' };
  // #1236: chat checks the installed CLI. Too old a CLI is fixed by installing a newer one.
  if (error.code === 'CHAT_AGENT_OUTDATED') return action(error.next ?? 'Update it, then press Retry.');
  if (error.code === 'CHAT_ADAPTER_MISSING') return { code: 'adapter-setup', message: error.message, next: error.next ?? 'Reinstall Pane from runpane.com.' };
  return { code: 'failed', message: error.message, next: error.next ?? 'Press Restart.', action: 'restart' };
}
