// The glasses app's state machine: home ↔ card ↔ full question; home → computers → Panes → terminal.
// It reads and acts through a PaneSource (the demo or the paired computers) and draws through `show`.
import type { NotifyAnswer } from '../../shared/types/notify';
import type { Page } from './display';
import type { Gesture } from './input';
import { GlassesError, isPaneEntry, type Card, type Dictation, type PaneEntry, type PaneRow, type PaneSource } from './model';
import {
  TERMINAL_LINES,
  allClearPage,
  cardPage,
  cardRows,
  computersPage,
  connectingPage,
  dictationPage,
  fullQuestionPage,
  homeCardPage,
  loadingPage,
  noComputerPage,
  openPanePage,
  panesPage,
  problemPage,
  refusedPage,
  terminalFooter,
  terminalLines,
  terminalPage,
  voiceAnswerPage,
} from './screens';
import type { Cancel } from './timers';

/** How often an open terminal reads the host's screen, and faster while its agent works. */
const SCREEN_POLL_MS = 1_000;
const SCREEN_POLL_WORKING_MS = 500;
/** How many terminal lines a card shows as context. */
const CARD_CONTEXT_LINES = 6;

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

interface TerminalState {
  computerId: string;
  entry: PaneEntry;
  /** The live screen, wrapped. */
  lines: string[];
  /** Older output, wrapped; loaded on the first swipe up. */
  scrollback: string[] | null;
  scrolledUp: number;
}

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

export class GlassesApp {
  private view: View = { name: 'home' };
  private homeIndex = 0;
  private homeFocus: string | null = null;
  private confirmation: string | undefined;
  /** Cards answered here, hidden until the computer's next Notify state drops them. */
  private readonly answered = new Set<string>();
  private dictation: Dictation | null = null;
  /** Counts holds; a voice startup that finishes after its hold ended sees a newer number and stands down. */
  private listening = 0;
  private poll: Cancel | null = null;
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
        return computersPage(source.computers(), this.deps.clock);
      case 'panes': {
        const name = this.computerName(view.computerId);
        return view.entries ? panesPage(name, view.entries) : loadingPage(`${name} · Sessions and Panes`, 'Loading…');
      }
      case 'terminal':
        return terminalPage({ entry: view.entry, lines: this.visibleLines(view), scrolledUp: view.scrolledUp, footer: terminalFooter(this.elsewhere(view)) });
      case 'dictation':
        return dictationPage(view.entry, view.lines, view.transcript);
      case 'refused': {
        const computer = source.computers().find((candidate) => candidate.id === view.computerId);
        if (!computer?.refusal) return computersPage(source.computers(), this.deps.clock);
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

  private visibleLines(state: TerminalState): string[] {
    if (!state.scrolledUp || !state.scrollback) return state.lines.slice(-TERMINAL_LINES);
    const end = state.scrollback.length - state.scrolledUp;
    return state.scrollback.slice(Math.max(0, end - TERMINAL_LINES), end);
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
      this.view = { ...view, context: screen.lines.filter((line) => line.trim()).slice(-CARD_CONTEXT_LINES) };
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
    const computer = this.deps.source.computers()[gesture.index];
    if (!computer) return;
    if (computer.status === 'live') void this.openPanes(computer.id);
    else if (computer.refusal) this.go({ name: 'refused', computerId: computer.id, back: { name: 'computers' } });
    else {
      this.deps.source.retry(computer.id);
      this.render();
    }
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
      // A press on the gap or a note opens nothing.
      const row = view.entries?.[gesture.index];
      if (row && isPaneEntry(row)) this.openTerminal(view.computerId, row);
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
    this.go({ name: 'terminal', computerId, entry, lines: [], scrollback: null, scrolledUp: 0 });
    this.stopPolling();
    void this.refreshScreen();
  }

  private stopPolling(): void {
    this.poll?.cancel();
    this.poll = null;
  }

  /** Reads the host's rendered screen, then schedules the next read while the terminal stays open. */
  private async refreshScreen(): Promise<void> {
    const view = this.view;
    if (view.name !== 'terminal' && view.name !== 'dictation') return;
    const { computerId, entry } = view;
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
      if ((current.name === 'terminal' || current.name === 'dictation') && current.entry.panelId === entry.panelId) {
        this.view = { ...current, lines: terminalLines(screen.lines.join('\n')), entry: { ...current.entry, status: screen.status, agent: screen.agent } };
        if (current.name === 'terminal') this.render();
      }
    } catch (error) {
      if (this.view.name === 'terminal') {
        this.showProblem(entry.name, error, { name: 'panes', computerId, entries: null });
        void this.openPanesQuietly(computerId);
        return;
      }
    }
    const still = this.view;
    if ((still.name === 'terminal' || still.name === 'dictation') && still.entry.panelId === entry.panelId) {
      this.poll = this.deps.later(() => void this.refreshScreen(), working ? SCREEN_POLL_WORKING_MS : SCREEN_POLL_MS);
    }
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
    switch (gesture.type) {
      case 'up':
        void this.scrollUp(view);
        return;
      case 'down':
        this.view = { ...view, scrolledUp: Math.max(0, view.scrolledUp - (TERMINAL_LINES - 1)) };
        this.render();
        return;
      case 'press':
        this.view = { ...view, scrolledUp: 0, scrollback: null };
        this.render();
        return;
      case 'hold':
        void this.startDictation({ ...view, scrolledUp: 0 });
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

  private async scrollUp(view: Extract<View, { name: 'terminal' }>): Promise<void> {
    let scrollback = view.scrollback;
    if (!scrollback) {
      try {
        scrollback = terminalLines((await this.deps.source.scrollback(view.computerId, view.entry.panelId)).join('\n'));
      } catch (error) {
        this.showProblem(view.entry.name, error, view);
        return;
      }
    }
    const current = this.view;
    if (current.name !== 'terminal' || current.entry.panelId !== view.entry.panelId) return;
    const most = Math.max(0, scrollback.length - TERMINAL_LINES);
    this.view = { ...current, scrollback, scrolledUp: Math.min(most, current.scrolledUp + TERMINAL_LINES - 1) };
    this.render();
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
    const terminal: View = { ...view, name: 'terminal' };
    try {
      const text = await this.stopListening();
      this.go(terminal);
      if (text) await this.deps.source.submit(view.computerId, view.entry.panelId, text);
      this.stopPolling();
      void this.refreshScreen();
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
