// The glasses app's state machine: home ↔ card ↔ full question; home → computers → Panes → terminal.
// It reads and acts through a PaneSource (the demo or the paired computers) and draws through `show`.
import type { NotifyAnswer } from '../../shared/types/notify';
import { BRIGHT, type Page } from './display';
import type { Gesture } from './input';
import { CHOICE_KEYS, GlassesError, isPaneEntry, type Card, type Computer, type Dictation, type PaneEntry, type PaneRow, type PaneSource, type TerminalKey } from './model';
import { findMenu, type Menu } from './menu';
import {
  HALF_PAGE,
  KEY_LIST,
  TERMINAL_LINES,
  allClearPage,
  cardPage,
  cardRows,
  computersPage,
  connectingPage,
  dictationPage,
  fullQuestionPage,
  homeCardPage,
  keyListPage,
  keysRefusedPage,
  loadingPage,
  moreStart,
  noComputerPage,
  openPanePage,
  panesPage,
  pickerPage,
  problemPage,
  rowOrder,
  refusedPage,
  terminalFooter,
  terminalLines,
  terminalPage,
  voiceAnswerPage,
  wrapRows,
} from './screens';
import { isRule, trimChrome } from './terminal';
import type { Cancel } from './timers';

/** How often an open terminal reads the host's screen, and faster while its agent works. */
const SCREEN_POLL_MS = 1_000;
const SCREEN_POLL_WORKING_MS = 500;
/** How many terminal lines a card shows as context. */
const CARD_CONTEXT_LINES = 6;
/** Earlier screen reads kept to spot a footer that never changes. */
const EARLIER_READS = 3;
/** While held at your message, the saved output is read at most this often, and only this much of it. */
const HOLD_READ_MS = 1_000;
const HOLD_LINES = 150;
/** How long after a send your line may take to show up before the view stops waiting for it. */
const HOLD_FIND_MS = 5_000;
/** Your line is found by its first characters, which fit on its first row. */
const HOLD_MATCH_CHARS = 40;
const MENU_CHANGED = 'The menu changed, so nothing was sent';
const NUMBER_IGNORED = "The menu didn't take its number; answer it with keys";
/** How long after a choice's number the menu should be gone. */
const PICK_SETTLE_MS = 1_000;

const menuKey = (menu: Menu) => menu.identity;
/** The last index whose row passes `test`, or -1. */
function lastIndex(rows: readonly string[], test: (row: string) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) if (test(rows[index] ?? '')) return index;
  return -1;
}

/** Two rows around the cursor, for the Esc / Tab list: the cursor's row and the next, or the last two rows. */
function cursorRows(rows: readonly string[]): string[] {
  const filled = rows.filter((row) => row.trim() && !isRule(row));
  const at = lastIndex(filled, (row) => /^\s*[❯>›]/u.test(row));
  return at >= 0 ? filled.slice(at, at + 2) : filled.slice(-2);
}

export interface AppDeps {
  source: PaneSource;
  show(page: Page): void;
  /** Root double press: the system exit dialog (shutDownPageContainer(1)). */
  exit(): void;
  /** Turns the glasses microphone on or off. */
  mic(on: boolean): Promise<boolean>;
  later(fn: () => void, ms: number): Cancel;
  now(): number;
  /** "9:40" for a time of day. */
  clock(epochMs: number): string;
}

/**
 * scroll: output only, swipes page through it. keys: the whole screen, swipes and press go to the
 * terminal. key-list: Esc and Tab, behind hold in keys mode. keys-refused: the computer turned a key away.
 */
type TerminalMode = 'scroll' | 'keys' | 'key-list' | 'keys-refused';

/** Held at your message after dictation: the page starts at your line while the reply grows below it. */
interface Hold {
  /** The first characters of what you said. */
  text: string;
  sentAt: number;
  /** The saved output from the last read, wrapped, and where your line starts in it (null until it shows). */
  lines: string[];
  start: number | null;
  /** Lines swiped away from `start`; negative is older. */
  offset: number;
  /** The screen at that read, and when it was. */
  readScreen: string;
  readAt: number;
}

interface TerminalState {
  computerId: string;
  entry: PaneEntry;
  /** The screen's rows from the last read, and a few reads before it, oldest first. */
  screen: string[];
  earlier: string[][];
  /** What the live view shows of the screen: the output above the input box, wrapped. */
  lines: string[];
  /** Older output, wrapped; loaded on the first swipe up. */
  scrollback: string[] | null;
  scrolledUp: number;
  /** The half just read, dimmed after a swipe. */
  dim: 'top' | 'bottom' | null;
  mode: TerminalMode;
  /** Why the computer turned a key away (keys-refused). */
  refusal: { message: string; next?: string } | null;
  /** Shown in keys mode's footer until the next key. */
  notice: string | null;
  /** The menu on the last screen read, and the one double press dismissed (until it leaves the screen). */
  menu: Menu | null;
  dismissed: string | null;
  /** The menu a pick is answering, while it sends keys. */
  picking: Menu | null;
  hold: Hold | null;
}

const NEW_TERMINAL: Omit<TerminalState, 'computerId' | 'entry'> = {
  screen: [], earlier: [], lines: [], scrollback: null, scrolledUp: 0, dim: null,
  mode: 'scroll', refusal: null, notice: null, menu: null, dismissed: null, picking: null, hold: null,
};

type View =
  | { name: 'home' }
  | { name: 'card'; key: string; context: string[] }
  | { name: 'full'; key: string }
  | { name: 'voice-answer'; key: string; transcript: string }
  | { name: 'computers' }
  | { name: 'panes'; computerId: string; entries: PaneRow[] | null }
  | ({ name: 'terminal' } & TerminalState)
  | ({ name: 'dictation'; transcript: string } & TerminalState)
  | { name: 'refused'; computerId: string; back: View }
  | { name: 'problem'; title: string; message: string; next?: string; back: View };

/** The home pages: every card, then "Open a Pane…"; "open" marks that last page. */
type HomeEntry = Card | 'open';

/** The row last pressed in a list: its id, and where it was in case it is gone next time. */
interface ListFocus {
  id: string;
  index: number;
}

/** Where a list starts: the remembered row, or the nearest row `idOf` can name when it is gone. */
function startOf<T>(rows: readonly T[], focus: ListFocus | null, idOf: (row: T) => string | null): number {
  if (!focus) return 0;
  const found = rows.findIndex((row) => idOf(row) === focus.id);
  if (found >= 0) return found;
  for (let distance = 0; distance < rows.length; distance += 1) {
    for (const index of [focus.index + distance, focus.index - distance]) {
      const row = rows[index];
      if (row !== undefined && idOf(row) !== null) return index;
    }
  }
  return 0;
}

const computerKey = (computer: Computer) => computer.id;
const entryKey = (entry: PaneEntry) => `${entry.kind}:${entry.id}`;
const rowKey = (row: PaneRow) => (isPaneEntry(row) ? entryKey(row) : null);

export class GlassesApp {
  private view: View = { name: 'home' };
  private homeIndex = 0;
  private homeFocus: string | null = null;
  /** The computer last picked, and the Session or Pane last opened on each computer. */
  private computerFocus: ListFocus | null = null;
  private readonly paneFocus = new Map<string, ListFocus>();
  private confirmation: string | undefined;
  /** Cards answered here, hidden until the computer's next Notify state drops them. */
  private readonly answered = new Set<string>();
  private dictation: Dictation | null = null;
  /** Counts holds; a voice startup that finishes after its hold ended sees a newer number and stands down. */
  private listening = 0;
  private poll: Cancel | null = null;
  /** Counts screen reads; only the newest one draws or schedules the next. */
  private reads = 0;
  private holdReading = false;
  /** Keys go out one at a time, in the order pressed; a failed key drops the ones queued behind it. */
  private keyQueue: Promise<void> = Promise.resolve();
  private keyFailures = 0;
  /** The tab this open already resumed, so a tab that stops again is not restarted behind the user. */
  private resumed: string | null = null;
  private readonly unsubscribe: () => void;

  /** Every card key seen so far, so a question that just arrived can be told apart. */
  private readonly seen = new Set<string>();

  constructor(private readonly deps: AppDeps) {
    for (const card of deps.source.cards()) this.seen.add(card.key);
    this.unsubscribe = deps.source.subscribe(() => this.sourceChanged());
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
    this.stopPolling();
    this.listening += 1;
    this.dictation?.cancel();
  }

  private cards(): Card[] {
    return this.deps.source.cards().filter((card) => !this.answered.has(card.key));
  }

  private card(key: string): Card | undefined {
    return this.cards().find((card) => card.key === key);
  }

  private homeEntries(): HomeEntry[] {
    const cards = this.cards();
    return cards.length ? [...cards, 'open'] : ['open'];
  }

  private sourceChanged(): void {
    const keys = new Set(this.deps.source.cards().map((card) => card.key));
    for (const key of this.answered) if (!keys.has(key)) this.answered.delete(key);
    const arrived = this.deps.source.cards().filter((card) => !this.seen.has(card.key));
    for (const card of arrived) this.seen.add(card.key);
    // On the all-clear or "Open a Pane…" page, a new question takes page 1 (journey J2).
    const question = arrived.find((card) => card.waiting);
    if (this.view.name === 'home' && this.homeFocus === 'open' && question) {
      this.homeFocus = this.cards()[0]?.key ?? 'open';
      this.homeIndex = 0;
    }
    const view = this.view;
    // A card answered on another screen leaves; go home rather than show a stale question.
    if ((view.name === 'card' || view.name === 'full') && !this.card(view.key)) this.view = { name: 'home' };
    this.render();
  }

  // ---------- drawing ----------

  private render(): void {
    this.deps.show(this.page());
  }

  private page(): Page {
    const view = this.view;
    const source = this.deps.source;
    switch (view.name) {
      case 'home':
        return this.homePage();
      case 'card': {
        const card = this.card(view.key);
        return card ? cardPage(card, view.context) : this.homePage();
      }
      case 'full': {
        const card = this.card(view.key);
        return card ? fullQuestionPage(card) : this.homePage();
      }
      case 'voice-answer': {
        const card = this.deps.source.cards().find((candidate) => candidate.key === view.key);
        return card ? voiceAnswerPage(card, view.transcript) : this.homePage();
      }
      case 'computers':
        return this.computersPage();
      case 'panes': {
        const name = this.computerName(view.computerId);
        return view.entries ? panesPage(name, view.entries, this.panesStart(view.computerId, view.entries)) : loadingPage(`${name} · Sessions and Panes`, 'Loading…');
      }
      case 'terminal':
        return this.terminalPage(view);
      case 'dictation':
        return dictationPage(view.entry, view.lines, view.transcript);
      case 'refused': {
        const computer = source.computers().find((candidate) => candidate.id === view.computerId);
        if (!computer?.refusal) return this.computersPage();
        return refusedPage(computer.name, computer.refusal);
      }
      case 'problem':
        return problemPage(view.title, view.message, view.next);
    }
  }

  private homePage(): Page {
    const source = this.deps.source;
    const computers = source.computers();
    if (!source.demo && computers.length && !computers.some((computer) => computer.status === 'live')) {
      const refused = computers.find((computer) => computer.refusal);
      if (refused?.refusal) return refusedPage(refused.name, refused.refusal);
      if (computers.some((computer) => computer.status === 'offline')) return noComputerPage(computers.length, computers.find((computer) => computer.hint)?.hint);
      return connectingPage(computers.length);
    }
    const entries = this.homeEntries();
    const index = this.resolveHomeIndex(entries);
    const entry = entries[index] ?? 'open';
    const position = { index: index + 1, total: entries.length, computerCount: computers.length, confirmation: this.confirmation };
    if (entries.length === 1) return allClearPage(computers.length, this.confirmation);
    return entry === 'open' ? openPanePage(position) : homeCardPage(entry, position);
  }

  /** Keeps the page you are on when cards arrive or leave. */
  private resolveHomeIndex(entries: HomeEntry[]): number {
    const focused = this.homeFocus === null ? -1 : entries.findIndex((entry) => (entry === 'open' ? 'open' : entry.key) === this.homeFocus);
    this.homeIndex = focused >= 0 ? focused : Math.min(this.homeIndex, entries.length - 1);
    const entry = entries[this.homeIndex];
    this.homeFocus = entry === undefined ? null : entry === 'open' ? 'open' : entry.key;
    return this.homeIndex;
  }

  private computerName(id: string): string {
    return this.deps.source.computers().find((computer) => computer.id === id)?.name ?? 'Computer';
  }

  private elsewhere(state: TerminalState): Card | undefined {
    return this.cards().find((card) => !(card.computerId === state.computerId && card.panelId === state.entry.panelId));
  }

  /** The picker's menu, when one shows: the menu being picked, or a menu not dismissed. */
  private pickerMenu(state: TerminalState): Menu | null {
    if (state.picking) return state.picking;
    if (state.mode !== 'scroll' || !state.menu || state.dismissed === menuKey(state.menu)) return null;
    return state.menu;
  }

  private terminalPage(state: TerminalState): Page {
    const elsewhere = this.elsewhere(state);
    switch (state.mode) {
      case 'keys-refused':
        return keysRefusedPage(state.entry, state.refusal?.message ?? '', state.refusal?.next);
      case 'key-list':
        return keyListPage(cursorRows(state.screen), terminalFooter(elsewhere));
      case 'keys':
        return terminalPage({
          entry: state.entry, keys: true, scrolledUp: 0, lines: terminalLines(state.screen).slice(-TERMINAL_LINES),
          footer: state.notice ? { text: state.notice, brightness: BRIGHT } : terminalFooter(elsewhere, 'double press = done'),
        });
      case 'scroll':
        break;
    }
    const footer = terminalFooter(elsewhere);
    const menu = this.pickerMenu(state);
    if (menu) return pickerPage(state.entry, menu.question, menu.choices, state.picking !== null, footer);
    const page = { entry: state.entry, scrolledUp: state.scrolledUp, footer, dim: state.dim };
    const hold = state.hold;
    if (hold && hold.start !== null) {
      const top = this.heldTop(hold);
      return terminalPage({ ...page, lines: hold.lines.slice(top, top + TERMINAL_LINES), more: Math.max(0, hold.lines.length - top - TERMINAL_LINES) });
    }
    if (!state.scrolledUp || !state.scrollback) return terminalPage({ ...page, lines: state.lines.slice(-TERMINAL_LINES) });
    const end = state.scrollback.length - state.scrolledUp;
    return terminalPage({ ...page, lines: state.scrollback.slice(Math.max(0, end - TERMINAL_LINES), end) });
  }

  /** The held page's first line. */
  private heldTop(hold: Hold): number {
    return Math.max(0, Math.min((hold.start ?? 0) + hold.offset, hold.lines.length - 1));
  }

  // ---------- input ----------

  handle(gesture: Gesture): void {
    if (gesture.type === 'audio') {
      this.dictation?.push(gesture.pcm);
      return;
    }
    if (gesture.type === 'foreground') {
      this.deps.source.retry();
      if (this.view.name === 'terminal' || this.view.name === 'dictation') this.markViewed(this.view.computerId, this.view.entry);
      this.render();
      return;
    }
    if (gesture.type === 'background' || gesture.type === 'exit') {
      if (this.view.name === 'terminal' || this.view.name === 'dictation') this.markViewed(this.view.computerId, this.view.entry);
      return;
    }
    const view = this.view;
    switch (view.name) {
      case 'home': this.onHome(gesture); break;
      case 'card': this.onCard(view, gesture); break;
      case 'full': if (gesture.type === 'double' || gesture.type === 'press') this.go({ name: 'card', key: view.key, context: [] }); break;
      case 'voice-answer': if (gesture.type === 'release') void this.finishVoiceAnswer(view.key); break;
      case 'computers': this.onComputers(gesture); break;
      case 'panes': this.onPanes(view, gesture); break;
      case 'terminal': this.onTerminal(view, gesture); break;
      case 'dictation': if (gesture.type === 'release') void this.finishDictation(view); break;
      case 'refused':
        if (gesture.type === 'press') {
          this.deps.source.retry(view.computerId);
          this.go(view.back);
        } else if (gesture.type === 'double') this.go(view.back);
        break;
      case 'problem': if (gesture.type === 'double' || gesture.type === 'press') this.go(view.back); break;
    }
  }

  private go(view: View): void {
    const left = this.view;
    if ((left.name === 'terminal' || left.name === 'dictation') && view.name !== 'terminal' && view.name !== 'dictation') {
      this.stopPolling();
      this.markViewed(left.computerId, left.entry);
    }
    this.view = view;
    this.render();
  }

  private goHome(focusKey?: string): void {
    if (focusKey) {
      this.homeFocus = focusKey;
      this.homeIndex = 0;
    }
    this.go({ name: 'home' });
  }

  private onHome(gesture: Gesture): void {
    const source = this.deps.source;
    const computers = source.computers();
    if (!source.demo && computers.length && !computers.some((computer) => computer.status === 'live')) {
      if (gesture.type === 'press') {
        // Retry now: a computer allowed again shows "Connecting…", then home, or its refusal again.
        const refused = computers.filter((computer) => computer.refusal);
        if (refused.length) for (const computer of refused) source.retry(computer.id);
        else source.retry();
        this.render();
      } else if (gesture.type === 'double') this.deps.exit();
      return;
    }
    const entries = this.homeEntries();
    const index = this.resolveHomeIndex(entries);
    const entry = entries[index] ?? 'open';
    switch (gesture.type) {
      case 'up':
      case 'down': {
        const next = Math.max(0, Math.min(entries.length - 1, index + (gesture.type === 'down' ? 1 : -1)));
        const target = entries[next] ?? 'open';
        this.homeIndex = next;
        this.homeFocus = target === 'open' ? 'open' : target.key;
        this.confirmation = undefined;
        this.render();
        return;
      }
      case 'press':
        this.confirmation = undefined;
        if (entry === 'open') this.go({ name: 'computers' });
        else if (entry.waiting) this.openCard(entry);
        else if (entry.panelId) this.openTerminal(entry.computerId, { kind: 'pane', id: entry.paneId ?? entry.panelId, name: entry.paneName, agent: '…', status: 'idle', panelId: entry.panelId });
        return;
      case 'hold':
        if (entry !== 'open' && entry.waiting) void this.startVoiceAnswer(entry);
        return;
      case 'double':
        this.deps.exit();
        return;
      default:
        return;
    }
  }

  private openCard(card: Card): void {
    this.go({ name: 'card', key: card.key, context: card.context && !card.panelId ? [card.context] : [] });
    if (!card.panelId) return;
    void this.deps.source.screen(card.computerId, card.panelId).then((screen) => {
      const view = this.view;
      if (view.name !== 'card' || view.key !== card.key) return;
      this.view = { ...view, context: trimChrome(screen.lines).filter((line) => line.trim()).slice(-CARD_CONTEXT_LINES) };
      this.render();
    }, () => {
      // Context is a nicety: the card works without the terminal lines.
    });
  }

  private onCard(view: { key: string }, gesture: Gesture): void {
    const card = this.card(view.key);
    if (!card) {
      this.goHome();
      return;
    }
    if (gesture.type === 'double') this.goHome(card.key);
    else if (gesture.type === 'hold') void this.startVoiceAnswer(card);
    else if (gesture.type === 'select') {
      const row = cardRows(card)[gesture.index];
      if (!row) return;
      if (row.kind === 'read-all') this.go({ name: 'full', key: card.key });
      else if (row.kind === 'choice') void this.sendAnswer(card, { choice: row.label }, row.label);
      else if (row.kind === 'approve') void this.sendAnswer(card, { approved: row.approved }, row.label);
    }
  }

  private async sendAnswer(card: Card, answer: NotifyAnswer, summary: string): Promise<void> {
    this.answered.add(card.key);
    this.confirmation = `Answered ${card.paneName}: ${summary}`;
    this.homeFocus = null;
    this.homeIndex = 0;
    this.go({ name: 'home' });
    try {
      await this.deps.source.answer(card, answer);
    } catch (error) {
      this.answered.delete(card.key);
      this.confirmation = undefined;
      this.showProblem(`${card.paneName} · not answered`, error, { name: 'home' });
    }
  }

  private async startVoiceAnswer(card: Card): Promise<void> {
    this.go({ name: 'voice-answer', key: card.key, transcript: '' });
    try {
      await this.startListening(card.computerId, (text) => {
        const view = this.view;
        if (view.name === 'voice-answer' && view.key === card.key) {
          this.view = { ...view, transcript: text };
          this.render();
        }
      });
    } catch (error) {
      this.showProblem(`${card.paneName} · ${card.machine}`, error, { name: 'card', key: card.key, context: [] });
    }
  }

  private async finishVoiceAnswer(key: string): Promise<void> {
    const card = this.deps.source.cards().find((candidate) => candidate.key === key);
    let text = '';
    try {
      text = await this.stopListening();
    } catch (error) {
      this.showProblem('Not sent', error, card ? { name: 'card', key, context: [] } : { name: 'home' });
      return;
    }
    if (!card) {
      this.goHome();
      return;
    }
    if (!text) {
      this.go({ name: 'card', key, context: [] });
      return;
    }
    // On an approval, a spoken answer is the reason for "Not yet".
    if (card.ui === 'approve') await this.sendAnswer(card, { approved: false, note: text }, `Not yet, "${text}"`);
    else await this.sendAnswer(card, { text }, `"${text}"`);
  }

  private onComputers(gesture: Gesture): void {
    if (gesture.type === 'double') {
      this.goHome();
      return;
    }
    if (gesture.type !== 'select') return;
    const computers = this.deps.source.computers();
    const start = startOf(computers, this.computerFocus, computerKey);
    const index = rowOrder(computers.length, start)[gesture.index];
    if (index === 'more') {
      const next = moreStart(computers.length, start);
      this.computerFocus = { id: computers[next]?.id ?? '', index: next };
      this.render();
      return;
    }
    const computer = index == null ? undefined : computers[index];
    if (index == null || !computer) return;
    this.computerFocus = { id: computer.id, index };
    if (computer.status === 'live') void this.openPanes(computer.id);
    else if (computer.refusal) this.go({ name: 'refused', computerId: computer.id, back: { name: 'computers' } });
    else {
      this.deps.source.retry(computer.id);
      this.render();
    }
  }

  private computersPage(): Page {
    const computers = this.deps.source.computers();
    return computersPage(computers, this.deps.clock, startOf(computers, this.computerFocus, computerKey));
  }

  private panesStart(computerId: string, entries: readonly PaneRow[]): number {
    return startOf(entries, this.paneFocus.get(computerId) ?? null, rowKey);
  }

  private async openPanes(computerId: string): Promise<void> {
    this.go({ name: 'panes', computerId, entries: null });
    try {
      const entries = await this.deps.source.panes(computerId);
      const view = this.view;
      if (view.name === 'panes' && view.computerId === computerId) this.go({ ...view, entries });
    } catch (error) {
      this.showProblem(this.computerName(computerId), error, { name: 'computers' });
    }
  }

  private onPanes(view: { computerId: string; entries: PaneRow[] | null }, gesture: Gesture): void {
    if (gesture.type === 'double') this.go({ name: 'computers' });
    else if (gesture.type === 'select') {
      // A press on the gap, a note or the divider opens nothing; More continues the list.
      const entries = view.entries ?? [];
      const start = this.panesStart(view.computerId, entries);
      const index = rowOrder(entries.length, start)[gesture.index];
      if (index === 'more') {
        const next = moreStart(entries.length, start);
        const row = entries[next];
        this.paneFocus.set(view.computerId, { id: row ? rowKey(row) ?? '' : '', index: next });
        this.render();
        return;
      }
      const row = index == null ? undefined : entries[index];
      if (index == null || !row || !isPaneEntry(row)) return;
      this.paneFocus.set(view.computerId, { id: entryKey(row), index });
      this.openTerminal(view.computerId, row);
    }
  }

  // ---------- terminal ----------

  /**
   * Opening and leaving a Pane mark it viewed on its computer, so what was read here stops
   * showing as new on the desktop and phone. A Session has no viewed marker. Best effort.
   */
  private markViewed(computerId: string, entry: PaneEntry): void {
    if (entry.kind === 'pane') void this.deps.source.markViewed(computerId, entry.id).catch(() => {});
  }

  private openTerminal(computerId: string, entry: PaneEntry): void {
    this.resumed = null;
    this.markViewed(computerId, entry);
    this.go({ name: 'terminal', computerId, entry, ...NEW_TERMINAL });
    this.stopPolling();
    void this.refreshScreen();
  }

  private stopPolling(): void {
    this.poll?.cancel();
    this.poll = null;
  }

  /** The open terminal, when it is still the one `panelId` names. */
  private terminalOn(panelId: string): Extract<View, { name: 'terminal' }> | null {
    const view = this.view;
    return view.name === 'terminal' && view.entry.panelId === panelId ? view : null;
  }

  private update(state: Extract<View, { name: 'terminal' }>, change: Partial<TerminalState>): void {
    this.view = { ...state, ...change };
    this.render();
  }

  /** Reads the screen now rather than at the next poll, so a key's effect shows quickly. */
  private readNow(): void {
    this.stopPolling();
    void this.refreshScreen();
  }

  /** Reads the host's rendered screen, then schedules the next read while the terminal stays open. */
  private async refreshScreen(): Promise<void> {
    const view = this.view;
    if (view.name !== 'terminal' && view.name !== 'dictation') return;
    const { computerId, entry } = view;
    const read = ++this.reads;
    let working = entry.status === 'working';
    try {
      const screen = await this.deps.source.screen(computerId, entry.panelId);
      working = screen.status === 'working';
      // A tab opened while stopped starts once, as opening it in Pane does; polling shows it come up.
      if (screen.status === 'stopped' && this.resumed !== entry.panelId) {
        this.resumed = entry.panelId;
        await this.deps.source.resume(computerId, entry.panelId);
      }
      const current = this.view;
      if (read === this.reads && (current.name === 'terminal' || current.name === 'dictation') && current.entry.panelId === entry.panelId) {
        const earlier = [...current.earlier, current.screen].filter((rows) => rows.length).slice(-EARLIER_READS);
        const lines = terminalLines(trimChrome(screen.lines, earlier));
        const menu = findMenu(screen.lines);
        const next: TerminalState = { ...current, screen: screen.lines, earlier, lines, menu, entry: { ...current.entry, status: screen.status, agent: screen.agent } };
        // A dismissed menu that leaves the screen can come back as a new one.
        if (!menu) next.dismissed = null;
        // A new menu takes over a held view: the picker shows it.
        if (menu && next.hold && next.dismissed !== menuKey(menu)) next.hold = null;
        this.view = current.name === 'terminal' ? { ...next, name: 'terminal' } : { ...next, name: 'dictation', transcript: current.transcript };
        // Scrolled up, the view stays where the person put it; press opens keys mode at live.
        const still = current.name === 'terminal' && (current.mode !== 'scroll' || !current.scrolledUp || this.pickerMenu(next));
        if (still) this.render();
        if (current.name === 'terminal' && next.hold) void this.readHeld(entry.panelId);
      }
    } catch (error) {
      if (this.view.name === 'terminal' && read === this.reads) {
        this.showProblem(entry.name, error, { name: 'panes', computerId, entries: null });
        void this.openPanesQuietly(computerId);
        return;
      }
    }
    const still = this.view;
    if (read === this.reads && (still.name === 'terminal' || still.name === 'dictation') && still.entry.panelId === entry.panelId) {
      this.poll = this.deps.later(() => void this.refreshScreen(), working ? SCREEN_POLL_WORKING_MS : SCREEN_POLL_MS);
    }
  }

  /**
   * Held at your message: reads the saved output when the screen changed, at most once a second,
   * and finds your line again. A line that is gone (the screen was cleared) releases the hold.
   */
  private async readHeld(panelId: string): Promise<void> {
    const view = this.terminalOn(panelId);
    const hold = view?.hold;
    if (!view || !hold || this.holdReading) return;
    const now = this.deps.now();
    const screen = view.screen.join('\n');
    if (screen === hold.readScreen || now - hold.readAt < HOLD_READ_MS) return;
    this.holdReading = true;
    let saved: string[];
    try {
      saved = await this.deps.source.scrollback(view.computerId, panelId, HOLD_LINES);
    } catch {
      return;
    } finally {
      this.holdReading = false;
    }
    const current = this.terminalOn(panelId);
    if (!current || current.hold?.sentAt !== hold.sentAt) return;
    const rows = trimChrome(saved);
    const at = lastIndex(rows, (row) => row.includes(hold.text));
    if (at < 0) {
      // Not there yet just after the send; gone later, or never showing up, means follow live.
      const waiting = hold.start === null && now - hold.sentAt < HOLD_FIND_MS;
      this.update(current, { hold: waiting ? { ...current.hold, readAt: now, readScreen: screen } : null, dim: null });
      return;
    }
    this.update(current, { hold: { ...current.hold, lines: terminalLines(rows), start: wrapRows(rows.slice(0, at)).length, readAt: now, readScreen: screen } });
  }

  /** Fills the Panes list behind a problem page, so double press lands on a real list. */
  private async openPanesQuietly(computerId: string): Promise<void> {
    const view = this.view;
    if (view.name !== 'problem' || view.back.name !== 'panes') return;
    try {
      const entries = await this.deps.source.panes(computerId);
      const current = this.view;
      if (current.name === 'problem') this.view = { ...current, back: { name: 'panes', computerId, entries } };
    } catch {
      // The problem page already says what failed.
    }
  }

  private onTerminal(view: Extract<View, { name: 'terminal' }>, gesture: Gesture): void {
    // A pick in flight owns the terminal until it sends Enter or stops.
    if (view.picking) return;
    if (gesture.type === 'hold' && (view.mode === 'scroll' || view.mode === 'keys-refused')) {
      void this.startDictation({ ...view, mode: 'scroll', scrolledUp: 0, dim: null, refusal: null });
      return;
    }
    switch (view.mode) {
      case 'keys-refused':
        if (gesture.type === 'press' || gesture.type === 'double') this.update(view, { mode: 'scroll', refusal: null });
        return;
      case 'key-list':
        if (gesture.type === 'double') this.update(view, { mode: 'keys' });
        else if (gesture.type === 'select') {
          const entry = KEY_LIST[gesture.index];
          if (entry) void this.sendKey(view, entry.key, 'keys');
        }
        return;
      case 'keys':
        this.onKeys(view, gesture);
        return;
      case 'scroll':
        if (this.pickerMenu(view)) this.onPicker(view, gesture);
        else this.onScroll(view, gesture);
    }
  }

  private onKeys(view: Extract<View, { name: 'terminal' }>, gesture: Gesture): void {
    switch (gesture.type) {
      case 'up':
      case 'down':
        void this.sendKey(view, gesture.type, 'keys');
        return;
      case 'press':
        // Enter answers what is on screen; the menu it answered is not offered again.
        void this.sendKey({ ...view, dismissed: view.menu ? menuKey(view.menu) : view.dismissed }, 'enter', 'scroll');
        return;
      case 'hold':
        this.update(view, { mode: 'key-list', notice: null });
        return;
      case 'double':
        this.update(view, { mode: 'scroll', notice: null });
        return;
      default:
        return;
    }
  }

  /** Presses one key, then shows `after` with the screen read again at once. */
  private async sendKey(view: Extract<View, { name: 'terminal' }>, key: TerminalKey, after: TerminalMode): Promise<void> {
    this.update(view, { mode: after, notice: null });
    try {
      await this.pressKey(view.computerId, view.entry.panelId, key);
    } catch (error) {
      this.keyRefused(view.entry.panelId, error);
      return;
    }
    if (this.terminalOn(view.entry.panelId)) this.readNow();
  }

  /** Sends one key after every key pressed before it; once one fails, the keys already queued are not sent. */
  private pressKey(computerId: string, panelId: string, key: TerminalKey): Promise<void> {
    const failures = this.keyFailures;
    const sent = this.keyQueue.then(async () => {
      if (failures !== this.keyFailures) {
        throw new GlassesError('ERR_GLASSES_KEY_DROPPED', 'A key before this one was not sent, so this one was not sent either.', 'Look at the terminal, then try again.');
      }
      try {
        await this.deps.source.key(computerId, panelId, key);
      } catch (error) {
        this.keyFailures += 1;
        throw error;
      }
    });
    this.keyQueue = sent.catch(() => {});
    return sent;
  }

  /** A key the computer turned away: an older Pane says so on its own screen; anything else is a problem. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A key's failure is whatever the source threw; only GlassesError fields are read.
  private keyRefused(panelId: string, error: unknown): void {
    const current = this.terminalOn(panelId);
    if (!current) return;
    if (error instanceof GlassesError && (error.code === 'ERR_GLASSES_KEYS_UNSUPPORTED' || error.code === 'ERR_GLASSES_KEY_REFUSED')) {
      this.update(current, { mode: 'keys-refused', picking: null, refusal: error.next ? { message: error.message, next: error.next } : { message: error.message } });
      return;
    }
    this.showProblem(`${current.entry.name} · keys not sent`, error, { ...current, mode: 'scroll', picking: null });
  }

  private onScroll(view: Extract<View, { name: 'terminal' }>, gesture: Gesture): void {
    switch (gesture.type) {
      case 'up':
        if (view.hold?.start != null) this.update(view, { hold: { ...view.hold, offset: Math.max(view.hold.offset - HALF_PAGE, -view.hold.start) }, dim: 'bottom' });
        else void this.scrollUp(view);
        return;
      case 'down':
        this.scrollDown(view);
        return;
      case 'press':
        // Keys mode works at live, on the whole screen.
        this.update(view, { mode: 'keys', scrolledUp: 0, scrollback: null, dim: null, hold: null, notice: null });
        this.readNow();
        return;
      case 'double': {
        const card = this.elsewhere(view);
        if (card) this.goHome(card.key);
        else void this.openPanes(view.computerId);
        return;
      }
      default:
        return;
    }
  }

  /** Half a page down; a step that reaches the end of a held reply, or of older output, follows live again. */
  private scrollDown(view: Extract<View, { name: 'terminal' }>): void {
    const hold = view.hold;
    if (hold?.start != null) {
      // From older output, swiping down stops at your line before reading on.
      if (this.heldTop(hold) + HALF_PAGE + TERMINAL_LINES >= hold.lines.length) this.update(view, { hold: null, dim: null });
      else this.update(view, { hold: { ...hold, offset: hold.offset < 0 ? Math.min(hold.offset + HALF_PAGE, 0) : hold.offset + HALF_PAGE }, dim: 'top' });
      return;
    }
    const scrolledUp = Math.max(0, view.scrolledUp - HALF_PAGE);
    this.update(view, { scrolledUp, dim: scrolledUp ? 'top' : null });
  }

  private async scrollUp(view: Extract<View, { name: 'terminal' }>): Promise<void> {
    // Leaving live reads Pane's saved output afresh; later swipes page through that copy.
    let scrollback = view.scrolledUp ? view.scrollback : null;
    if (!scrollback) {
      try {
        scrollback = terminalLines(trimChrome(await this.deps.source.scrollback(view.computerId, view.entry.panelId)));
      } catch (error) {
        this.showProblem(view.entry.name, error, view);
        return;
      }
    }
    const current = this.terminalOn(view.entry.panelId);
    if (!current || current.mode !== 'scroll') return;
    const most = Math.max(0, scrollback.length - TERMINAL_LINES);
    const scrolledUp = Math.min(most, current.scrolledUp + HALF_PAGE);
    this.update(current, { scrollback, scrolledUp, dim: scrolledUp ? 'bottom' : null });
  }

  private onPicker(view: Extract<View, { name: 'terminal' }>, gesture: Gesture): void {
    const menu = view.menu;
    if (!menu) return;
    if (gesture.type === 'double') this.update(view, { dismissed: menuKey(menu) });
    else if (gesture.type === 'select' && menu.choices[gesture.index] !== undefined) void this.pick(view, menu, gesture.index);
  }

  /**
   * Answers a menu by pressing its choice's number, so where the cursor is never matters. Keys
   * pressed before it land first; then the screen is read again, and a menu that changed at all
   * gets nothing and opens keys mode. A menu still there after its number ignores numbers: keys
   * mode opens for it. The key is never resent.
   */
  private async pick(view: Extract<View, { name: 'terminal' }>, menu: Menu, index: number): Promise<void> {
    const { computerId, entry } = view;
    const panelId = entry.panelId;
    const key = CHOICE_KEYS[index];
    if (!key) return;
    this.update(view, { picking: menu });
    try {
      // Gestures wait while picking, so no key can join the queue between this read and the press.
      await this.keyQueue;
      if (!this.terminalOn(panelId)?.picking) return;
      const found = findMenu((await this.deps.source.screen(computerId, panelId)).lines);
      const current = this.terminalOn(panelId);
      if (!current?.picking) return;
      if (!found || menuKey(found) !== menuKey(menu)) {
        this.update(current, { picking: null, mode: 'keys', notice: MENU_CHANGED });
        this.readNow();
        return;
      }
      await this.pressKey(computerId, panelId, key);
    } catch (error) {
      this.keyRefused(panelId, error);
      return;
    }
    const ignored = await this.stillShows(computerId, panelId, menu);
    const current = this.terminalOn(panelId);
    if (current) {
      this.update(current, ignored
        ? { picking: null, mode: 'keys', notice: NUMBER_IGNORED }
        : { picking: null, dismissed: menuKey(menu), hold: null, scrolledUp: 0, dim: null });
      this.readNow();
    }
  }

  /** Whether `menu` is still on screen a moment after it was answered; a failed read says no. */
  private async stillShows(computerId: string, panelId: string, menu: Menu): Promise<boolean> {
    await new Promise<void>((resolve) => { this.deps.later(resolve, PICK_SETTLE_MS); });
    try {
      const found = findMenu((await this.deps.source.screen(computerId, panelId)).lines);
      return found !== null && menuKey(found) === menuKey(menu);
    } catch {
      return false;
    }
  }

  private async startDictation(view: TerminalState): Promise<void> {
    this.view = { ...view, name: 'dictation', transcript: '' };
    this.render();
    try {
      await this.startListening(view.computerId, (text) => {
        const current = this.view;
        if (current.name === 'dictation') {
          this.view = { ...current, transcript: text };
          this.render();
        }
      });
    } catch (error) {
      this.showProblem(`${view.entry.name} · ${this.computerName(view.computerId)}`, error, { ...view, name: 'terminal' });
    }
  }

  private async finishDictation(view: Extract<View, { name: 'dictation' }>): Promise<void> {
    const { transcript: _transcript, ...state } = view;
    const terminal: View = { ...state, name: 'terminal' };
    try {
      const text = await this.stopListening();
      // After a send, the view holds at your line while the reply grows below it.
      const hold: Hold | null = text
        ? { text: text.slice(0, HOLD_MATCH_CHARS), sentAt: this.deps.now(), lines: [], start: null, offset: 0, readScreen: '', readAt: 0 }
        : null;
      this.go({ ...terminal, hold });
      if (text) await this.deps.source.submit(view.computerId, view.entry.panelId, text);
      this.readNow();
    } catch (error) {
      this.showProblem(`${view.entry.name} · not sent`, error, terminal);
    }
  }

  // ---------- voice ----------

  private async startListening(computerId: string, onPreview: (text: string) => void): Promise<void> {
    this.dictation?.cancel();
    this.dictation = null;
    const attempt = ++this.listening;
    const released = () => attempt !== this.listening;
    let dictation: Dictation;
    try {
      dictation = await this.deps.source.dictate(computerId, onPreview);
    } catch (error) {
      if (released()) return;
      throw error;
    }
    if (released()) {
      dictation.cancel();
      return;
    }
    this.dictation = dictation;
    const on = await this.deps.mic(true).catch(() => false);
    if (released()) {
      // Released while the microphone was starting: the release already took the dictation.
      if (on) void this.deps.mic(false).catch(() => false);
      return;
    }
    if (!on) {
      dictation.cancel();
      this.dictation = null;
      throw new GlassesError('ERR_GLASSES_MIC', 'The glasses microphone did not start.', 'Check that Pane may use the microphone in the Even app, then hold again.');
    }
  }

  private async stopListening(): Promise<string> {
    this.listening += 1;
    await this.deps.mic(false).catch(() => false);
    const dictation = this.dictation;
    this.dictation = null;
    return dictation ? (await dictation.finish()).trim() : '';
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Every catch in the app lands here; it reads only Error and GlassesError fields.
  private showProblem(title: string, error: unknown, back: View): void {
    this.listening += 1;
    this.dictation?.cancel();
    this.dictation = null;
    void this.deps.mic(false).catch(() => false);
    const message = error instanceof Error ? error.message : String(error);
    const next = error instanceof GlassesError ? error.next : undefined;
    this.go({ name: 'problem', title, message, next, back });
  }
}
