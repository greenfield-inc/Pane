import path from 'node:path';
import { boundary, type BoundarySchema } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon, PaneDaemonClientError } from './daemonClient';
import { RunpaneError } from './errors';
import { parseNotifyQuestion, type NotifyQuestion } from './notify';

// The CLI's copy of the shapes in shared/types/autopilot.ts, which this package cannot import.

type AutopilotTab =
  | { kind: 'item'; label: string; notifyId: string }
  | { kind: 'file'; label: string; path: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'session'; label: string; sessionId: string };

type AutopilotStackRef =
  | { kind: 'item'; notifyId: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'session'; sessionId: string };

interface AutopilotStackEntry {
  id: string;
  ref: AutopilotStackRef;
  title: string;
  sessionId?: string;
  sessionName?: string;
  tabs: AutopilotTab[];
  note?: string;
  addedAt: number;
  byAutopilot?: boolean;
  doneAt?: number;
}

interface AutopilotStack {
  entries: AutopilotStackEntry[];
  shownId: string | null;
}

interface AutopilotStatusResult extends AutopilotStack {
  ok: true;
}

interface AutopilotSnapshotResult {
  ok: true;
  enabled: boolean;
  chatTabsEnabled: boolean;
  entitlement: { entitled: boolean; reason?: string; next?: string };
  run: { id: string; folder: string; docsFolder: string; createdAt: string } | null;
  panelId: string | null;
  ownerPaneId: string | null;
  state: 'stopped' | 'running' | 'paused';
  /** Sentinel Mode: Autopilot keeps Sessions moving while the person is away. */
  sentinel: boolean;
  sentinelSince?: number;
  stack: AutopilotStack;
  walk: { sessionId?: string; sessions: Array<{ id: string; name: string; waiting: number }> };
}

type AutopilotConnected = { kind: 'session' | 'pane' | 'autopilot' | 'machine'; id: string; name: string; paneId?: string };

interface AutopilotWaitingItem {
  id: string;
  title: string;
  kind: 'approval' | 'question' | 'permission';
  sessionId?: string;
  sessionName?: string;
  agent: string;
  pane: string;
  paneId?: string;
  panelId?: string;
  orchestrator?: boolean;
  byAutopilot?: boolean;
  context?: string;
  choices?: string[];
  links: Array<{ label: string; path?: string; url?: string }>;
  createdAt: number;
  ageMs: number;
  machine: string;
  machineId: string;
  onStack: boolean;
  reopened?: { by: string; device?: string; at: number; closedBy: string; closedReason: string };
  quiet?: boolean;
  stale?: boolean;
  connected?: AutopilotConnected;
}

interface AutopilotWaitingResult {
  ok: true;
  items: AutopilotWaitingItem[];
  /** Saved machines it can't reach. Absent from an older Pane. */
  offline?: string[];
  /** The person's Tailscale machines not saved here. Absent from an older Pane. */
  cantSee?: string[];
}

/** What answer, close and rewrite return: the item's id (a rewrite's new one) and the machine that holds it. */
interface AutopilotActionResult {
  ok: true;
  id: string;
  machine?: string;
}

type AutopilotAnswer = { choice: string; note?: string } | { approved: boolean; note?: string } | { text: string };

interface AutopilotAnswerRequest {
  id: string;
  answer: AutopilotAnswer;
  because: string;
}

interface AutopilotCloseRequest {
  id: string;
  reason: string;
}

interface AutopilotRewriteRequest extends NotifyQuestion {
  id: string;
}

interface AutopilotStackPushResult {
  ok: true;
  entry: AutopilotStackEntry | null;
  shown: boolean;
  position: number;
  total: number;
}

interface AutopilotStackPushRequest {
  item?: string;
  file?: string;
  url?: string;
  session?: string;
  title?: string;
  note?: string;
  tabs?: Array<{ label?: string; path?: string; url?: string }>;
  next?: boolean;
}

const tabSchema: BoundarySchema<AutopilotTab> = boundary.union(
  boundary.object({ kind: boundary.literal('item'), label: boundary.string, notifyId: boundary.string }),
  boundary.object({ kind: boundary.literal('file'), label: boundary.string, path: boundary.string }),
  boundary.object({ kind: boundary.literal('url'), label: boundary.string, url: boundary.string }),
  boundary.object({ kind: boundary.literal('session'), label: boundary.string, sessionId: boundary.string }),
);
const refSchema: BoundarySchema<AutopilotStackRef> = boundary.union(
  boundary.object({ kind: boundary.literal('item'), notifyId: boundary.string }),
  boundary.object({ kind: boundary.literal('file'), path: boundary.string }),
  boundary.object({ kind: boundary.literal('url'), url: boundary.string }),
  boundary.object({ kind: boundary.literal('session'), sessionId: boundary.string }),
);
const entrySchema: BoundarySchema<AutopilotStackEntry> = boundary.object({
  id: boundary.string,
  ref: refSchema,
  title: boundary.string,
  sessionId: boundary.optional(boundary.string),
  sessionName: boundary.optional(boundary.string),
  tabs: boundary.array(tabSchema),
  note: boundary.optional(boundary.string),
  addedAt: boundary.number,
  byAutopilot: boundary.optional(boundary.boolean),
  doneAt: boundary.optional(boundary.number),
});
const stackFields = {
  entries: boundary.array(entrySchema),
  shownId: boundary.nullable(boundary.string),
};
const stackSchema: BoundarySchema<AutopilotStack> = boundary.object(stackFields);
const stackResultSchema: BoundarySchema<AutopilotStatusResult> = boundary.object({ ok: boundary.literal(true), ...stackFields });
const snapshotResultSchema: BoundarySchema<AutopilotSnapshotResult> = boundary.object({
  ok: boundary.literal(true),
  enabled: boundary.boolean,
  chatTabsEnabled: boundary.boolean,
  entitlement: boundary.object({
    entitled: boundary.boolean,
    reason: boundary.optional(boundary.string),
    next: boundary.optional(boundary.string),
  }),
  run: boundary.nullable(boundary.object({
    id: boundary.string,
    folder: boundary.string,
    docsFolder: boundary.string,
    createdAt: boundary.string,
  })),
  panelId: boundary.nullable(boundary.string),
  ownerPaneId: boundary.nullable(boundary.string),
  state: boundary.enumeration('stopped', 'running', 'paused'),
  sentinel: boundary.boolean,
  sentinelSince: boundary.optional(boundary.number),
  stack: stackSchema,
  walk: boundary.object({
    sessionId: boundary.optional(boundary.string),
    sessions: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, waiting: boundary.number })),
  }),
});
const waitingItemSchema = boundary.object({
  id: boundary.string,
  title: boundary.string,
  // An older Pane marks a worker's question "stuck"; here it reads as the question it is.
  kind: boundary.enumeration('approval', 'question', 'permission', 'stuck'),
  sessionId: boundary.optional(boundary.string),
  sessionName: boundary.optional(boundary.string),
  agent: boundary.string,
  pane: boundary.string,
  paneId: boundary.optional(boundary.string),
  panelId: boundary.optional(boundary.string),
  orchestrator: boundary.optional(boundary.boolean),
  byAutopilot: boundary.optional(boundary.boolean),
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(boundary.string)),
  links: boundary.array(boundary.object({
    label: boundary.string,
    path: boundary.optional(boundary.string),
    url: boundary.optional(boundary.string),
  })),
  createdAt: boundary.number,
  ageMs: boundary.number,
  machine: boundary.string,
  machineId: boundary.string,
  onStack: boundary.boolean,
  quiet: boundary.optional(boundary.boolean),
  stale: boundary.optional(boundary.boolean),
  reopened: boundary.optional(boundary.object({
    by: boundary.enumeration('you', 'autopilot', 'orchestrator', 'pane'),
    device: boundary.optional(boundary.string),
    at: boundary.number,
    closedBy: boundary.enumeration('you', 'autopilot', 'orchestrator', 'pane'),
    closedReason: boundary.string,
  })),
  connected: boundary.optional(boundary.object({
    kind: boundary.enumeration('session', 'pane', 'autopilot', 'machine'),
    id: boundary.string,
    name: boundary.string,
    paneId: boundary.optional(boundary.string),
  })),
});
const waitingResultSchema = boundary.object({
  ok: boundary.literal(true),
  items: boundary.array(waitingItemSchema),
  offline: boundary.optional(boundary.array(boundary.string)),
  cantSee: boundary.optional(boundary.array(boundary.string)),
});
const actionResultSchema: BoundarySchema<AutopilotActionResult> = boundary.object({
  ok: boundary.literal(true),
  id: boundary.string,
  machine: boundary.optional(boundary.string),
});
const pushResultSchema: BoundarySchema<AutopilotStackPushResult> = boundary.object({
  ok: boundary.literal(true),
  entry: boundary.nullable(entrySchema),
  shown: boundary.boolean,
  position: boundary.number,
  total: boundary.number,
});

const URL_TAB = /^https?:\/\//i;

function printJson(value: AutopilotSnapshotResult | AutopilotWaitingResult | AutopilotStatusResult | AutopilotStackPushResult | AutopilotActionResult): void {
  console.log(JSON.stringify(value, null, 2));
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `45s`, `12m`, `3h`, `2d`: how long an item has waited. */
function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `runpane autopilot status`: the switch, the agent, the run, the stack and the walk. */
export async function runAutopilotStatus(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:autopilot:status', [], snapshotResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    printJson(result);
    return 0;
  }
  console.log(result.enabled ? `Autopilot is on and ${result.state}.` : 'Autopilot is off. Turn it on in Settings > Advanced > Experimental > Autopilot.');
  if (result.enabled && result.sentinel) console.log('Sentinel is on: Autopilot keeps your Sessions moving while you are away.');
  if (!result.entitlement.entitled) {
    const reason = result.entitlement.reason ?? 'This account cannot use Autopilot.';
    console.log(`Not available: ${reason}${result.entitlement.next ? ` Next: ${result.entitlement.next}` : ''}`);
  }
  if (result.enabled && !result.chatTabsEnabled) console.log('Chat tabs are off; Autopilot runs as a chat tab, so it needs them on.');
  if (result.run) console.log(`Run ${result.run.id}: ${result.run.folder}`);
  if (result.panelId) console.log(`Chat tab: panel ${result.panelId}${result.ownerPaneId ? ` in pane ${result.ownerPaneId}` : ''}`);
  const shown = result.stack.entries.find(entry => entry.id === result.stack.shownId);
  console.log(`Stack: ${plural(result.stack.entries.length, 'entry', 'entries')}${shown ? `; showing "${shown.title}"` : ''}.`);
  const walking = result.walk.sessions.find(session => session.id === result.walk.sessionId);
  const waiting = result.walk.sessions.reduce((sum, session) => sum + session.waiting, 0);
  const sessionsWaiting = result.walk.sessions.filter(session => session.waiting > 0).length;
  console.log(`Waiting: ${plural(waiting, 'item', 'items')} in ${plural(sessionsWaiting, 'Session', 'Sessions')}${walking ? `; the walk is on ${walking.name}` : ''}.`);
  return 0;
}

/** `runpane autopilot waiting`: what waits on the person, grouped by Session in the order Pane gives. */
export async function runAutopilotWaiting(parsed: ParsedArgs): Promise<number> {
  const decoded = await invokeDaemon('runpane:autopilot:waiting', [], waitingResultSchema, { paneDir: parsed.paneDir });
  const result: AutopilotWaitingResult = {
    ...decoded,
    items: decoded.items.map(item => ({ ...item, kind: item.kind === 'stuck' ? 'question' : item.kind })),
  };
  if (parsed.json) {
    printJson(result);
    return 0;
  }
  if (result.items.length === 0) console.log('Nothing is waiting on the person.');
  let group: string | undefined;
  for (const item of result.items) {
    const key = item.sessionId ?? '';
    if (key !== group) {
      group = key;
      console.log(item.sessionId ? `${item.sessionName ?? item.sessionId} (${item.sessionId})` : 'Not in a Session');
    }
    const marks = [
      item.machineId === 'local' ? '' : `  on ${item.machine}`,
      item.onStack ? '  on the stack' : '',
      item.stale ? '  stale' : '',
      item.quiet ? '  quiet' : '',
      item.reopened ? '  reopened by you' : '',
    ].join('');
    console.log(`  ${item.id}  ${item.kind}  ${item.title}  ${item.agent} - ${item.pane}  ${formatAge(item.ageMs)}${marks}`);
  }
  for (const machine of result.offline ?? []) console.log(`${machine} offline`);
  for (const machine of result.cantSee ?? []) console.log(`Can't see: ${machine}`);
  return 0;
}

/** `runpane autopilot stack`: the entries in order; `>` marks the one on screen. */
export async function runAutopilotStack(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:autopilot:stack', [], stackResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    printJson(result);
    return 0;
  }
  if (result.entries.length === 0) {
    console.log('The stack is empty.');
    return 0;
  }
  console.log(`Stack: ${plural(result.entries.length, 'entry', 'entries')}.`);
  result.entries.forEach((entry, index) => {
    const shown = entry.id === result.shownId;
    const session = entry.sessionName ? ` - ${entry.sessionName}` : '';
    console.log(`${shown ? '>' : ' '} ${index + 1}. ${entry.id} ${entry.ref.kind}: ${entry.title}${session}${entry.doneAt !== undefined ? ' (done)' : ''}${shown ? ' (shown)' : ''}`);
  });
  return 0;
}

/**
 * Builds the `runpane:autopilot:stack-push` request. Files (the entry's and its tabs') resolve
 * against `cwd`, so Pane gets absolute paths; a tab that starts with http:// or https:// is a URL.
 */
function buildStackPushRequest(parsed: ParsedArgs, cwd: string): AutopilotStackPushRequest {
  const request: AutopilotStackPushRequest = {};
  if (parsed.item !== undefined) request.item = parsed.item;
  if (parsed.file !== undefined) request.file = path.resolve(cwd, parsed.file);
  if (parsed.url !== undefined) request.url = parsed.url;
  if (parsed.sessionId !== undefined) request.session = parsed.sessionId;
  if (parsed.title !== undefined) request.title = parsed.title;
  if (parsed.note !== undefined) request.note = parsed.note;
  if (parsed.stackTabs?.length) {
    request.tabs = parsed.stackTabs.map(tab => (URL_TAB.test(tab) ? { url: tab } : { path: path.resolve(cwd, tab) }));
  }
  if (parsed.stackNext) request.next = true;
  return request;
}

/** `runpane autopilot stack push`: one more entry; it never replaces the one on screen. */
export async function runAutopilotStackPush(parsed: ParsedArgs, cwd: string = process.cwd()): Promise<number> {
  const request = buildStackPushRequest(parsed, cwd);
  const result = await invokeDaemon('runpane:autopilot:stack-push', [request], pushResultSchema, { paneDir: parsed.paneDir });
  if (parsed.json) {
    printJson(result);
    return 0;
  }
  const title = result.entry ? `"${result.entry.title}"` : 'it';
  console.log(result.shown
    ? `On the stack and on screen: ${title} (${result.position} of ${result.total}).`
    : `On the stack: ${title} (${result.position} of ${result.total}); it comes up when the person is done with the one on screen.`);
  return 0;
}

function invalidAction(message: string, next: string): RunpaneError {
  return new RunpaneError('ERR_AUTOPILOT_INVALID', `${message} Nothing was changed.`, next);
}

/** The `<id>` every action takes, from `runpane autopilot waiting`. */
function requireItem(parsed: ParsedArgs, verb: string): string {
  if (!parsed.item?.trim()) throw invalidAction(`runpane autopilot ${verb} needs a waiting item's id.`, 'List what waits with runpane autopilot waiting --json and pass an id from it.');
  return parsed.item;
}

function buildAnswerRequest(parsed: ParsedArgs): AutopilotAnswerRequest {
  const id = requireItem(parsed, 'answer');
  const ways = [parsed.answerChoice !== undefined, parsed.answerApprove === true, parsed.answerDeny === true, parsed.panelInput !== undefined].filter(Boolean).length;
  if (ways !== 1) throw invalidAction('runpane autopilot answer needs exactly one of --choice <label>, --approve, --deny, or --text <text>.', 'Pass one way of answering.');
  if (!parsed.because?.trim()) throw invalidAction('runpane autopilot answer needs --because <why>: a D-n, a document or the person\'s words, recorded on the item.', 'Say why with --because. If you have no reason to give, bring the item to the person instead.');
  const because = parsed.because;
  if (parsed.panelInput !== undefined) {
    if (parsed.note !== undefined) throw invalidAction('--note goes with --choice, --approve or --deny.', 'Put the note in --text.');
    if (!parsed.panelInput.trim()) throw invalidAction('--text must be non-empty.', 'Pass the answer in --text.');
    return { id, answer: { text: parsed.panelInput }, because };
  }
  if (parsed.answerChoice !== undefined) {
    if (!parsed.answerChoice.trim()) throw invalidAction('--choice must be one of the item\'s labels.', 'Read its choices with runpane autopilot waiting --json.');
    const answer: AutopilotAnswer = parsed.note === undefined ? { choice: parsed.answerChoice } : { choice: parsed.answerChoice, note: parsed.note };
    return { id, answer, because };
  }
  const approved = parsed.answerApprove === true;
  const answer: AutopilotAnswer = parsed.note === undefined ? { approved } : { approved, note: parsed.note };
  return { id, answer, because };
}

function buildCloseRequest(parsed: ParsedArgs): AutopilotCloseRequest {
  const id = requireItem(parsed, 'close');
  if (!parsed.reason?.trim()) throw invalidAction('runpane autopilot close needs --reason <why>, recorded on the item and told to its asker.', 'Say why with --reason.');
  return { id, reason: parsed.reason };
}

/** Links' files resolve against `cwd`, so Pane gets absolute paths, as `stack push` does. */
function buildRewriteRequest(parsed: ParsedArgs, cwd: string): AutopilotRewriteRequest {
  const id = requireItem(parsed, 'rewrite');
  if (parsed.notifyDetail !== undefined || parsed.notifyDetailLabel !== undefined || parsed.notifyAction !== undefined) {
    throw invalidAction('runpane autopilot rewrite takes --context, --choices, --suggestions and --links, not --detail, --detail-label or --action.', 'Put what the person needs to read in --context.');
  }
  if (parsed.notifyUi === 'info') throw invalidAction('A rewrite must take an answer, so --ui info doesn\'t fit.', 'Use --ui options, approve, or ask.');
  let question: NotifyQuestion;
  try {
    question = parseNotifyQuestion({
      ui: parsed.notifyUi,
      title: parsed.title,
      context: parsed.notifyContext,
      choices: parsed.notifyChoices,
      suggestions: parsed.notifySuggestions,
      links: parsed.notifyLinks,
    });
  } catch (error) {
    if (!(error instanceof RunpaneError)) throw error;
    throw new RunpaneError('ERR_AUTOPILOT_INVALID', error.message, 'Fix it and run runpane autopilot rewrite again.');
  }
  const request: AutopilotRewriteRequest = { id, ...question };
  if (question.links) request.links = question.links.map(link => ('path' in link ? { ...link, path: path.resolve(cwd, link.path) } : link));
  return request;
}

/** Answer, close and rewrite: an older Pane has no such channel. */
async function act(parsed: ParsedArgs, verb: string, request: { id: string }): Promise<AutopilotActionResult> {
  try {
    return await invokeDaemon(`runpane:autopilot:${verb}`, [request], actionResultSchema, { paneDir: parsed.paneDir });
  } catch (error) {
    if (error instanceof PaneDaemonClientError && error.code === 'ERR_UNKNOWN_CHANNEL') {
      throw new RunpaneError('ERR_AUTOPILOT_PANE_TOO_OLD', `This Pane can't run runpane autopilot ${verb} yet. Nothing was changed.`, 'Update Pane, or bring the item to the person.');
    }
    throw error;
  }
}

const onMachine = (result: AutopilotActionResult) => (result.machine ? ` on ${result.machine}` : '');

/** `runpane autopilot answer`: delivered at once, and recorded "by Autopilot" on the item. */
export async function runAutopilotAnswer(parsed: ParsedArgs): Promise<number> {
  const request = buildAnswerRequest(parsed);
  const result = await act(parsed, 'answer', request);
  if (parsed.json) printJson(result);
  else console.log(`Answered ${result.id}${onMachine(result)}, recorded by Autopilot because ${request.because}. The person can Override it.`);
  return 0;
}

/** `runpane autopilot close`: its asker is told, and the person can reopen it. */
export async function runAutopilotClose(parsed: ParsedArgs): Promise<number> {
  const request = buildCloseRequest(parsed);
  const result = await act(parsed, 'close', request);
  if (parsed.json) printJson(result);
  else console.log(`Closed ${result.id}${onMachine(result)}: ${request.reason}. The person can reopen it.`);
  return 0;
}

/** `runpane autopilot rewrite`: closes the item and re-asks it; the answer goes to the original asker. */
export async function runAutopilotRewrite(parsed: ParsedArgs, cwd: string = process.cwd()): Promise<number> {
  const request = buildRewriteRequest(parsed, cwd);
  const result = await act(parsed, 'rewrite', request);
  if (parsed.json) printJson(result);
  else console.log(`Rewrote ${request.id} as ${result.id}${onMachine(result)}. Its answer goes to the original asker.`);
  return 0;
}
