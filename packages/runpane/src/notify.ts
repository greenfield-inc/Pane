import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon, PaneDaemonClientError } from './daemonClient';
import { RunpaneError } from './errors';

// The CLI's copy of the request and result in shared/types/notify.ts, which this package cannot import.
type NotifyUi = 'options' | 'approve' | 'ask' | 'info';
/** `runpane secrets request` sends ui secret; `runpane notify --ui` never takes it. */
type NotifyRequestUi = NotifyUi | 'secret';

interface NotifyChoice {
  label: string;
  detail?: string;
  recommended?: boolean;
  /** `--update` only: the label it had before it was reworded. */
  was?: string;
}

interface NotifySubQuestion {
  title: string;
  choices: NotifyChoice[];
  /** Why this question matters, shown under it. */
  why?: string;
}

interface NotifyAction {
  label: string;
  url: string;
}

interface NotifyCaller { paneId?: string; panelId?: string; cwd?: string; agent?: string }

type NotifyLink = { label: string; path: string } | { label: string; url: string } | { label: string; approval: string };

export interface NotifyQuestion {
  ui: NotifyUi;
  title: string;
  context?: string;
  choices?: NotifyChoice[];
  questions?: NotifySubQuestion[];
  detail?: string;
  detailLabel?: string;
  suggestions?: string[];
  action?: NotifyAction;
  links?: NotifyLink[];
}

/** The question flags as given; JSON ones are text until checked. */
export interface NotifyQuestionFlags {
  ui?: string;
  title?: string;
  context?: string;
  choices?: string;
  questions?: string;
  detail?: string;
  detailLabel?: string;
  suggestions?: string;
  action?: string;
  links?: string;
}

export interface NotifyRequest extends Partial<Omit<NotifyQuestion, 'ui'>> {
  ui?: NotifyRequestUi;
  /** `runpane secrets request` only: the Pane secret the answer is saved as. */
  secret?: { project: string; name: string };
  resume?: string;
  /** `--took`: the approval whose reply the reader took, and how. */
  took?: string;
  tookAs?: NotifyTookAs;
  status?: string;
  /** `--update`: the approval to save a new version of, the person's question, and what changed. */
  update?: string;
  asked?: string;
  whatChanged?: string;
  relays?: string;
  aboutSession?: string;
  returnAfterMs?: number;
  caller: NotifyCaller;
}

type NotifyTookAs = 'answer' | 'question';

/** Any result may carry the card check's warnings: the card was posted anyway. */
export type NotifyResult = NotifyResultBody & { warnings?: string[] };

type NotifyResultBody =
  | { answer: string; note?: string; answers?: string[] }
  /** The person typed a reply: an answer or a question. Say which with `--took`. */
  | { reply: string; picks?: string[]; id: string; replyId: string; next: string }
  | { took: NotifyTookAs; id: string; next?: string }
  | { approved: boolean; note?: string }
  | { delivered: 'screen' | 'inbox' }
  | { status: 'saved'; project: string; name: string }
  | { status: 'declined' }
  | { waiting: true; id: string; next: string }
  | { unavailable: string; next: string };

const UIS: readonly NotifyUi[] = ['options', 'approve', 'ask', 'info'];
const MAX_CHOICES = 9;
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 4;
const TOOK_AS: readonly NotifyTookAs[] = ['answer', 'question'];
const MAX_DETAIL_LABEL = 40;
const MAX_LINKS = 6;
const MAX_LINK_LABEL = 80;
const LINK_URL = /^https?:\/\/\S+$/;
/** Each optional field and the one ui it belongs to. */
const FIELD_UI = [['choices', 'options'], ['questions', 'options'], ['detail', 'approve'], ['detailLabel', 'approve'], ['suggestions', 'ask'], ['action', 'info']] as const;
const CHOICES_EXPECTED = 'choices must be a JSON array of choices, such as [{"label":"Ship it","recommended":true},{"label":"Wait"}].';
const SUGGESTIONS_EXPECTED = 'suggestions must be a JSON array of strings, such as ["main","release"].';
const ACTION_EXPECTED = 'action must be a JSON object with a non-empty "label" and "url", such as {"label":"Open PR","url":"https://github.com/org/repo/pull/1"}.';
const QUESTIONS_EXPECTED = 'questions must be a JSON array of 2 to 4 questions, such as [{"title":"Release notes","choices":[{"label":"Ship"},{"label":"Hold"}]},{"title":"Intel build","choices":[{"label":"Include"},{"label":"Skip"}]}].';
const LINKS_EXPECTED = 'links must be a JSON array of links, such as [{"label":"Notes","path":"docs/RELEASE.md"},{"label":"PR #1","url":"https://github.com/org/repo/pull/1"},{"label":"Q-19","approval":"Q-19"}].';
/** The question fields `--update` may change; the approval keeps its ui and the rest. */
const UPDATE_FIELDS = new Set(['title', 'context', 'choices', 'questions', 'links']);
const NOTIFY_UNAVAILABLE_NEXT = 'Ask in the terminal instead.';

const choiceSchema = boundary.object({
  label: boundary.nonEmptyString,
  detail: boundary.optional(boundary.string),
  recommended: boundary.optional(boundary.boolean),
  was: boundary.optional(boundary.nonEmptyString),
});
const subQuestionSchema = boundary.object({ title: boundary.nonEmptyString, choices: boundary.json, why: boundary.optional(boundary.string) });
const actionSchema = boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString });
const linkSchema = boundary.object({
  label: boundary.nonEmptyString,
  path: boundary.optional(boundary.string),
  url: boundary.optional(boundary.string),
  approval: boundary.optional(boundary.string),
});
const note = boundary.optional(boundary.string);
const notifyResultBodySchema: BoundarySchema<NotifyResultBody> = boundary.union(
  boundary.object({ waiting: boundary.literal(true), id: boundary.nonEmptyString, next: boundary.string }),
  boundary.object({ unavailable: boundary.string, next: boundary.string }),
  boundary.object({ took: boundary.enumeration('answer', 'question'), id: boundary.nonEmptyString, next: boundary.optional(boundary.string) }),
  boundary.object({ reply: boundary.string, picks: boundary.optional(boundary.array(boundary.string)), id: boundary.nonEmptyString, replyId: boundary.nonEmptyString, next: boundary.string }),
  boundary.object({ approved: boundary.boolean, note }),
  boundary.object({ answer: boundary.string, note, answers: boundary.optional(boundary.array(boundary.string)) }),
  boundary.object({ delivered: boundary.enumeration('screen', 'inbox') }),
  boundary.object({ status: boundary.literal('saved'), project: boundary.string, name: boundary.string }),
  boundary.object({ status: boundary.literal('declined') }),
);
const warningsSchema = boundary.object({ warnings: boundary.optional(boundary.array(boundary.string)) });
export const notifyResultSchema: BoundarySchema<NotifyResult> = {
  decode(current) {
    const body = notifyResultBodySchema.decode(current);
    const { warnings } = warningsSchema.decode(current);
    return warnings?.length ? { ...body, warnings } : body;
  },
};

function invalid(field: string, problem: string, next = `Fix ${field} and call notify again.`): RunpaneError {
  return new RunpaneError('ERR_NOTIFY_INVALID', `${problem} Nothing was shown to the person.`, next);
}

/**
 * Checks the question and builds the `runpane:notify` request. The caller comes from the Pane
 * terminal's environment; `runpane mcp` adds the client's name and, for clients whose tool calls
 * time out, how soon to return `waiting`.
 */
function buildNotifyRequest(parsed: ParsedArgs, env: NodeJS.ProcessEnv, cwd: string): NotifyRequest {
  const given: NotifyQuestionFlags = {
    ui: parsed.notifyUi,
    title: parsed.title,
    context: parsed.notifyContext,
    choices: parsed.notifyChoices,
    questions: parsed.notifyQuestions,
    detail: parsed.notifyDetail,
    detailLabel: parsed.notifyDetailLabel,
    suggestions: parsed.notifySuggestions,
    action: parsed.notifyAction,
    links: parsed.notifyLinks,
  };
  const others: NotifyOtherFlags = {
    relays: parsed.notifyRelays,
    aboutSession: parsed.notifyAboutSession,
    took: parsed.notifyTook,
    tookAs: parsed.notifyTookAs,
    status: parsed.notifyStatus,
    update: parsed.notifyUpdate,
    asked: parsed.notifyAsked,
    whatChanged: parsed.notifyWhatChanged,
  };
  const { caller, timing } = notifyCallerFields(env, cwd);

  if (parsed.resume !== undefined) {
    if (!parsed.resume.trim()) throw invalid('resume', 'resume must be the id from a waiting result.');
    const extra = givenFields({ ...given, ...others });
    if (extra.length > 0) {
      throw invalid('resume', `resume keeps waiting on an earlier question, so it takes no other fields; remove ${extra.join(', ')}.`, 'Call notify again with only resume.');
    }
    return { resume: parsed.resume, ...timing, caller };
  }
  if (others.took !== undefined || others.tookAs !== undefined) return buildTookRequest(given, others, caller);
  if (others.status !== undefined) throw invalid('status', 'status goes with --took <id|Q-n> question.');
  if (others.update !== undefined) return { ...buildUpdateRequest(others.update, given, others), ...timing, caller };
  for (const field of ['asked', 'whatChanged'] as const) {
    if (others[field] !== undefined) throw invalid(field, `${field} goes with --update <id|Q-n>, which saves a new version of an approval.`);
  }

  const request: NotifyRequest = { ...parseNotifyQuestion(given), ...timing, caller };
  if (others.relays !== undefined) {
    if (!others.relays.trim()) throw invalid('relays', 'relays must be the id of a waiting item from runpane inbox.');
    request.relays = others.relays;
  }
  if (others.aboutSession !== undefined) {
    if (!others.aboutSession.trim()) throw invalid('aboutSession', 'aboutSession must be a Session id or name.');
    request.aboutSession = others.aboutSession;
  }
  return request;
}

/** The notify flags besides the question's own fields, as given. */
interface NotifyOtherFlags {
  relays?: string;
  aboutSession?: string;
  took?: string;
  tookAs?: string;
  status?: string;
  update?: string;
  asked?: string;
  whatChanged?: string;
}

/** The fields given, in order, leaving out those `keep` accepts. */
function givenFields(fields: NotifyQuestionFlags & NotifyOtherFlags, keep: (field: string) => boolean = () => false): string[] {
  return Object.entries(fields).filter(([field, value]) => value !== undefined && !keep(field)).map(([field]) => field);
}

/** `--took <id|Q-n> answer|question`: how the reader took the person's reply. It asks nothing new. */
function buildTookRequest(given: NotifyQuestionFlags, others: NotifyOtherFlags, caller: NotifyCaller): NotifyRequest {
  if (others.took === undefined) throw invalid('tookAs', 'tookAs goes with took: --took <id|Q-n> answer|question.');
  if (!others.took.trim()) throw invalid('took', "took must be the approval's id or Q-n, such as --took Q-20 answer.");
  if (others.tookAs === undefined) throw invalid('took', 'took needs answer or question after the id: answer if the reply answers the question, question if it asks one.');
  const tookAs = TOOK_AS.find((candidate) => candidate === others.tookAs);
  if (!tookAs) throw invalid('took', `took takes answer or question after the id; got "${others.tookAs}".`);
  const extra = givenFields({ ...given, ...others }, (field) => field === 'took' || field === 'tookAs' || field === 'status');
  if (extra.length > 0) throw invalid('took', `took records how a reply was taken, so it takes no other fields; remove ${extra.join(', ')}.`);
  const request: NotifyRequest = { took: others.took, tookAs, caller };
  if (others.status !== undefined) {
    if (tookAs !== 'question') throw invalid('status', 'status says what you are doing about a question, so it goes with --took <id> question.');
    if (!others.status.trim()) throw invalid('status', 'status must be non-empty text, such as "Checking the logs".');
    request.status = others.status;
  }
  return request;
}

/** `--update`: a new version of an approval. Only the fields given change; it keeps its ui. */
function buildUpdateRequest(update: string, given: NotifyQuestionFlags, others: NotifyOtherFlags): Omit<NotifyRequest, 'caller'> {
  if (!update.trim()) throw invalid('update', "update must be the approval's id or Q-n, such as --update Q-20.");
  const extra = givenFields({ ...given, ...others }, (field) => UPDATE_FIELDS.has(field) || field === 'update' || field === 'asked' || field === 'whatChanged');
  if (extra.length > 0) throw invalid('update', `update changes only title, context, choices, questions and links, and keeps the approval's ui; remove ${extra.join(', ')}.`);
  if (!others.asked?.trim()) throw invalid('asked', "asked is required with update: the person's question, as they typed it.");
  if (!others.whatChanged?.trim()) throw invalid('whatChanged', 'whatChanged is required with update: one line per change, such as "Added: it can be undone from Settings".');
  if (given.title !== undefined && !given.title.trim()) throw invalid('title', 'title must be non-empty text; leave it out to keep the current one.');
  if (given.choices !== undefined && given.questions !== undefined) throw invalid('questions', 'questions asks several questions in place of choices; give choices or questions, not both.');
  const request: Omit<NotifyRequest, 'caller'> = { update, asked: others.asked, whatChanged: others.whatChanged };
  if (given.title !== undefined) request.title = given.title;
  if (given.context !== undefined) request.context = given.context;
  if (given.choices !== undefined) request.choices = parseChoices(parseJson(given.choices), 'choices', 'choices', true);
  if (given.questions !== undefined) request.questions = parseQuestions(given.questions, true);
  if (given.links !== undefined) request.links = parseLinks(given.links);
  return request;
}

/** Checks a question's fields, for notify and for Autopilot's rewrite of an item. */
export function parseNotifyQuestion(given: NotifyQuestionFlags): NotifyQuestion {
  const ui = UIS.find((candidate) => candidate === given.ui);
  if (given.ui === undefined) throw invalid('ui', 'ui is required: options, approve, ask, or info.');
  if (!ui) throw invalid('ui', `ui must be options, approve, ask, or info; got "${given.ui}".`);
  if (!given.title?.trim()) throw invalid('title', 'title is required: one line saying what you need.');
  for (const [field, owner] of FIELD_UI) {
    if (given[field] !== undefined && ui !== owner) throw invalid(field, `${field} is only for ui ${owner}; this call is ui ${ui}.`);
  }
  if (ui === 'options' && given.choices !== undefined && given.questions !== undefined) {
    throw invalid('questions', 'questions asks several questions in place of choices; give choices or questions, not both.');
  }
  if (ui === 'options' && given.choices === undefined && given.questions === undefined) {
    throw invalid('choices', 'choices is required with ui options: 1 to 9 choices, such as [{"label":"Ship it"},{"label":"Wait"}].');
  }
  if (given.detailLabel !== undefined) {
    if (given.detail === undefined) throw invalid('detailLabel', 'detailLabel names the disclosure that reveals detail, so it needs detail too.');
    // Counts characters as Python does, so both wrappers accept the same labels.
    const length = [...given.detailLabel].length;
    if (length > MAX_DETAIL_LABEL) throw invalid('detailLabel', `detailLabel takes up to ${MAX_DETAIL_LABEL} characters; got ${length}.`);
  }

  const question: NotifyQuestion = { ui, title: given.title };
  if (given.context !== undefined) question.context = given.context;
  if (given.choices !== undefined) question.choices = parseChoices(parseJson(given.choices), 'choices', 'choices', false);
  if (given.questions !== undefined) question.questions = parseQuestions(given.questions, false);
  if (given.detail !== undefined) question.detail = given.detail;
  if (given.detailLabel !== undefined) question.detailLabel = given.detailLabel;
  if (given.suggestions !== undefined) question.suggestions = parseSuggestions(given.suggestions);
  if (given.action !== undefined) question.action = decodeOr(parseJson(given.action), actionSchema, invalid('action', ACTION_EXPECTED));
  if (given.links !== undefined) question.links = parseLinks(given.links);
  return question;
}

/**
 * Who is asking, from the Pane terminal's environment, and for MCP clients whose tool calls time
 * out, how soon to return `waiting`. Shared with `runpane secrets request`.
 */
interface NotifyCallerFields {
  caller: NotifyCaller;
  timing: Pick<NotifyRequest, 'returnAfterMs'>;
}

export function notifyCallerFields(env: NodeJS.ProcessEnv, cwd: string): NotifyCallerFields {
  const caller = {
    paneId: nonEmpty(env.PANE_SESSION_ID),
    panelId: nonEmpty(env.PANE_PANEL_ID),
    cwd,
    agent: nonEmpty(env.RUNPANE_NOTIFY_AGENT),
  };
  const returnAfter = env.RUNPANE_NOTIFY_RETURN_AFTER_MS?.trim() ?? '';
  const timing = /^\d+$/.test(returnAfter) && Number(returnAfter) > 0 ? { returnAfterMs: Number(returnAfter) } : {};
  return { caller, timing };
}

/** Related files, pages and approvals for any ui: a label and exactly one of a path, an http(s) url, or an approval. */
function parseLinks(text: string): NotifyLink[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw invalid('links', LINKS_EXPECTED);
  if (value.length > MAX_LINKS) throw invalid('links', `links takes up to ${MAX_LINKS} links; got ${value.length}.`);
  return value.map((item, index): NotifyLink => {
    const link = decodeOr(item, linkSchema, invalid('links', `links[${index}] must be an object with a non-empty "label" and one of "path", "url" or "approval".`));
    // Counts characters as Python does, so both wrappers accept the same labels.
    const length = [...link.label].length;
    if (length > MAX_LINK_LABEL) throw invalid('links', `links[${index}] label takes up to ${MAX_LINK_LABEL} characters; got ${length}.`);
    const targets = [link.path, link.url, link.approval].filter((target) => target !== undefined).length;
    if (targets > 1) throw invalid('links', `links[${index}] has more than one of "path", "url" and "approval"; give one.`);
    if (link.path !== undefined) {
      if (!link.path.trim()) throw invalid('links', `links[${index}] path must be non-empty text.`);
      return { label: link.label, path: link.path };
    }
    if (link.approval !== undefined) {
      if (!link.approval.trim()) throw invalid('links', `links[${index}] approval must be another approval's id or Q-n.`);
      return { label: link.label, approval: link.approval };
    }
    if (link.url === undefined) throw invalid('links', `links[${index}] needs one of "path" (a file), "url" (a web page) or "approval" (another approval's id or Q-n).`);
    if (!LINK_URL.test(link.url)) throw invalid('links', `links[${index}] url must start with http:// or https://.`);
    return { label: link.label, url: link.url };
  });
}

/**
 * 1 to 9 choices with distinct labels. `where` names them in messages (`questions[0].choices`);
 * `was`, a reworded choice's old label, is only for `--update`.
 */
function parseChoices(value: JsonValue | undefined, field: 'choices' | 'questions', where: string, allowWas: boolean): NotifyChoice[] {
  if (!Array.isArray(value)) throw invalid(field, field === 'choices' ? CHOICES_EXPECTED : `${where} must be a JSON array of 1 to ${MAX_CHOICES} choices.`);
  if (value.length < 1 || value.length > MAX_CHOICES) throw invalid(field, `${where} takes 1 to ${MAX_CHOICES} choices; got ${value.length}.`);
  const labels = new Set<string>();
  return value.map((item, index) => {
    const choice = decodeOr(item, choiceSchema, invalid(field, `${where}[${index}] must be an object with a non-empty "label", and optionally "detail" (text) and "recommended" (true or false).`));
    if (choice.was !== undefined && !allowWas) throw invalid(field, `${where}[${index}] has "was", the old label of a reworded choice, which only --update takes.`);
    if (labels.has(choice.label)) throw invalid(field, `${where}[${index}] repeats the label "${choice.label}"; each choice needs its own label.`);
    labels.add(choice.label);
    return choice;
  });
}

/** ui options, instead of choices: 2 to 4 questions, each with its own choices and one pick. */
function parseQuestions(text: string, allowWas: boolean): NotifySubQuestion[] {
  const value = parseJson(text);
  if (!Array.isArray(value)) throw invalid('questions', QUESTIONS_EXPECTED);
  if (value.length < MIN_QUESTIONS || value.length > MAX_QUESTIONS) {
    throw invalid('questions', `questions takes ${MIN_QUESTIONS} to ${MAX_QUESTIONS} questions; got ${value.length}. For one question, use choices.`);
  }
  return value.map((item, index) => {
    const question = decodeOr(item, subQuestionSchema, invalid('questions', `questions[${index}] must be an object with a non-empty "title" and "choices", a JSON array of 1 to ${MAX_CHOICES} choices.`));
    const parsedQuestion: NotifySubQuestion = { title: question.title, choices: parseChoices(question.choices, 'questions', `questions[${index}].choices`, allowWas) };
    if (question.why?.trim()) parsedQuestion.why = question.why;
    return parsedQuestion;
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

/** One line for people: the answer or reply, Approved or Denied, where an update went, or what to do next. */
export function describeNotifyResult(result: NotifyResult): string {
  // The card check's warnings follow, one line each: the card was posted anyway.
  return [describeNotifyOutcome(result), ...(result.warnings ?? []).map(warning => `Warning: ${warning}`)].join('\n');
}

function describeNotifyOutcome(result: NotifyResult): string {
  const withNote = (text: string, noteText: string | undefined) => (noteText ? `${text}. Note: ${noteText}` : text);
  if ('waiting' in result) return `Still waiting (id ${result.id}). ${result.next}`;
  if ('reply' in result) {
    // Picks keep their question's place: one left unpicked reads "—".
    const picks = result.picks ?? [];
    const picked = picks.some(Boolean) ? ` (picked: ${picks.map(pick => pick || '—').join(' · ')})` : '';
    return `Reply ${result.replyId} on ${result.id}: "${result.reply}"${picked}. ${result.next}`;
  }
  if ('took' in result) return `Taken as ${result.took === 'answer' ? 'the answer' : 'a question'} (id ${result.id}).${result.next ? ` ${result.next}` : ''}`;
  if ('unavailable' in result) return `Unavailable: ${result.unavailable} ${result.next}`;
  if ('approved' in result) return withNote(result.approved ? 'Approved' : 'Denied', result.note);
  if ('answer' in result) return withNote(`Answer: ${result.answer}`, result.note);
  if ('status' in result) return result.status === 'saved' ? `Saved as ${result.project}/${result.name}` : 'Declined';
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
    // An older Pane has no notify channel.
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
