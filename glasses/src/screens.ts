// One function per glasses screen in the design reference (mockups v2: H3 home, C3 card, T3 terminal).
// Each returns a page of boxes at G2 scale; nothing here touches the bridge.
import { BRIGHT, DIM, DIMMER, LIST_PAD, type Box, type Brightness, type ListBox, type Page, type TextBox } from './display';
import type { Card, Computer, HostRefusal, PaneEntry } from './model';
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

/** The confirmation that sits above the next home page after an answer. */
function confirmationBox(text: string): TextBox {
  const lines = wrap(text, innerWidth(10)).slice(0, 2);
  return {
    kind: 'text', name: 'confirm', x: 0, y: 36, w: SCREEN_W, h: lines.length * LINE_H + 37, pad: 10,
    lines, border: true, brightness: BRIGHT,
  };
}

/** The home body, below a confirmation when there is one. */
function homeBody(text: string, confirmation: string | undefined): Box[] {
  if (!confirmation) return [body(text, { y: 36, h: 220, capture: true })];
  const confirm = confirmationBox(confirmation);
  const y = confirm.y + confirm.h + 4;
  return [confirm, body(text, { y, h: FOOTER_Y - y, capture: true })];
}

export interface HomePosition {
  /** 1-based page number. */
  index: number;
  total: number;
  computerCount: number;
  confirmation?: string;
}

/** H3: one card per page with a page counter. */
export function homeCardPage(card: Card, position: HomePosition): Page {
  const kind = card.waiting ? 'needs you' : 'info';
  const title = card.ui === 'approve' ? `Wants approval: ${card.title}` : card.title;
  const text = card.waiting && card.context ? `${title}\n\n${card.context}` : card.context ? `${title}\n${card.context}` : title;
  const hint = card.waiting
    ? 'swipe = next   press = answer   hold = say it'
    : card.panelId ? `swipe = next   press = open ${card.paneName}` : 'swipe = next';
  return {
    boxes: [
      header(`${position.index}/${position.total} · ${kind} · ${card.paneName} · ${card.machine}`),
      ...homeBody(text, position.confirmation),
      footer(hint),
    ],
  };
}

/** H3's last page, the way into Panes. */
export function openPanePage(position: HomePosition): Page {
  return {
    boxes: [
      header(`${position.index}/${position.total} · ${paneTitle(position.computerCount)}`),
      ...homeBody('Open a Pane…\n\nPick a computer, then a Pane or Session.', position.confirmation),
      footer(position.total > 1 ? 'press = open   swipe up = back to cards' : 'press = open'),
    ],
  };
}

/** Nothing waiting: one page with the way into Panes. */
export function allClearPage(computerCount: number, confirmation?: string): Page {
  return {
    boxes: [
      header(`1/1 · ${paneTitle(computerCount)} · all clear`),
      ...homeBody('Nothing needs you.\n\nOpen a Pane…', confirmation),
      footer('press = open a Pane   double press = exit'),
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

/** What a computer row says: its Panes and work, or since when it has been away. */
function computerRow(computer: Computer, clock: (epochMs: number) => string): string {
  if (computer.status === 'live') {
    const work = computer.workingCount ? `${computer.workingCount} working` : 'idle';
    return `${computer.name} · ${plural(computer.paneCount, 'Pane')} · ${work}`;
  }
  if (computer.status === 'connecting') return `${computer.name} · connecting…`;
  if (computer.status === 'refused') return `${computer.name} · refused · press for why`;
  const since = computer.lastSeenAt ? ` since ${clock(computer.lastSeenAt)}` : '';
  return `${computer.name} · offline${since} · press to retry`;
}

export function computersPage(computers: readonly Computer[], clock: (epochMs: number) => string): Page {
  return {
    boxes: [
      header('Open a Pane · pick a computer'),
      list('computers', BAR_H, SCREEN_H - BAR_H, computers.map((computer) => computerRow(computer, clock))),
    ],
  };
}

export function panesPage(computerName: string, entries: readonly PaneEntry[]): Page {
  if (!entries.length) {
    return {
      boxes: [
        header(`${computerName} · Sessions and Panes`),
        body(`No open Sessions or Panes on ${computerName}.\n\nDouble press to go back.`, { y: 36, h: 252, capture: true }),
      ],
    };
  }
  return {
    boxes: [
      header(`${computerName} · Sessions and Panes`),
      list('panes', BAR_H, SCREEN_H - BAR_H, entries.map((entry) => (entry.kind === 'session'
        ? `Session · ${entry.name} · ${entry.status}`
        : `${entry.name} · ${entry.agent} · ${entry.status}`))),
    ],
  };
}

export const TERMINAL_LINES = linesFor(FOOTER_Y - BAR_H, BAR_PAD);

/** Rewraps terminal text to the glasses' width, keeping blank lines. */
export function terminalLines(text: string): string[] {
  return wrap(text.replace(/\s+$/, ''), innerWidth(BAR_PAD));
}

/** T3's footer: the newest card from another Pane, bright, or "all clear elsewhere", dimmed. */
export interface FooterLine {
  text: string;
  brightness: Brightness;
}

export function terminalFooter(elsewhere: Card | undefined, verb = 'double press'): FooterLine {
  if (!elsewhere) return { text: 'all clear elsewhere', brightness: DIMMER };
  const what = elsewhere.waiting ? `? ${elsewhere.paneName} needs you` : `• ${elsewhere.paneName}: ${elsewhere.title}`;
  return { text: `${what} · ${verb}`, brightness: BRIGHT };
}

export interface TerminalView {
  entry: PaneEntry;
  /** The lines on screen, already wrapped. */
  lines: readonly string[];
  /** Lines above live; 0 is live. */
  scrolledUp: number;
  footer: FooterLine;
}

/** T3: status line, output, footer for cards elsewhere. */
export function terminalPage(view: TerminalView): Page {
  const { entry } = view;
  const title = view.scrolledUp
    ? `${entry.name} · scrolled up ${view.scrolledUp} lines · press = live`
    : `${entry.name} · ${entry.agent} · ${entry.status}`;
  return {
    boxes: [
      header(title),
      { kind: 'text', name: 'output', x: 0, y: BAR_H, w: SCREEN_W, h: FOOTER_Y - BAR_H, pad: BAR_PAD, lines: view.lines.slice(-TERMINAL_LINES), brightness: BRIGHT, capture: true },
      footer(view.footer.text, view.footer.brightness),
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

export function loadingPage(title: string, text: string): Page {
  return { boxes: [header(title), body(text, { y: 36, h: 252, capture: true })] };
}

export function noComputerPage(computerCount: number): Page {
  return {
    boxes: [
      header(`Pane · 0 of ${plural(computerCount, 'computer')}`),
      body("Can't reach any computer.\nIs Tailscale on in your phone? Pane retries every 10 seconds.\n\nPress to retry now.", { y: 36, h: 252, capture: true }),
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
