// Pane's widget on Glassly's dashboard (custom firmware only): "3 working · 1 needs you" and the
// newest question. A tap expands it to that question with its choices; swipes move the highlight,
// and a tap answers after the same 5 s undo as the app, during which a tap takes it back.
import type { RenderElement } from '@glassly/miniapp';
import type { NotifyAnswer } from '../../../../shared/types/notify';
import type { Card, PaneSource } from '../../../src/model';
import type { Cancel } from '../../../src/platform';

export const WIDGET_ID = 'pane_status';
/** The app's undo hold, so an answer from the widget can be taken back the same way. */
const UNDO_MS = 5_000;

export type WidgetInput =
  | { type: 'expand' | 'collapse' | 'tap' | 'activate' | 'deactivate' | 'beforeShow' | 'hold' | 'release' }
  | { type: 'swipe'; direction: 'left' | 'right' | 'up' | 'down' };

interface Box { width: number; height: number }

/** One choice of the newest question: its label and what sending it answers. */
interface Choice { label: string; answer: NotifyAnswer }

function choicesOf(card: Card): Choice[] {
  if (card.ui === 'approve') return [{ label: 'Approve', answer: { approved: true } }, { label: 'Not yet', answer: { approved: false } }];
  const labels = card.ui === 'ask' ? card.suggestions : card.choices;
  return labels.map((label) => ({ label, answer: { choice: label } }));
}

export function summaryLine(source: PaneSource): string {
  const working = source.computers().flatMap((computer) => (computer.status === 'live' ? computer.entries : [])).filter((entry) => entry.status === 'working').length;
  const waiting = source.cards().filter((card) => card.waiting).length;
  return `${working} working · ${waiting} need${waiting === 1 ? 's' : ''} you`;
}

export class StatusWidget {
  private selected = 0;
  private cardKey: string | null = null;
  private sending: { label: string; timer: Cancel } | null = null;

  constructor(private readonly deps: {
    source(): PaneSource | null;
    later(fn: () => void, ms: number): Cancel;
    answer(card: Card, answer: NotifyAnswer): Promise<void>;
    redraw(): void;
  }) {}

  private newest(): Card | null {
    return this.deps.source()?.cards().find((card) => card.waiting && card.ui !== 'secret') ?? null;
  }

  /** The card on the dashboard. */
  card(box: Box): RenderElement[] {
    const source = this.deps.source();
    if (!source) return [{ type: 'text', id: 'summary', box: { x: 0, y: 0, w: box.width, h: box.height }, text: 'Pane · not paired' }];
    const newest = this.newest();
    const lines = [`Pane · ${summaryLine(source)}`, newest ? `${newest.paneName}: ${newest.title}` : 'Nothing needs you'];
    return [{ type: 'text', id: 'summary', box: { x: 0, y: 0, w: box.width, h: box.height }, text: lines.join('\n'), style: { overflow: 'ellipsis' } }];
  }

  /** The expanded view: the newest question, its choices, the highlight on one. */
  expanded(box: Box): RenderElement[] {
    const card = this.newest();
    if (!card) return [{ type: 'text', id: 'question', box: { x: 0, y: 0, w: box.width, h: box.height }, text: 'Nothing needs you.' }];
    if (card.key !== this.cardKey) {
      this.cardKey = card.key;
      this.selected = Math.max(0, card.recommended ?? 0);
    }
    if (this.sending) {
      return [{ type: 'text', id: 'question', box: { x: 0, y: 0, w: box.width, h: box.height }, text: `${card.paneName} · ${this.sending.label}\nSent · tap to undo` }];
    }
    const choices = choicesOf(card).map((choice, index) => `${index === this.selected ? '> ' : '   '}${index === card.recommended ? '★ ' : ''}${choice.label}`);
    const split = Math.floor(box.height / 2);
    return [
      { type: 'text', id: 'question', box: { x: 0, y: 0, w: box.width, h: split }, text: `${card.paneName}: ${card.title}`, style: { overflow: 'ellipsis' } },
      { type: 'text', id: 'choices', box: { x: 0, y: split, w: box.width, h: box.height - split }, text: choices.join('\n') },
    ];
  }

  /** Input while the widget is active or expanded; true when it was handled. */
  input(event: WidgetInput): boolean {
    const card = this.newest();
    if (event.type === 'collapse' || event.type === 'deactivate') return false;
    if (event.type === 'swipe' && card && !this.sending) {
      const count = choicesOf(card).length;
      this.selected = Math.max(0, Math.min(count - 1, this.selected + (event.direction === 'down' || event.direction === 'right' ? 1 : -1)));
      this.deps.redraw();
      return true;
    }
    if (event.type !== 'tap' || !card) return false;
    if (this.sending) {
      // A tap during the hold takes the answer back; nothing was sent.
      this.sending.timer.cancel();
      this.sending = null;
      this.deps.redraw();
      return true;
    }
    const choice = choicesOf(card)[this.selected];
    if (!choice) return false;
    const timer = this.deps.later(() => {
      this.sending = null;
      const still = this.deps.source()?.cards().find((candidate) => candidate.key === card.key && candidate.waiting);
      if (still) void this.deps.answer(still, choice.answer).catch(() => {});
      this.deps.redraw();
    }, UNDO_MS);
    this.sending = { label: choice.label, timer };
    this.deps.redraw();
    return true;
  }
}
