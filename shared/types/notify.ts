/**
 * Pane Notify: agents call the `notify` MCP tool (or `runpane notify`) and Pane shows the
 * question wherever the person is, then returns the answer as the tool result.
 *
 * The main process owns one in-memory queue (main/src/services/notify/notifyQueue.ts) and
 * pushes a {@link NotifySnapshot} to every surface: the main window, the floating strip and
 * the round. Surfaces send {@link NotifyAction}s back; the first answer wins and every
 * surface clears together. Nothing is persisted: a question lives only while its call is open.
 */

export type NotifyUi = 'options' | 'approve' | 'ask' | 'info';

export interface NotifyChoice {
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface NotifyAction {
  label: string;
  url: string;
}

/** What the agent asks for; the tool's input minus `resume`. */
export interface NotifyQuestion {
  ui: NotifyUi;
  title: string;
  context?: string;
  /** options only: 1 to 9. */
  choices?: NotifyChoice[];
  /** approve only: preformatted block behind a "Show the …" disclosure. */
  detail?: string;
  /** ask only: chips above the text field. */
  suggestions?: string[];
  /** info only: one button. */
  action?: NotifyAction;
}

/** The daemon request `runpane:notify` takes from the CLI. */
export interface NotifyRequest extends Partial<NotifyQuestion> {
  /** Keep waiting on a question an earlier call returned `waiting` for. */
  resume?: string;
  /** Return `waiting` after this long, for clients whose tool calls time out (Cursor's CLI). */
  returnAfterMs?: number;
  caller: NotifyCaller;
}

export interface NotifyCaller {
  /** PANE_SESSION_ID of the calling terminal, when it runs inside Pane. */
  paneId?: string;
  /** PANE_PANEL_ID of the calling terminal, when it runs inside Pane. */
  panelId?: string;
  /** The caller's working directory; names the card when the caller is outside Pane. */
  cwd?: string;
  /** The MCP client's name (Claude, Codex, Cursor), when the call came through `runpane mcp`. */
  agent?: string;
}

export type NotifyResult =
  | { answer: string; note?: string }
  | { approved: boolean; note?: string }
  | { delivered: 'screen' | 'inbox' }
  | { waiting: true; id: string; next: string }
  | { unavailable: string; next: string };

export type NotifyPosition = 'bottom-center' | 'top-right' | 'bottom-right';

export interface NotifySettings {
  enabled: boolean;
  showOutsidePane: boolean;
  position: NotifyPosition;
  /** An Electron accelerator, such as `Control+Shift+Space`. */
  shortcut: string;
  updatesHideAfterSeconds: number;
  sound: boolean;
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  enabled: true,
  showOutsidePane: true,
  position: 'bottom-center',
  shortcut: 'Control+Shift+Space',
  updatesHideAfterSeconds: 6,
  sound: true,
};

export const NOTIFY_UPDATES_HIDE_AFTER_CHOICES = [4, 6, 10, 20] as const;

/**
 * waiting: the agent's call is open and nobody has answered.
 * sent: answered, held for Undo before the agent gets it.
 * answered / expired: done; listed under Earlier today.
 * info: an update; listed under For your information.
 */
export type NotifyItemState = 'waiting' | 'sent' | 'answered' | 'expired' | 'info';

export interface NotifySource {
  /** The Pane the call came from, when it was linked to one. */
  paneId?: string;
  panelId?: string;
  /** The Pane's name, or the caller's folder name outside Pane. */
  name: string;
  /** Claude, Codex, Cursor, or the client's own name. */
  agent: string;
}

export interface NotifyItem extends NotifyQuestion {
  id: string;
  source: NotifySource;
  state: NotifyItemState;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms when it was answered or expired. */
  resolvedAt?: number;
  /** What was sent, in a few words: the choice, Approved, Denied, or the typed answer. */
  answerSummary?: string;
}

/** What the strip shows. Main decides; every surface renders the same thing. */
export type NotifyStripView =
  | { kind: 'question'; itemId: string }
  | { kind: 'sent'; itemId: string }
  | { kind: 'expired'; itemId: string }
  | { kind: 'info'; itemId: string; hideAt: number | null };

export interface NotifySnapshot {
  settings: NotifySettings;
  /** Items keyed by id: every waiting question, today's updates and today's history. */
  items: NotifyItem[];
  /** Waiting question ids, oldest first (skip moves one to the back). Excludes `sent`. */
  queue: string[];
  /** Question ids the person closed or snoozed; still waiting, but not on the strip. */
  hidden: string[];
  strip: NotifyStripView | null;
  /** Where the strip shows right now. `pane`: inside Pane's main window. */
  stripSurface: 'window' | 'pane' | null;
  /** The question docked in its terminal by Open in Pane. */
  dockedItemId: string | null;
  /** Epoch ms; strips and sound are off until then. */
  pausedUntil: number | null;
  /** False when another app holds the answer-all shortcut. */
  shortcutRegistered: boolean;
  /** False where Pane can't float a window over other apps (native Wayland). */
  showOutsideSupported: boolean;
  /** Shown once: the first strip ever carries the "Click to answer" hint. */
  firstRun: boolean;
}

export type NotifyRemindAfter = '10m' | '1h' | 'pane';

export type NotifyAnswer =
  | { choice: string; note?: string }
  | { approved: boolean; note?: string }
  | { text: string };

export type NotifyCommand =
  | { type: 'answer'; id: string; answer: NotifyAnswer }
  | { type: 'undo'; id: string }
  /** ✕: hide from the strip; it keeps waiting in the inbox. */
  | { type: 'dismiss'; id: string }
  | { type: 'remind'; id: string; after: NotifyRemindAfter }
  /** Round →: move to the back of the queue. */
  | { type: 'skip'; id: string }
  | { type: 'open-in-pane'; id: string }
  | { type: 'hover-info'; id: string; hovering: boolean }
  | { type: 'pause'; minutes: number }
  | { type: 'resume' }
  | { type: 'open-round'; id?: string }
  | { type: 'close-round' }
  | { type: 'open-inbox' };

/** The floating windows report their card's size so main can fit and place them. */
export interface NotifyWindowSize {
  width: number;
  height: number;
}
