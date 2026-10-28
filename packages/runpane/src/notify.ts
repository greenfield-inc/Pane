import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon, PaneDaemonClientError } from './daemonClient';
import { RunpaneError } from './errors';

// The CLI's copy of the request and result in shared/types/notify.ts, which this package cannot import.
type NotifyUi = 'options' | 'approve' | 'ask' | 'info';

interface NotifyChoice {
  label: string;
  detail?: string;
  recommended?: boolean;
}

interface NotifyAction {
  label: string;
  url: string;
}

interface NotifyRequest {
  ui?: NotifyUi;
  title?: string;
  context?: string;
  choices?: NotifyChoice[];
  detail?: string;
  detailLabel?: string;
  suggestions?: string[];
  action?: NotifyAction;
  resume?: string;
  returnAfterMs?: number;
  caller: { paneId?: string; panelId?: string; cwd?: string; agent?: string };
}

type NotifyResult =
  | { answer: string; note?: string }
  | { approved: boolean; note?: string }
  | { delivered: 'screen' | 'inbox' }
  | { waiting: true; id: string; next: string }
  | { unavailable: string; next: string };

const UIS: readonly NotifyUi[] = ['options', 'approve', 'ask', 'info'];
const MAX_CHOICES = 9;
const MAX_DETAIL_LABEL = 40;
/** Each optional field and the one ui it belongs to. */
const FIELD_UI = [['choices', 'options'], ['detail', 'approve'], ['detailLabel', 'approve'], ['suggestions', 'ask'], ['action', 'info']] as const;
const CHOICES_EXPECTED = 'choices must be a JSON array of choices, such as [{"label":"Ship it","recommended":true},{"label":"Wait"}].';
const SUGGESTIONS_EXPECTED = 'suggestions must be a JSON array of strings, such as ["main","release"].';
const ACTION_EXPECTED = 'action must be a JSON object with a non-empty "label" and "url", such as {"label":"Open PR","url":"https://github.com/org/repo/pull/1"}.';
const NOTIFY_UNAVAILABLE_NEXT = 'Ask in the terminal instead.';

const choiceSchema = boundary.object({
  label: boundary.nonEmptyString,
  detail: boundary.optional(boundary.string),
  recommended: boundary.optional(boundary.boolean),
});
const actionSchema = boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString });
const note = boundary.optional(boundary.string);
const notifyResultSchema: BoundarySchema<NotifyResult> = boundary.union(
  boundary.object({ waiting: boundary.literal(true), id: boundary.nonEmptyString, next: boundary.string }),
  boundary.object({ unavailable: boundary.string, next: boundary.string }),
  boundary.object({ approved: boundary.boolean, note }),
  boundary.object({ answer: boundary.string, note }),
  boundary.object({ delivered: boundary.enumeration('screen', 'inbox') }),
);

function invalid(field: string, problem: string, next = `Fix ${field} and call notify again.`): RunpaneError {
  return new RunpaneError('ERR_NOTIFY_INVALID', `${problem} Nothing was shown to the person.`, next);
}

/**
 * Checks the question and builds the `runpane:notify` request. The caller comes from the Pane
 * terminal's environment; `runpane mcp` adds the client's name and, for clients whose tool calls
 * time out, how soon to return `waiting`.
 */
function buildNotifyRequest(parsed: ParsedArgs, env: NodeJS.ProcessEnv, cwd: string): NotifyRequest {
  const given = {
    ui: parsed.notifyUi,
    title: parsed.title,
    context: parsed.notifyContext,
    choices: parsed.notifyChoices,
    detail: parsed.notifyDetail,
    detailLabel: parsed.notifyDetailLabel,
    suggestions: parsed.notifySuggestions,
    action: parsed.notifyAction,
  };
  const caller = {
    paneId: nonEmpty(env.PANE_SESSION_ID),
    panelId: nonEmpty(env.PANE_PANEL_ID),
    cwd,
    agent: nonEmpty(env.RUNPANE_NOTIFY_AGENT),
  };
  const returnAfter = env.RUNPANE_NOTIFY_RETURN_AFTER_MS?.trim() ?? '';
  const timing = /^\d+$/.test(returnAfter) && Number(returnAfter) > 0 ? { returnAfterMs: Number(returnAfter) } : {};

  if (parsed.resume !== undefined) {
    if (!parsed.resume.trim()) throw invalid('resume', 'resume must be the id from a waiting result.');
    const extra = Object.entries(given).filter(([, value]) => value !== undefined).map(([field]) => field);
    if (extra.length > 0) {
      throw invalid('resume', `resume keeps waiting on an earlier question, so it takes no other fields; remove ${extra.join(', ')}.`, 'Call notify again with only resume.');
    }
    return { resume: parsed.resume, ...timing, caller };
  }

  const ui = UIS.find((candidate) => candidate === given.ui);
  if (given.ui === undefined) throw invalid('ui', 'ui is required: options, approve, ask, or info.');
  if (!ui) throw invalid('ui', `ui must be options, approve, ask, or info; got "${given.ui}".`);
  if (!given.title?.trim()) throw invalid('title', 'title is required: one line saying what you need.');
  for (const [field, owner] of FIELD_UI) {
    if (given[field] !== undefined && ui !== owner) throw invalid(field, `${field} is only for ui ${owner}; this call is ui ${ui}.`);
  }
  if (ui === 'options' && given.choices === undefined) {
    throw invalid('choices', 'choices is required with ui options: 1 to 9 choices, such as [{"label":"Ship it"},{"label":"Wait"}].');
  }
  if (given.detailLabel !== undefined) {
    if (given.detail === undefined) throw invalid('detailLabel', 'detailLabel names the disclosure that reveals detail, so it needs detail too.');
    // Counts characters as Python does, so both wrappers accept the same labels.
    const length = [...given.detailLabel].length;
    if (length > MAX_DETAIL_LABEL) throw invalid('detailLabel', `detailLabel takes up to ${MAX_DETAIL_LABEL} characters; got ${length}.`);
  }

  const request: NotifyRequest = { ui, title: given.title, ...timing, caller };
  if (given.context !== undefined) request.context = given.context;
  if (given.choices !== undefined) request.choices = parseChoices(given.choices);
  if (given.detail !== undefined) request.detail = given.detail;
  if (given.detailLabel !== undefined) request.detailLabel = given.detailLabel;
  if (given.suggestions !== undefined) request.suggestions = parseSuggestions(given.suggestions);
  if (given.action !== undefined) request.action = decodeOr(parseJson(given.action), actionSchema, invalid('action', ACTION_EXPECTED));
  return request;
}

function parseChoices(text: string): NotifyChoice[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw invalid('choices', CHOICES_EXPECTED);
  if (value.length < 1 || value.length > MAX_CHOICES) throw invalid('choices', `choices takes 1 to ${MAX_CHOICES} choices; got ${value.length}.`);
  const labels = new Set<string>();
  return value.map((item, index) => {
    const choice = decodeOr(item, choiceSchema, invalid('choices', `choices[${index}] must be an object with a non-empty "label", and optionally "detail" (text) and "recommended" (true or false).`));
    if (labels.has(choice.label)) throw invalid('choices', `choices[${index}] repeats the label "${choice.label}"; each choice needs its own label.`);
    labels.add(choice.label);
    return choice;
  });
}

function parseSuggestions(text: string): string[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw invalid('suggestions', SUGGESTIONS_EXPECTED);
  return value.map((item, index) => decodeOr(item, boundary.nonEmptyString, invalid('suggestions', `suggestions[${index}] must be non-empty text.`)));
}

/** Malformed JSON reads as `undefined`, which every shape check then rejects with its own message. */
function parseJson(text: string): JsonValue | undefined {
  try {
    return decodeBoundary(JSON.parse(text), boundary.json);
  } catch {
    return undefined;
  }
}

function decodeOr<T>(value: JsonValue | undefined, schema: BoundarySchema<T>, failure: RunpaneError): T {
  try {
    return decodeBoundary(value, schema);
  } catch {
    throw failure;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

/** One line for people: the answer, Approved or Denied, where an update went, or what to do next. */
function describeNotifyResult(result: NotifyResult): string {
  const withNote = (text: string, noteText: string | undefined) => (noteText ? `${text}. Note: ${noteText}` : text);
  if ('waiting' in result) return `Still waiting (id ${result.id}). ${result.next}`;
  if ('unavailable' in result) return `Unavailable: ${result.unavailable} ${result.next}`;
  if ('approved' in result) return withNote(result.approved ? 'Approved' : 'Denied', result.note);
  if ('answer' in result) return withNote(`Answer: ${result.answer}`, result.note);
  return result.delivered === 'screen' ? 'Shown on screen.' : 'Added to the Notify inbox.';
}

/**
 * `runpane notify`: shows the question and waits, with no time limit, for the answer. When Pane is
 * not running there is nobody to ask, so it prints `unavailable` (exit 0) and the agent asks in
 * its terminal.
 */
export async function runNotify(parsed: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const request = buildNotifyRequest(parsed, env, process.cwd());
  let result: NotifyResult;
  try {
    result = await invokeDaemon('runpane:notify', [request], notifyResultSchema, { paneDir: parsed.paneDir, timeoutMs: Infinity });
  } catch (error) {
    if (!(error instanceof PaneDaemonClientError)) throw error;
    // An older Pane, or the headless daemon, has no notify channel.
    if (error.connectionFailure) {
      result = { unavailable: 'Pane is not running.', next: NOTIFY_UNAVAILABLE_NEXT };
    } else if (error.code === 'ERR_UNKNOWN_CHANNEL') {
      result = { unavailable: 'This Pane doesn\'t support notify yet.', next: NOTIFY_UNAVAILABLE_NEXT };
    } else {
      throw error;
    }
  }
  console.log(parsed.json ? JSON.stringify(result, null, 2) : describeNotifyResult(result));
  return 0;
}
