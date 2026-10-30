import type { NotifyAnswer, NotifyItem, NotifySharedState, NotifySource, NotifyUi } from '../../shared/types/notify';

/** The part of a computer's Notify state (`notify:remote-snapshot`, `notify:shared-changed`) the glasses read. */
export interface NotifyCardState extends Pick<NotifySharedState, 'machine' | 'epoch' | 'revision'> {
  items: Array<Pick<NotifyItem, 'id' | 'ui' | 'title' | 'context' | 'suggestions' | 'state' | 'createdAt'> & {
    choices?: Array<{ label: string }>;
    source: Pick<NotifySource, 'name' | 'paneId' | 'panelId'>;
  }>;
}

/** One Notify card from one computer, as the glasses show it. */
export interface Card {
  /** Unique across computers: `<computerId>:<itemId>`. */
  key: string;
  computerId: string;
  /** The computer's name, such as "studio-mac". */
  machine: string;
  itemId: string;
  ui: NotifyUi;
  /** True for a question still waiting for an answer; false for an info card. */
  waiting: boolean;
  title: string;
  context?: string;
  /** options: the choice labels. */
  choices: string[];
  /** ask: suggested answers. */
  suggestions: string[];
  /** The asking Pane's name. */
  paneName: string;
  paneId?: string;
  panelId?: string;
  createdAt: number;
}

type ComputerStatus = 'connecting' | 'live' | 'offline' | 'refused';

/** Why a computer turned the glasses away, in the host's own words. */
export interface HostRefusal {
  code: string;
  message: string;
  next?: string;
  /** Epoch ms when a lockout ends and the glasses try again. */
  retryAt?: number;
}

/** The computer's operating system, as its Pane reports it; null for an older Pane that doesn't. */
export type MachineOs = 'macOS' | 'Windows' | 'Linux';

export interface Computer {
  id: string;
  name: string;
  status: ComputerStatus;
  /** Epoch ms of the last sign of life, or null if never reached. */
  lastSeenAt: number | null;
  os: MachineOs | null;
  /** Its open Sessions and Panes as last read, kept while it is away. */
  entries: PaneEntry[];
  refusal?: HostRefusal;
  /** For a computer that has never answered: how to allow this app on it. */
  hint?: string;
}

export type PaneStatus = 'working' | 'idle' | 'needs you' | 'stopped';

/** Why one of your computers couldn't join these glasses, in the vouching computer's words. */
export const JOIN_REASONS = {
  older: 'update Pane there',
  revoked: 'revoked here · pair from phone',
  password: 'needs its password',
  funnel: 'Funnel is on',
  silent: 'not answering',
} as const;

/** A computer of yours the glasses lack and couldn't join on their own. */
export interface UnjoinedComputer {
  /** Its Tailscale machine name, such as "office-pc". */
  name: string;
  /** One of JOIN_REASONS, or a newer Pane's own words. */
  reason: string;
}

/** A Session or a Pane on one computer, with the terminal the glasses open for it. */
export interface PaneEntry {
  kind: 'session' | 'pane';
  id: string;
  name: string;
  /** "Claude", "Codex", "shell". */
  agent: string;
  status: PaneStatus;
  panelId: string;
  /** Epoch ms of its last activity on its computer, when known. */
  activityAt?: number;
}

/** A menu choice's number: Claude Code and Codex pick that choice when it is pressed. */
export const CHOICE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
/** The keys the glasses can press in a terminal; a computer takes nothing else from them. */
export type TerminalKey = 'up' | 'down' | 'enter' | 'escape' | 'tab' | (typeof CHOICE_KEYS)[number];

export interface TerminalScreen {
  lines: string[];
  status: PaneStatus;
  agent: string;
}

/** A live recording that turns into text on the computer. */
export interface Dictation {
  push(pcm: Uint8Array): void;
  /** Stops listening and resolves to the final text (empty when nothing was heard). */
  finish(): Promise<string>;
  cancel(): void;
}

/** A screen read failed while its computer reconnects; the next read may succeed. */
export const SCREEN_RECONNECTING = 'ERR_GLASSES_RECONNECTING';

/** A failure the glasses show as a screen: what happened and what to do next. */
export class GlassesError extends Error {
  override name = 'GlassesError';

  constructor(readonly code: string, message: string, readonly next?: string) {
    super(message);
  }
}

/** Everything the glasses screens read and do; the demo and the paired computers both provide it. */
export interface PaneSource {
  readonly demo: boolean;
  /** Every paired computer with its Sessions and Panes, in pairing order. */
  computers(): Computer[];
  /** Every card from every computer, in display order. */
  cards(): Card[];
  /** Your computers that couldn't join these glasses on their own, and why. */
  unjoined(): UnjoinedComputer[];
  subscribe(listener: () => void): () => void;
  /** Rejects with code SCREEN_RECONNECTING while the computer is still reconnecting. */
  screen(computerId: string, panelId: string): Promise<TerminalScreen>;
  /** Older output, oldest line first: the last `lines` rows, or the source's own limit. */
  scrollback(computerId: string, panelId: string, lines?: number): Promise<string[]>;
  /** Records that the person just looked at a Pane, as selecting it in Pane does, so it stops showing as new. */
  markViewed(computerId: string, paneId: string): Promise<void>;
  /** Starts a stopped terminal tab with its saved agent or command, as opening it in Pane does. */
  resume(computerId: string, panelId: string): Promise<void>;
  /** Types the text into the terminal with Enter. */
  submit(computerId: string, panelId: string, text: string): Promise<void>;
  /** Presses one key in the terminal. A computer on an older Pane refuses with ERR_GLASSES_KEYS_UNSUPPORTED. */
  key(computerId: string, panelId: string, key: TerminalKey): Promise<void>;
  answer(card: Card, answer: NotifyAnswer): Promise<void>;
  dictate(computerId: string, onPreview: (text: string) => void): Promise<Dictation>;
  /** Try every offline computer, or one, now. */
  retry(computerId?: string): void;
}

const AGENT_NAMES = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['gemini', 'Gemini'], ['opencode', 'OpenCode']]);

export function agentLabel(agentType: string | undefined): string {
  if (!agentType) return 'shell';
  return AGENT_NAMES.get(agentType.toLowerCase()) ?? agentType;
}

/** The cards in one computer's Notify state: waiting questions and info cards. */
export function cardsFromNotify(computerId: string, state: NotifyCardState): Card[] {
  const cards: Card[] = [];
  for (const item of state.items) {
    if (item.state !== 'waiting' && item.state !== 'info') continue;
    const card: Card = {
      key: `${computerId}:${item.id}`,
      computerId,
      machine: state.machine,
      itemId: item.id,
      ui: item.ui,
      waiting: item.state === 'waiting',
      title: item.title,
      choices: (item.choices ?? []).map((choice) => choice.label),
      suggestions: item.suggestions ?? [],
      paneName: item.source.name,
      createdAt: item.createdAt,
    };
    if (item.context) card.context = item.context;
    if (item.source.paneId) card.paneId = item.source.paneId;
    if (item.source.panelId) card.panelId = item.source.panelId;
    cards.push(card);
  }
  return cards;
}

/** Questions first, then info cards; newest first within each. */
export function orderCards(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.createdAt - a.createdAt);
}
