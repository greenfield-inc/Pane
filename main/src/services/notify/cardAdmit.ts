import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PaneError } from '../../../../shared/paneError';
import { NOTIFY_LINKS_MAX, type NotifyLink } from '../../../../shared/types/notify';
import { assertCard, type CardFields } from './cardCheck';
import { tidyCard, type TidiedCard } from './cardTidy';

/** A card as Pane posts it: tidied when it was an old paragraph card, with the checks' warnings. */
export interface AdmittedCard {
  card: CardFields;
  /** Set when Pane tidied it: the title and context exactly as sent (Show as sent). */
  asSent?: TidiedCard['asSent'];
  /** The files Pane linked because the card's text names them; already in `card.links`. */
  attached: NotifyLink[];
  warnings: string[];
  /** The warnings about files the card names: what an --update, which keeps the rest, is told. */
  fileWarnings: string[];
}

/** What admitting a card needs from the disk Pane opens links on. */
export interface CardFiles {
  kind(target: string): 'file' | 'folder' | undefined;
  home: string;
}

interface AdmitOptions {
  tidy?: boolean;
  files?: CardFiles;
  /** The card's earlier version (an --update) or the card it improves (--relays): paths it already named aren't checked again. */
  known?: CardFields;
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

const PATH_LINK_FORM = '{"label":"…","path":"/abs/path"}';
/** Where a path starts: /, ~/ or a Windows drive. `//` is a URL's host, not a path. */
const PATH_START = /^(?:~\/|\/(?!\/)|[A-Za-z]:[\\/])/u;
/** Text in backticks or double quotes, which may be a path with spaces in it. */
const DELIMITED = /`([^`\n]+)`|"([^"\n]+)"|“([^”\n]+)”/gu;
/** A path written bare: from its start to the next space or bracket; Unicode names included. */
const BARE = /(?:^|[\s([{<])((?:~\/|\/(?!\/)|[A-Za-z]:[\\/])[^\s"`“”<>()[\]{}]+)/gu;
/** A file name's extension: what makes a missing path a file reference rather than a route. */
const EXTENSION = /\.[\p{L}\p{N}]{1,10}$/u;

/** One place a card names a path: the ways to read it, the whole delimited text first. */
type Mention = string[];

/** The path's first folder under its root: /Users for /Users/me/a.md, C:\Users for C:\Users\me\a.md. */
function topFolder(target: string): string {
  const { root } = path.parse(target);
  return root + target.slice(root.length).split(/[\\/]/u)[0];
}

/** A path as written, without a #section or the sentence's closing punctuation. */
function cleaned(written: string): string {
  return written.replace(/#[^/\\]*$/u, '').replace(/[.,;:!?'’]+$/u, '');
}

/** Paths written bare in this text, in order. */
function barePaths(text: string): string[] {
  return [...text.matchAll(BARE)].map(match => cleaned(match[1]));
}

/** Every path the text names: a delimited one read whole (with the paths inside it as fallbacks), then the bare ones. */
function mentions(text: string): Mention[] {
  const found: Mention[] = [];
  const rest = text.replace(DELIMITED, (span: string, ...groups: Array<string | undefined>) => {
    const inner = (groups[0] ?? groups[1] ?? groups[2] ?? '').trim();
    if (!PATH_START.test(inner)) return span;
    found.push([cleaned(inner), ...barePaths(inner)]);
    return ' '.repeat(span.length);
  });
  return [...found, ...barePaths(rest).map(bare => [bare])];
}

/** Every text on the card a person reads: title, context, each question, option and consequence. */
function cardTexts(card: CardFields): string[] {
  const questions = card.questions ?? [];
  const choices = [...card.choices ?? [], ...questions.flatMap(question => question.choices)];
  return [card.title, card.context ?? '', ...questions.flatMap(question => [question.title, question.why ?? '']), ...choices.flatMap(choice => [choice.label, choice.detail ?? ''])];
}

/**
 * The one step every way of asking reaches (runpane notify, runpane report, the MCP notify tool):
 * an old paragraph card is tidied by rule, files its text names are linked, then the card is
 * checked. Throws the refusal as a PaneError with a code and next step; otherwise returns the card
 * and its warnings.
 */
export function admitCard(fields: CardFields, options: AdmitOptions = {}): AdmittedCard {
  const tidied = options.tidy === false ? undefined : tidyCard(fields);
  const linked = linkMentionedFiles(tidied?.card ?? fields, options.files ?? LOCAL_FILES, options.known);
  const warnings = [...linked.warnings, ...assertCard(linked.card)];
  const admitted: AdmittedCard = { card: linked.card, attached: linked.attached, warnings, fileWarnings: linked.warnings };
  if (tidied) admitted.asSent = tidied.asSent;
  return admitted;
}

/** A card with the files its text names linked, and the warnings that say what Pane did. */
interface LinkedCard {
  card: CardFields;
  attached: NotifyLink[];
  warnings: string[];
}

/**
 * A file the card names but no link opens is attached as a link, and the asker told. A missing
 * path refuses the card only when it is plainly a file (it has an extension) under a folder this
 * computer has; under a top folder it doesn't have, it is a warning. Folders, routes and other
 * paths without an extension stay text.
 */
function linkMentionedFiles(card: CardFields, files: CardFiles, known: CardFields | undefined): LinkedCard {
  const resolve = (written: string) => (written.startsWith('~/') ? path.join(files.home, written.slice(2)) : written);
  const key = (written: string) => path.normalize(resolve(written));
  const linked = new Set((card.links ?? []).flatMap(link => ('path' in link ? [key(cleaned(link.path))] : [])));
  const named = new Set(known ? cardTexts(known).flatMap(mentions).flat().map(key) : []);
  const attached: NotifyLink[] = [];
  const missing: string[] = [];
  const elsewhere: string[] = [];
  for (const mention of cardTexts(card).flatMap(mentions)) {
    const readings = mention.filter(written => resolve(written).split(/[\\/]/u).filter(Boolean).length >= 2);
    if (!readings.length || readings.some(written => linked.has(key(written)) || named.has(key(written)))) continue;
    const found = readings.find(written => files.kind(resolve(written)) !== undefined);
    if (found !== undefined) {
      linked.add(key(found));
      if (files.kind(resolve(found)) === 'file') attached.push({ label: path.basename(resolve(found)).slice(0, 80), path: resolve(found) });
      continue;
    }
    const file = readings.find(written => EXTENSION.test(path.basename(written)));
    if (file === undefined) continue;
    linked.add(key(file));
    (files.kind(topFolder(resolve(file))) === 'folder' ? missing : elsewhere).push(file);
  }
  if (missing.length) {
    throw new PaneError(
      'ERR_NOTIFY_UNLINKED_PATH',
      `The card names ${missing.length === 1 ? 'a file' : 'files'} that ${missing.length === 1 ? "isn't" : "aren't"} on this computer (${missing.join(', ')}) and no link opens ${missing.length === 1 ? 'it' : 'them'}, so it was not posted.`,
      `Fix the path in the text, or attach the file in --links as ${PATH_LINK_FORM} (path for local files; url only for http(s) pages), then ask again; runpane notify --check shows the card without posting it.`,
    );
  }
  const links = [...card.links ?? [], ...attached];
  if (links.length > NOTIFY_LINKS_MAX) {
    const names = attached.map(link => ('path' in link ? link.path : link.label)).join(', ');
    throw new PaneError(
      'ERR_NOTIFY_LINKS_FULL',
      `The card names ${names}, but it already has ${card.links?.length ?? 0} of its ${NOTIFY_LINKS_MAX} links, so ${attached.length === 1 ? 'that file' : 'those files'} can't be attached and it was not posted.`,
      `Make room in --links (up to ${NOTIFY_LINKS_MAX}) for each file the card names, as ${PATH_LINK_FORM}, or link a Summary page that lists the rest.`,
    );
  }
  const warnings: string[] = [];
  if (attached.length) {
    warnings.push(`Attached ${attached.map(link => ('path' in link ? link.path : '')).join(', ')} as ${attached.length === 1 ? 'a link' : 'links'}: the card names ${attached.length === 1 ? 'it' : 'them'} but --links didn't. Next time pass local files in --links as ${PATH_LINK_FORM}.`);
  }
  if (elsewhere.length) {
    warnings.push(`The card names ${elsewhere.join(', ')}, which ${elsewhere.length === 1 ? "isn't" : "aren't"} on this computer, so the person can't open ${elsewhere.length === 1 ? 'it' : 'them'} from the card. If ${elsewhere.length === 1 ? "it's a file" : "they're files"} they should read, pass ${elsewhere.length === 1 ? 'it' : 'them'} in --links as ${PATH_LINK_FORM}.`);
  }
  return { card: attached.length ? { ...card, links } : card, attached, warnings };
}
