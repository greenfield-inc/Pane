// One function per glasses screen in the design reference (mockups v2: C3 card, T3 terminal; the home
// list is homeList.ts).
// Each returns a page of boxes at G2 scale; nothing here touches the bridge.
import { BRIGHT, DIM, DIMMER, LIST_PAD, type Box, type Brightness, type ListBox, type Page, type TextBox } from './display';
import { JOIN_REASONS, type Card, type Computer, type HostRefusal, type PaneEntry } from './model';
import { isRule } from './terminal';
import { LINE_H, SCREEN_H, SCREEN_W, fitLine, wrap, wrapClamped } from './text';

const BAR_H = 32;
const FOOTER_Y = SCREEN_H - BAR_H;
const BODY_PAD = 8;
const BAR_PAD = 2;
const LIST_ROW_H = 40;
/** C3: the choices keep four rows at the bottom. */
const CHOICES_Y = 128;
const QUESTION_MAX_LINES = 3;
/** Width a box gives its text, less a few pixels against rounding on the firmware. */
const innerWidth = (pad: number) => SCREEN_W - 2 * pad - 4;
const linesFor = (height: number, pad: number) => Math.max(1, Math.floor((height - 2 * pad) / LINE_H));

function bar(name: string, y: number, text: string, brightness: Brightness): TextBox {
  return { kind: 'text', name, x: 0, y, w: SCREEN_W, h: BAR_H, pad: BAR_PAD, lines: [fitLine(text, innerWidth(BAR_PAD))], brightness };
}

const header = (text: string) => bar('header', 0, text, DIM);
const footer = (text: string, brightness: Brightness = DIMMER) => bar('footer', FOOTER_Y, text, brightness);

interface BodyOptions {
  y: number;
  h: number;
  name?: string;
  pad?: number;
  brightness?: Brightness;
  capture?: boolean;
  border?: boolean;
}

/** Wrapped paragraphs that fit the box; the last line that fits ends with "…" when text is cut. */
function body(text: string, options: BodyOptions): TextBox {
  const pad = options.pad ?? BODY_PAD;
  const { lines } = wrapClamped(text, innerWidth(pad), linesFor(options.h, pad));
  return {
    kind: 'text',
    name: options.name ?? 'body',
    x: 0,
    y: options.y,
    w: SCREEN_W,
    h: options.h,
    pad,
    lines,
    brightness: options.brightness ?? BRIGHT,
    capture: options.capture ?? false,
    border: options.border ?? false,
  };
}

/** A native list, sized to its rows (the firmware centres rows in a taller box) up to `maxH`. */
function list(name: string, y: number, maxH: number, items: string[]): ListBox {
  const h = Math.min(maxH, items.length * LIST_ROW_H + 2 * LIST_PAD);
  return { kind: 'list', name, x: 0, y, w: SCREEN_W, h, items, capture: true };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "Pane · 3 computers", the name the home pages give the whole app. */
const paneTitle = (computerCount: number) => `Pane · ${plural(computerCount, 'computer')}`;

export function firstRunPage(): Page {
  return {
    boxes: [
      header('Pane'),
      body(
        'Pair with your computers once.\nOn your phone: Pane app > Settings > Glasses > Pair glasses.\nThen tap Paste in this app on your phone.\n\nPress for a demo with sample cards.',
        { y: 36, h: 252, capture: true },
      ),
    ],
  };
}

export type CardRow =
  | { kind: 'choice'; label: string }
  | { kind: 'approve'; approved: boolean; label: string }
  | { kind: 'read-all'; label: string }
  | { kind: 'voice'; label: string };

/** "fix-login: stub the clock or loosen retry?" */
function questionText(card: Card): string {
  return card.ui === 'approve' ? `${card.paneName} wants approval: ${card.title}` : `${card.paneName}: ${card.title}`;
}

function questionCut(card: Card): boolean {
  return wrap(questionText(card), innerWidth(BAR_PAD)).length > QUESTION_MAX_LINES;
}

/** The rows of a card's choice list, in order; press on row i acts on rows[i]. */
export function cardRows(card: Card): CardRow[] {
  const rows: CardRow[] = [];
  if (card.ui === 'approve') {
    rows.push({ kind: 'approve', approved: true, label: 'Approve' }, { kind: 'approve', approved: false, label: 'Not yet' });
  } else {
    for (const label of card.ui === 'ask' ? card.suggestions : card.choices) rows.push({ kind: 'choice', label });
  }
  if (questionCut(card)) rows.push({ kind: 'read-all', label: 'Read the whole question' });
  const voice = card.ui === 'approve' ? 'Say why (hold)' : card.ui === 'ask' ? 'Say it (hold)' : 'Something else (hold to say it)';
  rows.push({ kind: 'voice', label: voice });
  return rows;
}

/**
 * C3: dimmed terminal context, the question, the choices. The choices keep their four rows first,
 * the question gets up to three lines (cut with "…"), and the context takes what is left.
 */
export function cardPage(card: Card, contextLines: readonly string[]): Page {
  const { lines: question } = wrapClamped(questionText(card), innerWidth(BAR_PAD), QUESTION_MAX_LINES);
  const questionH = question.length * LINE_H + 9;
  const questionY = CHOICES_Y - questionH;
  const contextH = questionY - 4;
  const boxes: Box[] = [];
  const contextFit = linesFor(contextH, BAR_PAD);
  const context = contextLines.flatMap((line) => wrap(line, innerWidth(BAR_PAD))).filter((line) => line.trim()).slice(-contextFit);
  if (contextH >= LINE_H && context.length) {
    boxes.push({ kind: 'text', name: 'context', x: 0, y: 0, w: SCREEN_W, h: contextH, pad: BAR_PAD, lines: context, brightness: DIMMER });
  }
  boxes.push(
    { kind: 'text', name: 'question', x: 0, y: questionY, w: SCREEN_W, h: questionH, pad: BAR_PAD, lines: question, brightness: BRIGHT },
    list('choices', CHOICES_Y, SCREEN_H - CHOICES_Y, cardRows(card).map((row) => row.label)),
  );
  return { boxes };
}

/** The whole question on its own page; the firmware scrolls it when it is longer than the screen. */
export function fullQuestionPage(card: Card): Page {
  const text = card.context ? `${questionText(card)}\n\n${card.context}` : questionText(card);
  return {
    boxes: [
      header(`${card.paneName} asks · full question`),
      { kind: 'text', name: 'body', x: 0, y: 36, w: SCREEN_W, h: 252, pad: BODY_PAD, lines: wrap(text, innerWidth(BODY_PAD)), brightness: BRIGHT, capture: true },
    ],
  };
}

/** Hold on a card: the words appear while you speak. */
export function voiceAnswerPage(card: Card, transcript: string): Page {
  return {
    boxes: [
      header(`Answering ${card.paneName} · listening`),
      body(`● ${transcript || 'Listening…'}`, { y: 36, h: 220, capture: true }),
      footer('release = send'),
    ],
  };
}

export const TERMINAL_LINES = linesFor(FOOTER_Y - BAR_H, BAR_PAD);
/** A swipe moves half a page: the terminal shows two halves of this many lines. */
export const HALF_PAGE = TERMINAL_LINES / 2;
const HALF_H = (FOOTER_Y - BAR_H) / 2;

/** Rewraps terminal rows to the glasses' width, keeping blank lines; a rule stays one line. */
export function wrapRows(rows: readonly string[]): string[] {
  return rows.flatMap((row) => (isRule(row) ? [fitLine(row.trim(), innerWidth(BAR_PAD))] : wrap(row, innerWidth(BAR_PAD))));
}

/** `wrapRows` without the blank lines at the end. */
export function terminalLines(rows: readonly string[]): string[] {
  const lines = wrapRows(rows);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  return lines;
}

/** T3's footer: the newest card from another Pane, bright, or "all clear elsewhere", dimmed. */
export interface FooterLine {
  text: string;
  brightness: Brightness;
}

export function terminalFooter(elsewhere: Card | undefined, hint = 'all clear elsewhere'): FooterLine {
  if (!elsewhere) return { text: hint, brightness: DIMMER };
  const what = elsewhere.waiting ? `? ${elsewhere.paneName} needs you` : `• ${elsewhere.paneName}: ${elsewhere.title}`;
  return { text: `${what} · double press for it`, brightness: BRIGHT };
}

export interface TerminalView {
  entry: PaneEntry;
  /** The page's lines, already wrapped: the top half first. */
  lines: readonly string[];
  /** Lines above live; 0 is live. */
  scrolledUp: number;
  /** Held at your message: the lines below the page. */
  more?: number;
  /** Keys mode: swipes and press go to the terminal. */
  keys?: boolean;
  /** The half you just read, dimmed after a swipe. */
  dim?: 'top' | 'bottom' | null;
  footer: FooterLine;
}

function terminalTitle(view: TerminalView): TextBox {
  const { entry } = view;
  if (view.keys) return bar('header', 0, 'KEYS · swipe ↑↓ · press Enter · hold Esc/Tab', BRIGHT);
  if (view.scrolledUp) return header(`${entry.name} · scrolled up ${view.scrolledUp} lines`);
  const status = `${entry.name} · ${entry.agent} · ${entry.status}`;
  if (view.more === undefined) return header(status);
  return bar('header', 0, view.more ? `${status} · ↓ ${view.more} more` : status, BRIGHT);
}

const half = (name: string, y: number, lines: readonly string[], brightness: Brightness, capture: boolean): TextBox => ({
  kind: 'text', name, x: 0, y, w: SCREEN_W, h: HALF_H, pad: BAR_PAD, lines: [...lines], brightness, capture,
});

/**
 * T3: status line, the output in two halves, footer for cards elsewhere. The layout never changes,
 * so a swipe is two in-place text updates.
 */
export function terminalPage(view: TerminalView): Page {
  const lines = view.lines.slice(0, TERMINAL_LINES);
  return {
    boxes: [
      terminalTitle(view),
      half('top', BAR_H, lines.slice(0, HALF_PAGE), view.dim === 'top' ? DIMMER : BRIGHT, true),
      half('bottom', BAR_H + HALF_H, lines.slice(HALF_PAGE), view.dim === 'bottom' ? DIMMER : BRIGHT, false),
      footer(view.footer.text, view.footer.brightness),
    ],
  };
}

/** The rows a menu's context box shows: the last two lines that fit. */
function contextBox(lines: readonly string[]): TextBox {
  const wrapped = lines.flatMap((line) => wrap(line, innerWidth(BAR_PAD))).filter((line) => line.trim()).slice(-2);
  return { kind: 'text', name: 'context', x: 0, y: BAR_H, w: SCREEN_W, h: 60, pad: BAR_PAD, lines: wrapped, brightness: DIM };
}

const MENU_Y = 96;

/** A menu Pane is certain of: its question dimmed, its choices as a list to pick from. */
export function pickerPage(entry: PaneEntry, question: readonly string[], choices: readonly string[], picking: boolean, footerLine: FooterLine): Page {
  return {
    boxes: [
      bar('header', 0, picking ? `${entry.name} · picking…` : `${entry.name} · pick one · double = dismiss`, BRIGHT),
      contextBox(question),
      list('choices', MENU_Y, FOOTER_Y - MENU_Y, [...choices]),
      footer(footerLine.text, footerLine.brightness),
    ],
  };
}

/** The keys behind hold in keys mode, in the order the list shows them. */
export const KEY_LIST = [{ key: 'escape', label: 'Esc' }, { key: 'tab', label: 'Tab' }] as const;

/** Hold in keys mode: the rows around the cursor, dimmed, over the Esc / Tab list, and the footer for cards elsewhere. */
export function keyListPage(context: readonly string[], footerLine: FooterLine): Page {
  return {
    boxes: [
      bar('header', 0, 'KEYS · press sends · double = back', BRIGHT),
      contextBox(context),
      list('keys', MENU_Y, FOOTER_Y - MENU_Y, KEY_LIST.map((entry) => entry.label)),
      footer(footerLine.text, footerLine.brightness),
    ],
  };
}

/** The computer turned the first key away: an older Pane, or keys it would not take. */
export function keysRefusedPage(entry: PaneEntry, message: string, next?: string): Page {
  return {
    boxes: [
      bar('header', 0, `${entry.name} · keys not sent`, BRIGHT),
      body(`${next ? `${message} ${next}` : message}\n\nHold to talk still works.`, { y: 36, h: 220, capture: true }),
      footer('double press = back'),
    ],
  };
}

/** Hold in a terminal: the output dims, your words appear live. */
export function dictationPage(entry: PaneEntry, lines: readonly string[], transcript: string): Page {
  const words = wrapClamped(`● ${transcript || 'Listening…'}`, innerWidth(10), 2).lines;
  return {
    boxes: [
      header(`${entry.name} · listening`),
      { kind: 'text', name: 'output', x: 0, y: BAR_H, w: SCREEN_W, h: 120, pad: BAR_PAD, lines: lines.slice(-4), brightness: DIMMER },
      { kind: 'text', name: 'words', x: 0, y: 154, w: SCREEN_W, h: 100, pad: 10, lines: words, border: true, brightness: BRIGHT, capture: true },
      footer('release = send'),
    ],
  };
}

/** A press on an info card's row: its whole message. */
export function infoCardPage(card: Card): Page {
  return {
    boxes: [
      header(`${card.paneName} · ${card.machine}`),
      body(card.context ? `${card.title}\n\n${card.context}` : card.title, { y: 36, h: 220, capture: true }),
      footer('double press = back'),
    ],
  };
}

/** A press on an away computer's row: what is known, and Retry. */
export function awayPage(computer: Computer, clock: (epochMs: number) => string, rowName?: string): Page {
  const { name } = computer;
  const from = rowName ? `${rowName} is from then.` : 'Its rows are from then.';
  const text = computer.status === 'connecting'
    ? `Connecting to ${name}…`
    : computer.lastSeenAt === null
      ? computer.hint ?? `Can't reach ${name}.`
      : `${name} went offline at ${clock(computer.lastSeenAt)}.\n${from} Pane keeps trying by itself.`;
  return {
    boxes: [
      header(`${name} · ${computer.status === 'connecting' ? 'connecting' : 'offline'}`),
      body(`${text}\n\nPress to retry now.`, { y: 36, h: 220, capture: true }),
      footer('press = retry   double press = back'),
    ],
  };
}

/** What a reason a computer couldn't join means, and what to do about it. */
function unjoinedText(name: string, reason: string): string {
  switch (reason) {
    case JOIN_REASONS.older:
      return `${name} runs an older Pane, so these glasses can't join it by themselves.\nUpdate Pane on ${name}. It joins within 10 minutes.`;
    case JOIN_REASONS.revoked:
      return `These glasses were revoked on ${name}, so your other computers don't add them there.\nTo use them on ${name} again, pair from the Pane phone app: Settings › Glasses › Add computers.`;
    case JOIN_REASONS.password:
      return `${name} has a password, and none of your paired computers has it saved.\nConnect to ${name} once from Pane on one of them to save it. It joins within 10 minutes.`;
    case JOIN_REASONS.funnel:
      return `Funnel is on for Pane on ${name}, so it refuses glasses.\nTurn Funnel off for port 8443 on ${name}. It joins within 10 minutes.`;
    case JOIN_REASONS.silent:
      return `${name} didn't answer your other computers.\nCheck that Pane is open on it and Tailscale is on. It joins within 10 minutes.`;
    default:
      return `These glasses can't join ${name} by themselves: ${reason}.`;
  }
}

/** A press on the row of a computer that couldn't join: why, and what to do. */
export function unjoinedPage(name: string, reason: string): Page {
  return {
    boxes: [
      header(`${name} · can't join`),
      body(unjoinedText(name, reason), { y: 36, h: 220, capture: true }),
      footer('double press = back'),
    ],
  };
}

export function connectingPage(computerCount: number): Page {
  return loadingPage(paneTitle(computerCount), 'Connecting to your computers…');
}

function loadingPage(title: string, text: string): Page {
  return { boxes: [header(title), body(text, { y: 36, h: 252, capture: true })] };
}

/** `firstTime`: how to allow the app on a computer that has never answered. */
export function noComputerPage(computerCount: number, firstTime?: string): Page {
  const why = firstTime ?? 'Is Tailscale on on your phone?';
  return {
    boxes: [
      header(`Pane · 0 of ${plural(computerCount, 'computer')}`),
      body(`Can't reach any computer.\n${why}\nPane keeps trying by itself.\n\nPress to retry now.`, { y: 36, h: 252, capture: true }),
    ],
  };
}

/** Pairing failed for every computer in the code; the phone page shows the same text. */
export function pairingFailedPage(reasons: readonly string[]): Page {
  return {
    boxes: [
      header('Pane · not paired'),
      body(reasons.join('\n'), { y: 36, h: 220, capture: true }),
      footer('press = demo   double press = exit'),
    ],
  };
}

export const ORIGIN_REFUSED = 'ERR_GLASSES_ORIGIN_REFUSED';
export const LOCKED_OUT = 'ERR_GLASSES_LOCKED_OUT';

/** A computer turned the glasses away: the host's own message and next step. */
export function refusedPage(computerName: string, refusal: HostRefusal): Page {
  const origin = refusal.code === ORIGIN_REFUSED;
  const title = origin ? `${computerName} · not allowed` : refusal.code === LOCKED_OUT ? `${computerName} · locked out` : `${computerName} · refused`;
  const lead = origin ? 'Allow this app on the computer.\n' : '';
  const next = refusal.next ? `\n${refusal.next}` : '';
  return {
    boxes: [
      header(title),
      body(`${lead}${refusal.message}${next}`, { y: 36, h: 220, capture: true }),
      footer(refusal.retryAt ? 'Pane tries again by itself   double press = back' : 'press = retry   double press = back'),
    ],
  };
}

/** Something went wrong on one screen; double press goes back. */
export function problemPage(title: string, message: string, next?: string): Page {
  return {
    boxes: [
      header(title),
      body(next ? `${message}\n${next}\n\nDouble press to go back.` : `${message}\n\nDouble press to go back.`, { y: 36, h: 252, capture: true }),
    ],
  };
}
