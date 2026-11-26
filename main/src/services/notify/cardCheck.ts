import { PaneError } from '../../../../shared/paneError';
import { NOTIFY_LINKS_MAX, type NotifyChoice, type NotifyLink, type NotifySubQuestion } from '../../../../shared/types/notify';

/**
 * The approval card contract (D-342.2, D-347): a title of about 80 to 100 characters on one line,
 * a subtitle (the context) of one or two sentences up to 240 characters, 2 to 4 options each with
 * a consequence and one recommended, and linked references. Pane refuses only the two clear
 * mistakes (a title over 160 characters or with a line break, and two recommended options in one
 * question) and warns on the rest. Every way of asking reaches this: runpane notify, runpane
 * report and the MCP notify tool.
 */

/** A title past this is refused. */
export const CARD_TITLE_REFUSE = 160;
/** A title past this gets a warning. */
const CARD_TITLE_WARN = 100;
/** A subtitle past this gets a warning. */
const CARD_SUBTITLE_WARN = 240;
/** More options than this get a warning. */
const CARD_OPTIONS_WARN = 4;

export interface CardFields {
  title: string;
  context?: string;
  choices?: NotifyChoice[];
  questions?: NotifySubQuestion[];
  links?: NotifyLink[];
}

interface CardRefusal {
  code: 'ERR_NOTIFY_TITLE' | 'ERR_NOTIFY_RECOMMENDED';
  message: string;
  next: string;
}

export interface CardCheck {
  refusal?: CardRefusal;
  warnings: string[];
}

const ABSOLUTE_PATH = /(?:^|[\s(“"'`])(\/(?:[\w.@+~-]+\/)+[\w.@+~-]+(?:#[\w.-]+)?)/gu;

/** Code points, as the CLIs count them. */
function length(text: string): number {
  return [...text].length;
}

/** The questions a card asks, each with its choices: one for `choices`, several for `questions`. */
function asked(card: CardFields): Array<{ title: string; choices: NotifyChoice[] }> {
  if (card.questions?.length) return card.questions;
  return card.choices?.length ? [{ title: card.title, choices: card.choices }] : [];
}

/** Absolute paths in the text that no link opens. */
export function unlinkedPaths(text: string, links: NotifyLink[] | undefined): string[] {
  const linked = new Set((links ?? []).flatMap(link => ('path' in link ? [link.path, link.path.replace(/#.*$/u, '')] : [])));
  const found = [...text.matchAll(ABSOLUTE_PATH)].map(match => match[1].replace(/[.,;:]+$/u, ''));
  return [...new Set(found)].filter(found => !linked.has(found) && !linked.has(found.replace(/#.*$/u, '')));
}

/** The refusal, if the card breaks the contract outright, and a warning for each softer miss. */
export function checkCard(card: CardFields): CardCheck {
  const title = card.title;
  const titleLength = length(title);
  if (/[\r\n]/u.test(title)) {
    return { refusal: {
      code: 'ERR_NOTIFY_TITLE',
      message: 'The title has a line break, so the card was not posted. A title is one line saying what you need.',
      next: 'Keep the first line as the title (--title, about 80 to 100 characters) and move the rest to the context (--context), the one- or two-sentence subtitle; put each question in questions or choices (--questions, --choices).',
    }, warnings: [] };
  }
  if (titleLength > CARD_TITLE_REFUSE) {
    return { refusal: {
      code: 'ERR_NOTIFY_TITLE',
      message: `The title is ${titleLength} characters, past the ${CARD_TITLE_REFUSE} a card takes, so it was not posted.`,
      next: 'Shorten the title (--title) to about 80 to 100 characters saying what you need, put why it matters in the context (--context, one or two sentences), each question in questions or choices (--questions, --choices), and files in links (--links).',
    }, warnings: [] };
  }
  for (const question of asked(card)) {
    const recommended = question.choices.filter(choice => choice.recommended);
    if (recommended.length > 1) {
      const where = card.questions?.length ? `"${question.title}"` : 'This card';
      return { refusal: {
        code: 'ERR_NOTIFY_RECOMMENDED',
        message: `${where} recommends ${recommended.length} options (${recommended.map(choice => choice.label).join(', ')}), so the card was not posted. A question recommends one.`,
        next: 'Mark only the option you would pick with "recommended": true, and say why in its detail.',
      }, warnings: [] };
    }
  }

  const warnings: string[] = [];
  if (titleLength > CARD_TITLE_WARN) warnings.push(`The title is ${titleLength} characters; aim for 80 to 100 and move detail into --context.`);
  const context = card.context?.trim() ?? '';
  if (!context) warnings.push('No subtitle: add --context with one or two sentences on why it matters.');
  else if (length(context) > CARD_SUBTITLE_WARN) warnings.push(`The subtitle is ${length(context)} characters; keep --context to one or two sentences (up to ${CARD_SUBTITLE_WARN}) and link a Summary page for the rest.`);
  const questions = asked(card);
  if (questions.some(question => !question.choices.some(choice => choice.recommended))) warnings.push('No option is recommended: mark the one you would pick with "recommended": true.');
  if (questions.some(question => question.choices.length > CARD_OPTIONS_WARN)) warnings.push(`A question has more than ${CARD_OPTIONS_WARN} options; offer 2 to ${CARD_OPTIONS_WARN}.`);
  if (questions.some(question => question.choices.some(choice => !choice.detail?.trim()))) warnings.push('Some options have no consequence: give each a "detail" saying what happens if it is picked.');
  return { warnings };
}

/** The card's warnings; throws its refusal as a PaneError with a code and next step. */
export function assertCard(card: CardFields): string[] {
  const { refusal, warnings } = checkCard(card);
  if (refusal) throw new PaneError(refusal.code, refusal.message, refusal.next);
  return warnings;
}

/** A card's links and context once its links fit. */
export interface FittedLinks {
  links: NotifyLink[];
  context?: string;
}

/**
 * The links a card shows (the first NOTIFY_LINKS_MAX) and its context, which names the rest on a
 * last line, so a link with no room is never dropped unseen.
 */
export function fitLinks(links: NotifyLink[], context: string | undefined): FittedLinks {
  if (links.length <= NOTIFY_LINKS_MAX) return { links, context };
  const more = `More links: ${links.slice(NOTIFY_LINKS_MAX).map(link => link.label).join(', ')}`;
  return { links: links.slice(0, NOTIFY_LINKS_MAX), context: context?.trim() ? `${context.trimEnd()}\n\n${more}` : more };
}
