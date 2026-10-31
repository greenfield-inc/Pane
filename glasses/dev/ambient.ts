// Dev only (not in the build): the real app on the demo with ambient mode on, plus cards that arrive
// or are answered elsewhere on a schedule, so ambient mode can be driven in the Even simulator.
// Open http://localhost:<port>/dev/ambient.html?at=35:q,36:q,37:q,60:answer with steps as
// <seconds after start>:<step>. Steps: q (a question from devbox), info (an update from studio-mac),
// answer (the newest raised card is answered elsewhere), off / on (the phone page's switch).
import { every, later } from '../src/timers';
import { AudioInputSource, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { GlassesApp } from '../src/app';
import { DemoSource } from '../src/demo';
import { Display } from '../src/display';
import { InputRouter } from '../src/input';
import type { NotifyAnswer } from '../../shared/types/notify';
import { orderCards, type Card, type TerminalScreen } from '../src/model';

/** The demo with extra cards on top, raised and answered on a schedule. */
class RaisingDemo extends DemoSource {
  private raised: Card[] = [];
  private readonly raisedListeners = new Set<() => void>();

  override cards(): Card[] {
    return orderCards([...this.raised, ...super.cards()]);
  }

  override subscribe(listener: () => void): () => void {
    this.raisedListeners.add(listener);
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.raisedListeners.delete(listener);
      unsubscribe();
    };
  }

  override async screen(computerId: string, panelId: string): Promise<TerminalScreen> {
    console.info(`[ambient] read ${panelId}`);
    return super.screen(computerId, panelId);
  }

  override async answer(card: Card, answer: NotifyAnswer): Promise<void> {
    if (!this.raised.some((item) => item.key === card.key)) return super.answer(card, answer);
    this.setRaised(this.raised.filter((item) => item.key !== card.key));
  }

  raise(card: Card): void {
    this.setRaised([...this.raised, card]);
  }

  answerNewest(): void {
    this.setRaised(this.raised.slice(0, -1));
  }

  private setRaised(cards: Card[]): void {
    this.raised = cards;
    for (const listener of this.raisedListeners) listener();
  }
}

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge();
  const display = new Display(bridge);
  const source = new RaisingDemo(every);
  const app = new GlassesApp({
    source,
    show: (page) => void display.show(page),
    exit: () => void bridge.shutDownPageContainer(1),
    mic: (on) => (on ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false)),
    later,
    now: Date.now,
    clock: (epochMs) => new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    lastSessionComputer: { read: () => null, write: () => {} },
    ambient: true,
  });
  const input = new InputRouter((gesture) => {
    if (gesture.type === 'foreground') display.invalidate();
    if (gesture.type !== 'audio') console.info(`[ambient] gesture ${gesture.type}`);
    app.handle(gesture);
  }, () => display.lastWriteAt);
  bridge.onEvenHubEvent((event) => input.handle(event));
  display.onPage = (page) => console.info(`[ambient] page ${page.boxes.map((box) => (box.kind === 'list' ? box.items.join(' | ') : box.kind === 'text' ? box.lines.join(' / ') : `[logo ${box.key}]`)).join(' ‖ ')}`);

  let raisedCount = 0;
  const steps = new Map<string, () => void>([
    ['q', () => {
      raisedCount += 1;
      source.raise({
        key: `devbox:raised-${raisedCount}`, computerId: 'devbox', machine: 'devbox', itemId: `raised-${raisedCount}`, ui: 'options', waiting: true,
        title: "Restore from Tuesday's snapshot, or skip tonight's backup?", choices: ['Restore', 'Skip'], suggestions: [],
        paneName: raisedCount === 1 ? 'nightly-backup' : `backup-${raisedCount}`, createdAt: Date.now(),
      });
    }],
    ['info', () => {
      raisedCount += 1;
      source.raise({
        key: `studio:raised-${raisedCount}`, computerId: 'studio', machine: 'studio-mac', itemId: `raised-${raisedCount}`, ui: 'info', waiting: false,
        title: 'PR #212 is ready for review: dark theme tokens and a toggle in Settings.', choices: [], suggestions: [],
        paneName: 'nightly', paneId: 'nightly', panelId: 'nightly', createdAt: Date.now(),
      });
    }],
    ['answer', () => source.answerNewest()],
    ['off', () => app.setAmbient(false)],
    ['on', () => app.setAmbient(true)],
  ]);
  for (const step of (new URLSearchParams(location.search).get('at') ?? '').split(',').filter(Boolean)) {
    const [seconds, name] = step.split(':');
    const run = steps.get(name ?? '');
    if (!run) continue;
    later(() => {
      console.info(`[ambient] step ${step}`);
      run();
    }, Number(seconds) * 1_000);
  }
}

void main();
