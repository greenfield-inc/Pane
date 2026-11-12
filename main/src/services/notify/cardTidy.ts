import path from 'path';
import { NOTIFY_LINKS_MAX, NOTIFY_QUESTIONS_MAX, type NotifyChoice, type NotifyLink, type NotifySubQuestion } from '../../../../shared/types/notify';
import { CARD_TITLE_REFUSE, unlinkedPaths, type CardFields } from './cardCheck';

/**
 * Tidying an old paragraph card (D-345, Q-343.2): some agents still send a whole question as one
 * long title, like Q-42. When a card's title breaks the contract and the card has no buttons,
 * Pane splits it by fixed rules, never a model, and never adds a word:
 *
 * - the title is cut at its first sentence;
 * - "1) … 2) …" become separate questions;
 * - "Recommended: yes|no" after a yes-or-no question, and "A or B (recommended)", become options;
 * - a "Files:" list and absolute paths become links.
 *
 * It runs only when every question splits into options; otherwise the card stays as sent (and
 * the check refuses it). The text as sent is kept for Show as sent.
 */

export interface TidiedCard {
  card: CardFields;
  /** The title and context exactly as they were sent. */
  asSent: { title: string; context?: string };
}

const SENTENCE_END = /([.?!])(?=\s+(?:[\p{Lu}\p{N}]|$))/u;
const NUMBERED = /(?:^|\s)(\d)\)\s+/gu;
const FILES = /\s*\bFiles?:\s*(.+)$/su;
const RECOMMENDED_YES_NO = /^\s*Recommended:\s*(yes|no)\b[\s,;:.-]*(.*)$/isu;
const PARENTHETICAL = /\s*\(([^()]*\brecommended\b[^()]*)\)/iu;
const LINKABLE = /^(?:\/|https?:\/\/)\S+$/u;

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withoutStop(text: string): string {
  return text.trim().replace(/[.;,]+$/u, '').trim();
}

function linkOf(target: string): NotifyLink {
  if (/^https?:\/\//u.test(target)) return { label: target.replace(/^https?:\/\//u, '').replace(/\/$/u, '').slice(0, 80), url: target };
  return { label: (path.basename(target.replace(/#.*$/u, '')) || target).slice(0, 80), path: target };
}

/** The first sentence, without its full stop, and what follows. Undefined when there is only one. */
function firstSentence(text: string): { head: string; rest: string } | undefined {
  // A parenthesis can hold a sentence end ("(…; cover sheet ready.)"): skip ends inside one.
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && SENTENCE_END.test(text.slice(index, index + 3)) && /[.?!]/u.test(char)) {
      const rest = text.slice(index + 1).trim();
      if (!rest) return undefined;
      return { head: char === '.' ? text.slice(0, index).trim() : text.slice(0, index + 1).trim(), rest };
    }
  }
  return undefined;
}

/** The question and its options, when the text says them in one of the fixed patterns. */
function questionOf(text: string): NotifySubQuestion | undefined {
  const mark = text.indexOf('?');
  if (mark < 0) return undefined;
  const asked = text.slice(0, mark).trim();
  const after = text.slice(mark + 1);
  const parenthetical = PARENTHETICAL.exec(asked);
  if (parenthetical) {
    // "A (…, recommended) or B?" or "A or B (recommended)?"
    const plain = asked.replace(PARENTHETICAL, '');
    const or = plain.lastIndexOf(' or ');
    if (or < 0) return undefined;
    const left = plain.slice(0, or).trim();
    const right = plain.slice(or + 4).trim();
    const rightWords = right.split(/\s+/u);
    const leftWords = left.split(/\s+/u);
    const a = leftWords.slice(-Math.min(rightWords.length, leftWords.length)).join(' ');
    if (!a || !right) return undefined;
    const detail = withoutStop(parenthetical[1].replace(/\brecommended\b/iu, '').replace(/^[\s,;:-]+|[\s,;:-]+$/gu, ''));
    const onLeft = parenthetical.index < asked.lastIndexOf(' or ');
    const recommended: NotifyChoice = detail ? { label: '', detail, recommended: true } : { label: '', recommended: true };
    const choices: NotifyChoice[] = onLeft
      ? [{ ...recommended, label: capitalized(a) }, { label: capitalized(right) }]
      : [{ label: capitalized(a) }, { ...recommended, label: capitalized(right) }];
    return { title: `${plain.trim()}?`, choices };
  }
  const yesNo = RECOMMENDED_YES_NO.exec(after);
  if (yesNo) {
    const yes = yesNo[1].toLowerCase() === 'yes';
    const detail = withoutStop(yesNo[2]);
    const picked: NotifyChoice = detail ? { label: yes ? 'Yes' : 'No', detail, recommended: true } : { label: yes ? 'Yes' : 'No', recommended: true };
    return { title: `${asked}?`, choices: yes ? [picked, { label: 'No' }] : [{ label: 'Yes' }, picked] };
  }
  return undefined;
}

/** The numbered parts of "1) … 2) …", in order from 1, or undefined. */
function numbered(text: string): { before: string; parts: string[] } | undefined {
  const marks = [...text.matchAll(NUMBERED)];
  if (marks.length < 2 || marks.some((mark, index) => Number(mark[1]) !== index + 1)) return undefined;
  const parts = marks.map((mark, index) => text.slice((mark.index ?? 0) + mark[0].length, marks[index + 1]?.index ?? text.length).trim());
  return { before: text.slice(0, marks[0].index ?? 0).trim(), parts };
}

/** The card split by the fixed rules, or undefined when it keeps the contract or can't be split cleanly. */
export function tidyCard(card: CardFields): TidiedCard | undefined {
  const title = card.title;
  if (card.choices?.length || card.questions?.length) return undefined;
  if (!/[\r\n]/u.test(title) && [...title].length <= CARD_TITLE_REFUSE) return undefined;
  let text = title.replace(/\s+/gu, ' ').trim();

  const links: NotifyLink[] = [];
  const files = FILES.exec(text);
  if (files) {
    const targets = files[1].split(/,\s+|\s+and\s+/u).map(target => target.trim().replace(/[.;]+$/u, ''));
    if (!targets.every(target => LINKABLE.test(target))) return undefined;
    links.push(...targets.map(linkOf));
    text = text.slice(0, files.index).trim();
  }

  const split = firstSentence(text);
  if (!split) return undefined;
  const contextParts: string[] = [];
  let choices: NotifyChoice[] | undefined;
  let questions: NotifySubQuestion[] | undefined;
  const list = numbered(split.rest);
  if (list) {
    const asked = list.parts.map(questionOf);
    if (asked.some(question => !question) || asked.length > NOTIFY_QUESTIONS_MAX) return undefined;
    if (list.before) contextParts.push(list.before);
    questions = asked.filter((question): question is NotifySubQuestion => question !== undefined);
  } else {
    const question = questionOf(split.rest);
    if (!question) return undefined;
    contextParts.push(question.title);
    choices = question.choices;
  }
  if (card.context?.trim()) contextParts.push(card.context.trim());

  const context = contextParts.join('\n\n');
  for (const found of unlinkedPaths([split.head, context].join('\n'), links)) links.push(linkOf(found));
  const tidied: CardFields = { title: split.head };
  if (context) tidied.context = context;
  if (choices) tidied.choices = choices;
  if (questions) tidied.questions = questions;
  const allLinks = [...links, ...(card.links ?? [])].slice(0, NOTIFY_LINKS_MAX);
  if (allLinks.length) tidied.links = allLinks;
  if ([...tidied.title].length > CARD_TITLE_REFUSE) return undefined;
  const asSent: TidiedCard['asSent'] = { title };
  if (card.context !== undefined) asSent.context = card.context;
  return { card: tidied, asSent };
}
