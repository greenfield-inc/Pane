// The demo: sample computers, cards and terminals that live in the app, with no network.
// Even review needs it, and anyone can try every screen before pairing.
import type { NotifyAnswer } from '../../shared/types/notify';
import { CHOICE_KEYS, GlassesError, orderCards, type Card, type Computer, type Dictation, type PaneEntry, type PaneRow, type PaneSource, type TerminalKey, type TerminalScreen } from './model';
import type { Cancel } from './timers';

const MINUTE = 60_000;
const SPOKEN = 'stub the clock and rerun only the auth suite';
const WORD_EVERY_MS = 350;
/** After a demo menu is answered, it asks again this much later, so it can be tried again. */
const ASK_AGAIN_MS = 4_000;

/** A menu drawn the way Codex draws its approvals, answered with keys. */
interface DemoMenu {
  question: string;
  choices: string[];
  /** What the agent prints after each choice. */
  replies: string[];
  cursor: number;
}

interface DemoTerminal {
  status: TerminalScreen['status'];
  agent: string;
  earlier: string[];
  lines: string[];
  menu?: DemoMenu;
  /** When an answered menu asks again. */
  askAgainAt?: number;
}

const PUSH_MENU: DemoMenu = {
  question: 'Push the branch and open the PR now?',
  choices: ['Yes, push and open the PR', 'Not yet'],
  replies: ['• Pushed glasses-docs and opened PR #482.', '• Okay, the branch stays local for now.'],
  cursor: 0,
};

function menuRows(menu: DemoMenu): string[] {
  return [
    '', '', `  ${menu.question}`, '',
    ...menu.choices.map((choice, index) => `${index === menu.cursor ? '›' : ' '} ${index + 1}. ${choice}`),
    '', '  Press enter to confirm or esc to cancel',
  ];
}

function terminals(): Map<string, DemoTerminal> {
  return new Map([
    ['fix-login', {
      status: 'working', agent: 'Claude',
      earlier: [
        '• Read(src/auth/refresh.ts)', '• Edit(src/auth/refresh.ts) +12 -3', '• Bash(pnpm typecheck)', '  ok',
        '• I added the retry with exponential backoff. The first retry fires after 500 ms. Run the tests?', '> yes run them',
      ],
      lines: [
        '> run the auth tests again and tell me which one fails first', '• Bash(pnpm test auth)', '  FAIL auth.spec.ts > refresh token',
        '  expected 200, got 401', '• The refresh mock returns 401 before the retry fires, so the retry never runs. Two fixes: stub the clock, or widen the retry window.', '> _',
      ],
    }],
    ['docs-pass', {
      status: 'needs you', agent: 'Codex', earlier: ['$ codex', '• Reading docs/NATIVE_MOBILE.md'],
      lines: ['• Updated docs/NATIVE_MOBILE.md and README.md.', '• Wrote the glasses section of docs/EVEN_G2_GLASSES.md.'],
      menu: { ...PUSH_MENU },
    }],
    ['nightly', {
      status: 'idle', agent: 'shell', earlier: ['$ git pull', 'Already up to date.'],
      lines: ['$ pnpm test', ' Test Files  148 passed (148)', '      Tests  2311 passed (2311)', '   Duration  41.2s', '$ git status -sb', '## nightly...origin/nightly', '$ _'],
    }],
    ['scratch', { status: 'idle', agent: 'shell', earlier: [], lines: ['$ _'] }],
    ['token-refresh', { status: 'needs you', agent: 'Claude', earlier: [], lines: ['• Bash(pnpm test auth)', '  expected 200, got 401'] }],
    ['even-g2-app', { status: 'idle', agent: 'Claude', earlier: [], lines: ['• Wrote cover-sheet.html: 5 packages, 16 checks.', '• No open questions.', '> _'] }],
    ['api-server', { status: 'idle', agent: 'shell', earlier: [], lines: ['$ pnpm dev', 'listening on :3000'] }],
  ]);
}

function entry(kind: PaneEntry['kind'], name: string, terminal: DemoTerminal): PaneEntry {
  return { kind, id: name, name, agent: terminal.agent, status: terminal.status, panelId: name };
}

export class DemoSource implements PaneSource {
  readonly demo = true;
  private readonly listeners = new Set<() => void>();
  private readonly terminals = terminals();
  private items: Card[];
  private readonly started: number;

  constructor(private readonly every: (fn: () => void, ms: number) => Cancel, private readonly now: () => number = Date.now) {
    this.started = now();
    const at = (minutesAgo: number) => this.started - minutesAgo * MINUTE;
    const card = (partial: Omit<Card, 'key' | 'itemId' | 'suggestions' | 'choices'> & Partial<Pick<Card, 'choices' | 'suggestions'>> & { id: string }): Card => ({
      choices: [], suggestions: [], key: `${partial.computerId}:${partial.id}`, itemId: partial.id, ...partial,
    });
    this.items = [
      card({ id: 'q1', computerId: 'studio', machine: 'studio-mac', ui: 'options', waiting: true, title: 'Stub the clock or loosen retry?', context: 'The refresh mock returns 401 before the retry fires, so auth.spec.ts fails first.', choices: ['Stub the clock', 'Loosen retry'], paneName: 'fix-login', paneId: 'fix-login', panelId: 'fix-login', createdAt: at(2) }),
      card({ id: 'q2', computerId: 'studio', machine: 'studio-mac', ui: 'options', waiting: true, title: 'Should I stub the clock in auth.spec.ts, loosen the retry window in refresh.ts to 2 s, or mock the token endpoint so it returns 200 on the second call? Stubbing is the smallest change; loosening the window changes production behavior.', choices: ['Stub the clock', 'Loosen retry to 2 s', 'Mock the endpoint'], paneName: 'token-refresh', paneId: 'token-refresh', panelId: 'token-refresh', createdAt: at(4) }),
      card({ id: 'a1', computerId: 'studio', machine: 'studio-mac', ui: 'approve', waiting: true, title: 'the G2 remote cover sheet.', paneName: 'Planner', paneId: 'even-g2-app', panelId: 'even-g2-app', createdAt: at(6) }),
      card({ id: 'i1', computerId: 'devbox', machine: 'devbox', ui: 'info', waiting: false, title: 'PR #482 opened. Checks are running.', paneName: 'docs-pass', paneId: 'docs-pass', panelId: 'docs-pass', createdAt: at(9) }),
      card({ id: 'i2', computerId: 'studio', machine: 'studio-mac', ui: 'info', waiting: false, title: 'Tests green on studio-mac.', paneName: 'nightly', paneId: 'nightly', panelId: 'nightly', createdAt: at(21) }),
    ];
  }

  computers(): Computer[] {
    const studioWorking = [...this.terminals.values()].filter((terminal) => terminal.status === 'working').length;
    return [
      { id: 'studio', name: 'studio-mac', status: 'live', lastSeenAt: this.started, paneCount: 5, workingCount: studioWorking },
      { id: 'devbox', name: 'devbox', status: 'live', lastSeenAt: this.started, paneCount: 2, workingCount: 0 },
      { id: 'laptop', name: 'laptop', status: 'offline', lastSeenAt: this.started - 62 * MINUTE, paneCount: 0, workingCount: 0 },
    ];
  }

  cards(): Card[] {
    return orderCards(this.items);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private terminal(panelId: string): DemoTerminal {
    const terminal = this.terminals.get(panelId);
    if (!terminal) throw new GlassesError('ERR_DEMO_PANEL', 'This sample Pane has no terminal.');
    return terminal;
  }

  async panes(computerId: string): Promise<PaneRow[]> {
    const names = computerId === 'studio' ? ['fix-login', 'docs-pass', 'nightly', 'scratch'] : computerId === 'devbox' ? ['api-server'] : [];
    const panes = names.map((name) => entry('pane', name, this.terminal(name)));
    return computerId === 'studio' ? [{ ...entry('session', 'even g2 app', this.terminal('even-g2-app')), panelId: 'even-g2-app' }, { kind: 'gap' }, ...panes] : panes;
  }

  async screen(_computerId: string, panelId: string): Promise<TerminalScreen> {
    const terminal = this.terminal(panelId);
    if (terminal.askAgainAt !== undefined && this.now() >= terminal.askAgainAt) {
      terminal.askAgainAt = undefined;
      terminal.menu = { ...PUSH_MENU };
      terminal.status = 'needs you';
    }
    const lines = terminal.menu ? [...terminal.lines, ...menuRows(terminal.menu)] : terminal.lines;
    return { lines, status: terminal.status, agent: terminal.agent };
  }

  async scrollback(_computerId: string, panelId: string): Promise<string[]> {
    const terminal = this.terminal(panelId);
    const filler = Array.from({ length: 30 }, (_, index) => `  ✓ auth.spec.ts > case ${index + 1}`);
    return [...filler, ...terminal.earlier, ...terminal.lines];
  }

  async markViewed(): Promise<void> {}

  async resume(_computerId: string, panelId: string): Promise<void> {
    const terminal = this.terminal(panelId);
    if (terminal.status === 'stopped') terminal.status = 'idle';
  }

  async submit(_computerId: string, panelId: string, text: string): Promise<void> {
    const terminal = this.terminal(panelId);
    const prompt = terminal.agent === 'shell' ? `$ ${text}` : `> ${text}`;
    const reply = terminal.agent === 'shell' ? [`${text.split(' ')[0] ?? text}: sample shell, nothing runs`, '$ _'] : ['• Edit(test/auth.spec.ts) +4 -1', '• Bash(pnpm test auth)'];
    terminal.lines = [...terminal.lines.filter((line) => line !== '> _' && line !== '$ _'), prompt, ...reply].slice(-12);
    if (terminal.agent !== 'shell') terminal.status = 'working';
    this.changed();
  }

  /** Arrows move a menu's cursor, Enter or a choice's number picks, Esc cancels; elsewhere keys change nothing. */
  async key(_computerId: string, panelId: string, key: TerminalKey): Promise<void> {
    const terminal = this.terminal(panelId);
    const menu = terminal.menu;
    if (!menu) return;
    const numbered = CHOICE_KEYS.findIndex((choice) => choice === key);
    const picked = key === 'enter' ? menu.cursor : numbered < menu.choices.length ? numbered : -1;
    if (key === 'up' || key === 'down') {
      menu.cursor = Math.max(0, Math.min(menu.choices.length - 1, menu.cursor + (key === 'down' ? 1 : -1)));
    } else if (picked >= 0 || key === 'escape') {
      const answer = picked >= 0 ? [`› ${picked + 1}. ${menu.choices[picked] ?? ''}`, menu.replies[picked] ?? ''] : ['• Cancelled. Nothing was pushed.'];
      terminal.lines = [...terminal.lines, ...answer].slice(-12);
      terminal.menu = undefined;
      terminal.status = 'idle';
      terminal.askAgainAt = this.now() + ASK_AGAIN_MS;
    }
    this.changed();
  }

  async answer(card: Card, _answer: NotifyAnswer): Promise<void> {
    this.items = this.items.filter((item) => item.key !== card.key);
    this.changed();
  }

  async dictate(computerId: string, onPreview: (text: string) => void): Promise<Dictation> {
    if (computerId === 'devbox') {
      throw new GlassesError('ERR_GLASSES_VOICE_UNAVAILABLE', "devbox can't turn speech into text.", 'Add a Deepgram key (live) or a fal key (recorded) in Pane on that computer: Settings › Integrations › Voice transcription.');
    }
    const words = SPOKEN.split(' ');
    let shown = 0;
    const timer = this.every(() => {
      if (shown >= words.length) return;
      shown += 1;
      onPreview(words.slice(0, shown).join(' '));
    }, WORD_EVERY_MS);
    return {
      push: () => {},
      finish: async () => {
        timer.cancel();
        return SPOKEN;
      },
      cancel: () => timer.cancel(),
    };
  }

  retry(): void {
    this.changed();
  }
}
