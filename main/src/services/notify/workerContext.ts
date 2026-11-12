import path from 'path';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { NOTIFY_LINKS_MAX, NOTIFY_QUESTIONS_MAX, type NotifyChoice, type NotifyLink, type NotifySubQuestion } from '../../../../shared/types/notify';
import { admitCard, type AdmittedCard } from './cardAdmit';

/** The longest context a card carries; cards clamp it to a few lines with Show more. */
const MAX_CONTEXT = 2_000;
/** An options card takes 1 to 9 choices. */
const MAX_CHOICES = 9;
/** How Pane's journal marks a summary it cut short. */
const TRUNCATION_MARKER = '[summary truncated]';
const RECOMMENDED = /\s*\((recommended)\)\s*$/iu;

const questionSchema = boundary.object({
  q: boundary.optional(boundary.string),
  why: boundary.optional(boundary.string),
  options: boundary.optional(boundary.array(boundary.string)),
});
const needsYouSchema = boundary.object({
  title: boundary.optional(boundary.string),
  why: boundary.optional(boundary.string),
  questions: boundary.optional(boundary.array(questionSchema)),
  files: boundary.optional(boundary.array(boundary.string)),
});

type NeedsYou = NonNullable<ReturnType<typeof needsYouSchema.decode>>;

/** What a card shows from a status file or a `needs_you` block, in place of its raw JSON. */
export interface StatusCard {
  context?: string;
  choices?: NotifyChoice[];
  /** Several questions, each with its own buttons, when every one has options to press. */
  questions?: NotifySubQuestion[];
  links?: NotifyLink[];
}

function cut(text: string): string {
  if (text.length <= MAX_CONTEXT) return text;
  const head = text.slice(0, MAX_CONTEXT);
  const space = head.lastIndexOf(' ');
  return `${(space > MAX_CONTEXT * 0.8 ? head.slice(0, space) : head).trimEnd()}…`;
}

function parse(text: string): JsonValue | undefined {
  try {
    // SAFETY: JSON.parse yields a JSON value, which the decoders check.
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** The JSON object that starts at `start`, read to its closing brace, or undefined when it was cut short. */
function objectAt(text: string, start: number): JsonValue | undefined {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return parse(text.slice(start, index + 1));
    }
  }
  return undefined;
}

/**
 * The named field's value from JSON that may be cut short (a journal keeps 2,000 characters of a
 * report): an object read to its closing brace, or a string. Undefined when it isn't there whole.
 */
function fieldOf(text: string, key: string): JsonValue | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*(\\{|"(?:[^"\\\\]|\\\\.)*")`, 'u').exec(text);
  if (!match) return undefined;
  return match[1] === '{' ? objectAt(text, match.index + match[0].length - 1) : parse(match[1]);
}

function needsYouOf(json: JsonValue | undefined, text: string): NeedsYou | undefined {
  if (json === undefined) {
    const nested = fieldOf(text, 'needs_you');
    // A bare needs_you block cut short has no whole question to show: it gets a plain line.
    return nested === undefined ? undefined : decodeOptionalBoundary(nested, needsYouSchema) ?? undefined;
  }
  const root = decodeOptionalBoundary(json, boundary.jsonObject);
  if (!root) return undefined;
  const nested = root.needs_you;
  if (nested !== undefined) return nested === null ? undefined : decodeOptionalBoundary(nested, needsYouSchema) ?? undefined;
  return Array.isArray(root.questions) ? decodeOptionalBoundary(root, needsYouSchema) ?? undefined : undefined;
}

function plainLine(json: JsonValue | undefined, text: string): string | undefined {
  const root = json === undefined ? undefined : decodeOptionalBoundary(json, boundary.jsonObject);
  if (json !== undefined && !root) return undefined;
  // Each field on its own, so one that isn't a string doesn't hide the others.
  return ['summary', 'step', 'title']
    .map(key => decodeOptionalBoundary(root ? root[key] : fieldOf(text, key), boundary.string)?.trim())
    .find(Boolean);
}

function sameText(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(b).includes(norm(a));
}

function choicesOf(options: string[]): NotifyChoice[] | undefined {
  const choices: NotifyChoice[] = [];
  for (const option of options) {
    const recommended = RECOMMENDED.test(option);
    const label = option.replace(RECOMMENDED, '').trim();
    if (!label || choices.some(choice => choice.label === label)) continue;
    choices.push(recommended ? { label, recommended: true } : { label });
  }
  return choices.length > 0 && choices.length <= MAX_CHOICES ? choices : undefined;
}

function linkOf(file: string): NotifyLink | undefined {
  const target = file.trim();
  if (!target) return undefined;
  if (/^https?:\/\/\S+$/iu.test(target)) {
    const label = target.replace(/^https?:\/\//iu, '').replace(/\/$/u, '');
    return { label: label.slice(0, 80), url: target };
  }
  const label = path.basename(target.replace(/#.*$/u, '')) || target;
  return { label: label.slice(0, 80), path: target };
}

function listed(questions: NonNullable<NeedsYou['questions']>): string {
  const list = questions.map((question, index) => `${index + 1}. ${question.q?.trim() ?? ''}${question.options?.length ? ` (${question.options.join(' / ')})` : ''}`.trimEnd());
  const whys = questions.map(question => question.why?.trim()).filter((why): why is string => Boolean(why));
  return [...list, ...whys].join('\n');
}

function cardOf(needsYou: NeedsYou, title: string): StatusCard {
  const questions = (needsYou.questions ?? []).filter(question => question.q?.trim() || question.options?.length);
  const parts: string[] = [];
  const card: StatusCard = {};
  if (questions.length === 1) {
    const [question] = questions;
    const ask = question.q?.trim();
    if (ask && !sameText(ask, title)) parts.push(ask);
    if (question.why?.trim()) parts.push(question.why.trim());
    const choices = question.options ? choicesOf(question.options) : undefined;
    if (choices) card.choices = choices;
  } else if (questions.length > 1 && questions.length <= NOTIFY_QUESTIONS_MAX && questions.every(question => question.q?.trim() && question.options?.length)) {
    // Each question gets its own buttons; the needs_you `why` below is the card's subtitle.
    const subQuestions = questions.map(question => {
      const choices = choicesOf(question.options ?? []);
      if (!choices) return undefined;
      const why = question.why?.trim();
      const sub: NotifySubQuestion = { title: question.q?.trim() ?? '', choices };
      if (why) sub.why = why;
      return sub;
    });
    if (subQuestions.every((sub): sub is NotifySubQuestion => sub !== undefined)) card.questions = subQuestions;
    else parts.push(listed(questions));
  } else if (questions.length > 1) {
    // Some question has nothing to press: they are listed, and answered in words.
    parts.push(listed(questions));
  } else if (needsYou.title?.trim() && !sameText(needsYou.title.trim(), title)) {
    parts.push(needsYou.title.trim());
  }
  if (needsYou.why?.trim() && !parts.includes(needsYou.why.trim())) parts.push(needsYou.why.trim());
  if (parts.length) card.context = cut(parts.join('\n\n'));
  const links = (needsYou.files ?? []).map(linkOf).filter((link): link is NotifyLink => link !== undefined).slice(0, NOTIFY_LINKS_MAX);
  if (links.length) card.links = links;
  return card;
}

/**
 * A card's content from text that is a status file or a `needs_you` block, sent as JSON (often
 * cut short by the journal): the question and why as context, its options as choices, its files
 * as links. JSON it doesn't recognize gives one plain line (summary, step or title) or nothing,
 * never the raw text. Undefined when the text isn't JSON (prose starting with a bracket included),
 * so prose stays as written.
 */
export function statusCard(text: string, title: string): StatusCard | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  const body = trimmed.endsWith(TRUNCATION_MARKER) ? trimmed.slice(0, -TRUNCATION_MARKER.length).trimEnd() : trimmed;
  const json = parse(body);
  // Prose can start with a bracket ("[WIP] …", a Markdown link): only JSON, or JSON the journal
  // cut short (its marker, or a key right after the opening bracket), is read as JSON.
  if (json === undefined && body === trimmed && !/^[{[]\s*"/u.test(body)) return undefined;
  const needsYou = needsYouOf(json, body);
  if (needsYou) {
    const card = cardOf(needsYou, title);
    if (card.context || card.choices || card.questions || card.links) return card;
  }
  const line = plainLine(json, body);
  return line ? { context: cut(line) } : {};
}

/**
 * A worker's question card, from its report summary. A report sent with `--summary-file` carries
 * the whole status file, which already opens beside the card as the worker's status link; from it
 * the card takes the `needs_you` question, choices and files. Prose stays as written, capped.
 */
export function workerReportCard(summary: string | undefined, question: string): StatusCard {
  const text = summary?.trim();
  if (!text) return {};
  return statusCard(text, question) ?? { context: cut(text) };
}

/**
 * A worker's question card as Pane posts it: built from its report, tidied when the question is an
 * old paragraph, and checked. Throws the check's refusal (a PaneError); `quietly` keeps a card that
 * fails as it was sent instead, for reports recorded before the check existed.
 */
export function workerCard(summary: string | undefined, question: string, options: { quietly?: boolean } = {}): StatusCard & { title: string; asSent?: AdmittedCard['asSent']; warnings: string[] } {
  const card = workerReportCard(summary, question);
  const fields = { title: question, context: card.context, choices: card.choices, questions: card.questions, links: card.links };
  let admitted: AdmittedCard;
  try {
    admitted = admitCard(fields);
  } catch (error) {
    if (!options.quietly) throw error;
    return { ...card, title: question, warnings: [] };
  }
  const { title, context, choices, questions, links } = admitted.card;
  return { title, context, choices, questions, links, asSent: admitted.asSent, warnings: admitted.warnings };
}
