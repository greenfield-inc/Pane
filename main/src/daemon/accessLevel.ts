import { READ_ONLY_ACCESS_CODE } from '../../../shared/types/accessLevel';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { GLASSES_CHANNELS, GLASSES_EVENT_CHANNELS } from './glassesAccess';

/**
 * What an authenticated remote caller may reach. `full`: a paired device, a linked computer or a
 * Tailscale login, with today's rules. `read`: a device paired Read only. `glasses`: the glasses app.
 */
export type CallerAccess = 'full' | 'read' | 'glasses';

/**
 * Every command a read-only device reaches, with why it is safe to show a second person. A command
 * missing here is refused, including every command added later.
 */
const READ_CHANNELS: ReadonlySet<string> = new Set([
  // Panes and repositories: names, branches, status and cached git status. Repository settings are left out (`readable`).
  'sessions:get-all',
  'sessions:get-all-with-projects',
  'sessions:get-archived-with-projects',
  'sessions:get',
  'sessions:get-pane-order',
  'projects:get-all',
  'projects:get-active',
  'folders:get-by-project',
  // Transcripts the agents wrote; reads of saved messages.
  'sessions:get-conversation',
  'sessions:get-conversation-messages',
  'sessions:get-conversation-message-count',
  'panels:get-conversation-messages',
  'panels:get-prompts',
  // A Pane's terminal and chat tabs, their layout and whether they run. Other kinds of tab are left out (`readable`).
  'panels:list',
  'panels:getActive',
  'panels:get-layout',
  'panels:checkInitialized',
  // Every agent's status, and the agents' screens on the grid.
  'panels:agent-statuses',
  'mission-control:list-agents',
  'mission-control:snapshots',
  // Chat transcripts. Reading one starts no agent for a read-only device (`ChatTabManager.view`).
  'chat-tab:get',
  'chat-tab:history',
  // The names of the agents chats can run.
  'chat-tab:agents',
  // Sessions: their list, one Session (opening it changes nothing here for a read-only device), overview and activity.
  'orchestration-sessions:list',
  'orchestration-sessions:get',
  'orchestration-sessions:overview',
  'orchestration-sessions:activity-list',
  // Terminal output.
  'terminal:getState',
  'terminal:getAltScreenState',
  'terminal:getScrollbackClean',
  // To-dos and loops: the owner's work lists.
  'todos:snapshot',
  'todos:detail',
  'loops:list',
  // What a client shows before a Session opens. A read-only device gets no shortcuts, commands or voice (`remote:pwa-affordances`).
  'remote:pwa-affordances',
  // The same reads for runpane and the pane MCP.
  'runpane:repos:list',
  'runpane:panes:list',
  'runpane:panes:overview',
  'runpane:panels:list',
  'runpane:panels:screen',
  'runpane:panels:output',
  'runpane:panels:last-message',
  'runpane:sessions:list',
  'runpane:sessions:get',
  'runpane:sessions:overview',
  'runpane:workspace:state',
  'runpane:todos:list',
  'runpane:todos:show',
  'runpane:loops:list',
  // The computer's name and Pane version, for `runpane workspace list`.
  'runpane:workspaces:describe',
  // This computer's own address, already known from pairing, and tokens (read-only ones) on the computers linked with it.
  'relay:client:computer',
  'relay:client:computers',
]);

/**
 * Bookkeeping a viewer's app sends while it only watches. Answered without running, so a read-only
 * viewer never starts or resizes a terminal, slows its output, answers its queries or moves the
 * owner's view. Its output still arrives: a stream gets every terminal's bytes, shown or not.
 */
const READ_ANSWERS: ReadonlyMap<string, JsonValue> = new Map<string, JsonValue>([
  ['terminal:setVisibility', null],
  ['terminal:ack', null],
  ['terminal:resetFlowControl', null],
  ['terminal:resize', null],
  ['panels:resize-terminal', null],
  ['terminal:reply', { delivered: false }],
  ['panels:initialize', false],
  ['panels:set-active', { success: true }],
  ['sessions:mark-viewed', { success: true }],
]);

/** Every event a read-only stream carries. An event missing here is never sent to one, including every event added later. */
const READ_EVENT_CHANNELS: ReadonlySet<string> = new Set([
  // Terminal output and whether a terminal runs.
  'terminal:output',
  'terminal:alternateScreen',
  'terminal:cliReady',
  'terminal:ptyReady',
  'terminal:relaunched',
  'terminal:exited',
  // Agent status.
  'panel:agentStatus',
  'panel:activityStatus',
  // Terminal and chat tabs coming, changing and going (`readableEvent` leaves out other kinds).
  'panel:created',
  'panel:updated',
  'panel:deleted',
  'panel:event',
  // Conversations.
  'panel:prompt-added',
  'panel:response-added',
  'chat-tab:event',
  'chat-tab:view',
  'chat-tab:state',
  // Panes, repositories and folders.
  'session:created',
  'session:creation-failed',
  'session:updated',
  'session:deleted',
  'sessions:loaded',
  'project:updated',
  'project:list-changed',
  'folder:created',
  'folder:updated',
  'folder:deleted',
  'git-status-updated',
  'git-status-loading',
  // Sessions.
  'orchestration-sessions:changed',
  'orchestration-sessions:activity',
  'orchestration-sessions:overview-updated',
  // "Read the list again", with no contents.
  'todos:changed',
  'loops:changed',
]);

interface Reach { channels: ReadonlySet<string>; events: ReadonlySet<string> }

const REACH = {
  full: null,
  read: { channels: READ_CHANNELS, events: READ_EVENT_CHANNELS },
  glasses: { channels: GLASSES_CHANNELS, events: GLASSES_EVENT_CHANNELS },
} satisfies Record<CallerAccess, Reach | null>;

/** The one access check: whether a caller at this level may run a command. */
export function mayInvoke(access: CallerAccess, channel: string): boolean {
  return REACH[access]?.channels.has(channel) ?? true;
}

/** Whether a stream at this level carries an event. */
export function mayReceive(access: CallerAccess, channel: string): boolean {
  return REACH[access]?.events.has(channel) ?? true;
}

/** A read-only viewer's bookkeeping, answered here instead of run; undefined for every other command. */
export function readOnlyAnswer(channel: string): JsonValue | undefined {
  return READ_ANSWERS.get(channel);
}

/** What a read-only device is told when it asks for something it may not do. */
export function readOnlyRefusal(what: string) {
  return {
    message: `This device is paired Read only with this computer, so it can't use ${what}. Nothing was run or changed.`,
    code: READ_ONLY_ACCESS_CODE,
    next: 'Ask the computer\'s owner for full access: they remove this device in Settings › Remote Access, then add it again with Full access.',
  };
}

/**
 * Settings inside a readable record: a repository's scripts and prompts, and how a Session or loop
 * launches and behaves. They are configuration and can hold a key the screen never shows. Dropped wherever
 * they appear in a read-only device's answers and events.
 */
const HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'system_prompt', 'run_script', 'build_script', 'archive_script', 'open_ide_command',
  'launchCommand', 'toolCommand', 'launch', 'initialInput', 'openingPrompt', 'customResume', 'profile', 'orchestrationProfile',
]);

/** What a tab's own state shows a viewer. Everything else in it, and whatever is added to it later, stays with the owner. */
const TAB_STATE_FIELDS: ReadonlySet<string> = new Set([
  'isInitialized', 'cwd', 'shellType', 'isAlternateScreen', 'dimensions', 'lastActivityTime', 'wasInterrupted', 'paused',
  'agentType', 'agentDetection', 'agentReport', 'isCliPanel', 'isCliReady', 'orchestrationSessionId', 'sshHost',
  // Chat tabs.
  'agent', 'status', 'problem', 'notice', 'clearedAt',
]);

/** The kinds of tab a read-only device sees; a file, diff, browser or log tab carries contents it may not open. */
const READABLE_TAB_TYPES: ReadonlySet<string> = new Set(['terminal', 'chat']);

const tabSchema = boundary.object({ type: boundary.string });

function isReadableTab(tab: JsonValue | undefined): boolean {
  return READABLE_TAB_TYPES.has(decodeOptionalBoundary(tab, tabSchema)?.type ?? '');
}

/** A tab list's entry stays unless it is another kind of tab; a closed one, listed by id alone, has no kind. */
function staysInTabList(entry: JsonValue): boolean {
  return decodeOptionalBoundary(entry, tabSchema) === undefined || isReadableTab(entry);
}

/** A value without hidden fields, with each tab's state cut to what it shows, and other kinds of tab left out of every `panels` list. */
function readable(value: JsonValue): JsonValue {
  return decodeBoundary(JSON.parse(JSON.stringify(value, (key, field: JsonValue) => {
    if (HIDDEN_FIELDS.has(key)) return undefined;
    if (key === 'panels' && Array.isArray(field)) return field.filter(staysInTabList);
    if (key !== 'customState') return field;
    const state = decodeOptionalBoundary(field, boundary.jsonObject);
    return state && Object.fromEntries(Object.entries(state).filter(([name]) => TAB_STATE_FIELDS.has(name)));
  })), boundary.json);
}

/** A chat without what waits on its owner: approvals, questions and prompts not sent yet. */
function readableChat(view: JsonValue | undefined): JsonValue {
  const chat = decodeOptionalBoundary(view, boundary.jsonObject);
  return chat ? { ...chat, permissions: [], questions: [], queue: [] } : null;
}

const listAnswerSchema = boundary.object({ data: boundary.array(boundary.json) });

/** A read command's answer as a read-only device gets it. */
export function readableResult(channel: string, result: JsonValue): JsonValue {
  if (channel === 'chat-tab:get') return readableChat(result);
  if (channel === 'panels:getActive') return isReadableTab(result) ? readable(result) : null;
  if (channel === 'panels:list') {
    const answer = decodeOptionalBoundary(result, boundary.jsonObject);
    const list = decodeOptionalBoundary(result, listAnswerSchema);
    return answer && list ? { ...answer, data: list.data.filter(isReadableTab).map(readable) } : result;
  }
  return readable(result);
}

/** An event's arguments as a read-only stream carries them, or null when it carries none of it. */
export function readableEvent(channel: string, args: JsonValue[]): JsonValue[] | null {
  switch (channel) {
    case 'terminal:output':
      return args;
    case 'chat-tab:view':
    case 'chat-tab:state':
      return [readableChat(args[0])];
    case 'panel:created':
    case 'panel:updated':
      return isReadableTab(args[0]) ? args.map(readable) : null;
    case 'panel:event':
      return decodeOptionalBoundary(args[0], tabSchema)?.type.startsWith('terminal:') ? args : null;
    default:
      return args.map(readable);
  }
}
