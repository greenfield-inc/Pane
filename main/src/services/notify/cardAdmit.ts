import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaneError } from '../../../../shared/paneError';
import type { NotifyLink } from '../../../../shared/types/notify';
import { assertCard, fitLinks, type CardFields } from './cardCheck';
import { tidyCard, type TidiedCard } from './cardTidy';

/** A card as Pane posts it: tidied when it was an old paragraph card, with the checks' warnings. */
export interface AdmittedCard {
  card: CardFields;
  /** Set when Pane tidied it: the title and context exactly as sent (Show as sent). */
  asSent?: TidiedCard['asSent'];
  warnings: string[];
}

/** What admitting a card needs from the disk Pane opens links on. */
export interface CardFiles {
  kind(target: string): 'file' | 'folder' | undefined;
  home: string;
}

const LOCAL_FILES: CardFiles = {
  kind(target) {
    try {
      const stat = fs.statSync(target);
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : undefined;
    } catch {
      return undefined;
    }
  },
  get home() {
    return os.homedir();
  },
};

/** A card with the files its text names linked, and the warning that says so. */
interface LinkedCard {
  card: CardFields;
  warnings: string[];
}

/** An absolute or ~/ path of two or more parts, after a space, a bracket or a quote. */
const MENTIONED_PATH = /(?:^|[\s(“"'`])((?:~|\/[\w.@+~-]+)(?:\/[\w.@+~-]+)+(?:#[\w.-]+)?)/gu;

const PATH_LINK_FORM = '{"label":"…","path":"/abs/path"}';

/**
 * The one step every way of asking reaches (runpane notify, runpane report, the MCP notify tool):
 * an old paragraph card is tidied by rule, files its text names are linked, then the card is
 * checked. Throws the refusal as a PaneError with a code and next step; otherwise returns the card
 * and its warnings.
 */
export function admitCard(fields: CardFields, options: { tidy?: boolean; files?: CardFiles } = {}): AdmittedCard {
  const tidied = options.tidy === false ? undefined : tidyCard(fields);
  const linked = linkMentionedFiles(tidied?.card ?? fields, options.files ?? LOCAL_FILES);
  const warnings = [...linked.warnings, ...assertCard(linked.card)];
  return tidied ? { card: linked.card, asSent: tidied.asSent, warnings } : { card: linked.card, warnings };
}

/** Every text on the card a person reads: title, context, each question, option and consequence. */
function cardTexts(card: CardFields): string[] {
  const questions = card.questions ?? [];
  const choices = [...card.choices ?? [], ...questions.flatMap(question => question.choices)];
  return [card.title, card.context ?? '', ...questions.flatMap(question => [question.title, question.why ?? '']), ...choices.flatMap(choice => [choice.label, choice.detail ?? ''])];
}

/**
 * A file the card names but no link opens is attached as a link, and the asker told; one that
 * isn't there refuses the card, so the person never gets a path they can't open. A path whose
 * first folder isn't on this disk (an API route, a URL path) and a folder are left as text.
 */
function linkMentionedFiles(card: CardFields, files: CardFiles): LinkedCard {
  const linked = new Set((card.links ?? []).flatMap(link => ('path' in link ? [link.path.replace(/#.*$/u, '')] : [])));
  const attached: NotifyLink[] = [];
  const missing: string[] = [];
  for (const text of cardTexts(card)) {
    for (const match of text.matchAll(MENTIONED_PATH)) {
      const mentioned = match[1].replace(/[.,;:]+$/u, '').replace(/#.*$/u, '');
      const target = mentioned.startsWith('~/') ? path.join(files.home, mentioned.slice(2)) : mentioned;
      if (linked.has(mentioned) || linked.has(target)) continue;
      const root = target.split('/').slice(0, 2).join('/');
      if (files.kind(root) !== 'folder') continue;
      const kind = files.kind(target);
      if (kind === 'folder') continue;
      linked.add(target);
      if (kind === 'file') attached.push({ label: path.basename(target).slice(0, 80), path: target });
      else missing.push(mentioned);
    }
  }
  if (missing.length) {
    const names = missing.join(', ');
    throw new PaneError(
      'ERR_NOTIFY_UNLINKED_PATH',
      `The card names ${missing.length === 1 ? 'a file' : 'files'} that ${missing.length === 1 ? "isn't" : "aren't"} on this computer (${names}) and no link opens ${missing.length === 1 ? 'it' : 'them'}, so it was not posted.`,
      `Fix the path in the text, or attach the file in --links as ${PATH_LINK_FORM} (path for local files; url only for http(s) pages), then ask again; runpane notify --check shows the card without posting it.`,
    );
  }
  if (!attached.length) return { card, warnings: [] };
  const fitted = fitLinks([...card.links ?? [], ...attached], card.context);
  const next: CardFields = { ...card, links: fitted.links };
  if (fitted.context !== undefined) next.context = fitted.context;
  const warning = `Attached ${attached.map(link => ('path' in link ? link.path : '')).join(', ')} as ${attached.length === 1 ? 'a link' : 'links'}: the card names ${attached.length === 1 ? 'it' : 'them'} but --links didn't. Next time pass local files in --links as ${PATH_LINK_FORM}.`;
  return { card: next, warnings: [warning] };
}
