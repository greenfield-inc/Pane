/**
 * Pane Notify: agents call the `notify` MCP tool (or `runpane notify`) and Pane shows the
 * question wherever the person is, then returns the answer as the tool result.
 *
 * Each machine keeps its approvals in one table of its sessions.db (ApprovalStore), and the queue
 * (main/src/services/notify/notifyQueue.ts) works from it and pushes a {@link NotifySnapshot} to
 * every surface: the main window, the floating strip and the round. Surfaces send commands back;
 * the first answer wins and every surface clears together. An item exists only while someone can
 * act on it and someone can take the answer (D-147): it outlives a call, but not its asker.
 */

export type NotifyUi = 'options' | 'approve' | 'ask' | 'secret' | 'info';

/**
 * secret only: where the typed value is saved. The host writes it to its Pane secret
 * store when the card is answered and replaces it with `{status:'saved'}`; the value
 * never reaches the agent, the snapshot, history or any other surface.
 */
export interface NotifySecretTarget {
  project: string;
  name: string;
  /** Set by the host: a secret with this address already exists, so saving replaces it. */
  replaces?: boolean;
}

export interface NotifyChoice {
  label: string;
  detail?: string;
  recommended?: boolean;
  /**
   * `--update` only: the label this choice had in the version before, when it was reworded. A
   * choice whose label is unchanged but whose detail changed is reworded too; Pane marks both.
   */
  was?: string;
}

/** One question of an options approval that asks several at once (Q-20's "Question 1 of 2"). */
export interface NotifySubQuestion {
  title: string;
  choices: NotifyChoice[];
}

/** An options approval asks 2 to this many questions at once; each takes one pick. */
export const NOTIFY_QUESTIONS_MAX = 4;

export interface NotifyAction {
  label: string;
  url: string;
}

/**
 * A related link on a card (Approvals): a file on the asking machine, or an http(s) URL. A file
 * opens as a tab of the item's Pane; a URL opens as a browser tab there. Older agents send none.
 */
export type NotifyLink = { label: string; path: string } | { label: string; url: string } | { label: string; approval: string };

/** Up to this many links per card; a label takes up to NOTIFY_LINK_LABEL_MAX characters. */
export const NOTIFY_LINKS_MAX = 6;
export const NOTIFY_LINK_LABEL_MAX = 80;

/** What the agent asks for; the tool's input minus `resume`. */
export interface NotifyQuestion {
  ui: NotifyUi;
  title: string;
  context?: string;
  /** options only: 1 to 9. Absent when `questions` asks several. */
  choices?: NotifyChoice[];
  /** options only, instead of `choices`: 2 to NOTIFY_QUESTIONS_MAX questions, each picked once. */
  questions?: NotifySubQuestion[];
  /** approve only: preformatted block behind a "Show the …" disclosure. */
  detail?: string;
  /** approve only, with detail: the disclosure's label, such as "Show the SQL". Default "Show details". */
  detailLabel?: string;
  /** ask only: chips above the text field. */
  suggestions?: string[];
  /** info only: one button. */
  action?: NotifyAction;
  /** Any ui: related files and pages, shown as chips on the card. */
  links?: NotifyLink[];
  /** secret only: the Pane secret the answer is saved as. The card's title and context are the agent's label and reason. */
  secret?: NotifySecretTarget;
  /** secret only, set by the host: why the last save failed (never contains the value). The card stays waiting for another try. */
  secretError?: string;
  /** Set when the question mirrors a prompt in an agent's terminal (Claude's permission and plan prompts). */
  agentPrompt?: NotifyAgentPrompt;
  /**
   * Set by the chat tab bridge for a built-in question (AskUserQuestion): a typed reply is the
   * answer itself, since the paused turn resumes with it. It reads "Sent to <agent>", with no fix.
   */
  replyIsAnswer?: boolean;
  /**
   * Set by the chat tab bridge for a built-in question that takes only its own choices: typed text
   * can't answer it and nobody could read it as a reply, so it has no reply box.
   */
  optionsOnly?: boolean;
}

/** A prompt an agent shows in its terminal, asked here too; the first answer from either place wins. */
export interface NotifyAgentPrompt {
  /** The phone list's Yes and No buttons: each is one of the question's choices. */
  yes: string;
  no: string;
  /** The agent stopped waiting on Pane (its hook timed out): only its terminal can answer now. */
  inTerminal?: boolean;
}

/** The daemon request `runpane:notify` takes from the CLI. */
export interface NotifyRequest extends Partial<NotifyQuestion> {
  /** Keep waiting on a question an earlier call returned `waiting` for. */
  resume?: string;
  /**
   * `runpane notify --took <id|Q-n> answer|question`: the reader of the person's reply says how it
   * took it. `answer` records the reply as the answer; `question` shows "Getting more context…".
   */
  took?: string;
  tookAs?: 'answer' | 'question';
  /** --took question: what the reader is doing, shown on the approval. Default "Getting more context…". */
  status?: string;
  /**
   * `runpane notify --update <id|Q-n> --asked … --what-changed …`: saves a new version of the
   * approval (any question field it passes replaces that field), then waits on it like a notify call.
   */
  update?: string;
  /** --update: the person's question the new version answers, as they asked it. */
  asked?: string;
  /** --update: what changed, one line per change. */
  whatChanged?: string;
  /** A Session orchestrator improves this waiting item (a worker's question) instead of posting a second card. */
  relays?: string;
  /** Autopilot's own item: the Session it is about (an id or name). Absent: it links to Autopilot's chat. */
  aboutSession?: string;
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
  /** `answers`: one pick per question, when the approval asks several (`answer` joins them with " · "). */
  | { answer: string; note?: string; answers?: string[] }
  /**
   * The person typed a reply: it may be an answer or a question about it. The call ends; run
   * `runpane notify --took <replyId> answer|question` (see `next`), and the approval keeps waiting
   * meanwhile. `replyId` is given only to this call, so it lets its agent continue with --took and
   * --update even from outside a Pane tab (D-294).
   */
  | { reply: string; picks?: string[]; id: string; replyId: string; next: string }
  /** --took: how the reply was recorded. */
  | { took: 'answer' | 'question'; id: string; next?: string }
  | { approved: boolean; note?: string }
  | { delivered: 'screen' | 'inbox' }
  /** secret: the value was saved as `project/name`; it is never returned. */
  | { status: 'saved'; project: string; name: string }
  | { status: 'declined' }
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
  /** Whether pop-up cards open with details shown. Showing or hiding details on a card sets it. */
  showDetails: boolean;
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  enabled: true,
  showOutsidePane: true,
  position: 'bottom-center',
  shortcut: 'Control+Shift+Space',
  updatesHideAfterSeconds: 6,
  sound: true,
  showDetails: false,
};

export const NOTIFY_UPDATES_HIDE_AFTER_CHOICES = [4, 6, 10, 20] as const;

/**
 * waiting: the agent's call is open and nobody has answered.
 * sent: answered, held for Undo before the agent gets it.
 * answered / expired: done; listed under Earlier today.
 * info: an update; listed under For your information.
 */
export type NotifyItemState = 'waiting' | 'sent' | 'answered' | 'expired' | 'info';

/** Who answered or closed an item, on every device's receipt. */
export type NotifyActor = 'you' | 'autopilot' | 'orchestrator' | 'pane';

/** Where an item came from. */
export type NotifyOriginKind = 'orchestrator' | 'worker' | 'autopilot' | 'claude-prompt' | 'pane' | 'agent';

/**
 * What every item is connected to (D-168): the Session it came from. Outside a Session, it links
 * to its Pane, to Autopilot's chat, or, for a caller outside Pane and Pane itself, to the machine.
 */
export type NotifyConnected =
  | { kind: 'session'; id: string; name: string; paneId: string }
  | { kind: 'pane'; id: string; name: string }
  | { kind: 'autopilot'; id: 'autopilot'; name: 'Autopilot' }
  | { kind: 'machine'; id: string; name: string };

/** Who answered, and why when it wasn't the person. */
export interface NotifyAnswerReceipt {
  by: NotifyActor;
  /** Autopilot's reason: a D-n, a document or the person's words. */
  because?: string;
}

/** Why an item closed without an answer: "Session archived", "the asking tab was closed". */
export interface NotifyClosed {
  by: NotifyActor;
  reason: string;
  /** Epoch ms. */
  at: number;
}

/** How an answer reached its asker: its open call, or typed into its tab. */
export interface NotifyDelivered {
  via: 'call' | 'tab';
  /** Epoch ms. */
  at: number;
}

/** Who reopened a closed item, from where, and which close that reversed. */
export interface NotifyReopened {
  by: NotifyActor;
  /** The device that reopened it, when another screen did. */
  device?: string;
  /** Epoch ms. */
  at: number;
  closedBy: NotifyActor;
  closedReason: string;
}

/** The person's Override of an answer, sent to the asker as a correction. */
export interface NotifyCorrection {
  summary: string;
  by: NotifyActor;
  /** Epoch ms. */
  at: number;
}
export interface NotifySource {
  /** The Pane the call came from, when it was linked to one. */
  paneId?: string;
  panelId?: string;
  /** The Pane's name, or the caller's folder name outside Pane. */
  name: string;
  /** Claude, Codex, Cursor, or the client's own name. */
  agent: string;
  /** The Session the asking Pane works in, resolved by the host when the item is made. Absent: "Not in a Session". */
  session?: NotifySession;
  /** The asking Pane's project, for Approvals' By project sort (D-176). Absent outside a project or from an older machine. */
  project?: string;
  /** Autopilot asked (its own approval, D-60): Approvals files it under "Autopilot", shown violet. */
  autopilot?: boolean;
}

/** The Session an item belongs to (Approvals groups by it). */
export interface NotifySession {
  id: string;
  name: string;
  /** The Session's own workspace Pane, which holds its orchestrator tabs. */
  paneId: string;
  /** The asking tab is one of the Session's orchestrator tabs (not a worker Pane's). */
  orchestrator?: boolean;
}

/**
 * A read-only mirror of a worker's question, sent only by an older machine: this build makes the
 * question itself an answerable item.
 */
export interface NotifyRelay {
  /** The Session inbox item it mirrors. */
  inboxItemId: string;
  /** The worker Pane's name. */
  worker: string;
  question: string;
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
  /** The device that answered, when another screen did; absent when this screen answered. */
  answeredOn?: string;
  /** The machine whose agent asked; set while a screen shows more than one machine's questions. */
  machine?: string;
  /** Epoch ms when a snoozed question comes back to the strip. */
  snoozedUntil?: number;
  /**
   * Snapshot only, with `machine`: `local` (this computer) or the saved machine's id. A saved
   * machine's card has the id `<machineId>:<its id there>`, as the glasses key cards.
   */
  machineId?: string;
  /** Snapshot only: its machine can't be reached right now, so an answer can't be sent. */
  unreachable?: boolean;
  /** Snapshot only: from a saved machine the app isn't on, so it offers no Open in Pane. */
  elsewhere?: boolean;
  /** From an older machine only (state `waiting`, never in `queue`): it takes no answer. */
  relay?: NotifyRelay;
  /** Where it came from. Absent from an older machine. */
  originKind?: NotifyOriginKind;
  /** The Session (or Pane, Autopilot, machine) it belongs to; every item has one. Absent from an older machine. */
  connected?: NotifyConnected;
  /** Who answered it, for the receipt. */
  answeredBy?: NotifyAnswerReceipt;
  /** Set when it closed without an answer; its state reads `expired` so older machines show it as ended. */
  closed?: NotifyClosed;
  /** Epoch ms when it went stale (3 days unanswered): grouped, never rings or pushes again. */
  staleSince?: number;
  /** A worker's question its orchestrator still has first call on: it shows, but doesn't ring yet. */
  quiet?: boolean;
  /** Autopilot rewrote an unclear item: this item is the rewrite of that one. */
  rewrittenFrom?: { id: string; title: string; qn?: string };
  /** Autopilot rewrote this item: it closed in favour of that one. */
  rewrittenAs?: { id: string; title: string };
  /** The answer reached the asker. */
  delivered?: NotifyDelivered;
  /** The answer can never be typed into the asking tab: why, and since when. Its owner stops trying. */
  undelivered?: { reason: string; at: number };
  /** The orchestrator recorded the answer as this D-n. */
  decision?: string;
  /** The person's Overrides, oldest first. */
  corrections?: NotifyCorrection[];
  /** The person brought it back after it closed: only they do, so it isn't to be closed again unasked. */
  reopened?: NotifyReopened;
  /** The phone was pushed for it; a restart doesn't push again. */
  pushed?: boolean;
  /** The one-time summary card after an upgrade: the items it offers to close, oldest first. */
  summaryOf?: string[];
  /** The person's latest typed reply and how it was taken. */
  reply?: NotifyReply;
  /** The current version: 1 (or absent) until the asker updates it. */
  version?: number;
  /** How the current version came to be (v2 and later). */
  revision?: NotifyRevision;
  /** Earlier versions, oldest first. */
  versions?: NotifyVersion[];
  /** Epoch ms when it came back updated after the person's question: "Updated · ready again" until answered or replied to. */
  readyAgain?: number;
  /** The orchestrator tab that relayed this worker's question: it reads a reply when the worker can't. */
  relayedBy?: { panelId: string; name: string };
}

/**
 * The person's typed reply on an approval (P1 of the approval card): the asker's agent (or the
 * next reader) reads it and says whether it was an answer or a question with `--took`.
 */
export interface NotifyReply {
  /** Each reply is delivered once, by id. */
  id: string;
  text: string;
  /** What was picked with it, one label per question, in order. */
  picks?: string[];
  /** Epoch ms. */
  at: number;
  /**
   * reading: delivered (or waiting for a busy reader) until it runs --took. answer / question:
   * how it was taken. unread: no agent can read replies right now. sent: a built-in question's
   * answer, typed into the chat tab's paused turn.
   */
  state: 'reading' | 'answer' | 'question' | 'unread' | 'sent';
  /** Who reads it: the asker, the orchestrator that relayed it, or Autopilot. */
  reader?: NotifyReplyReader;
  /** Epoch ms when its line was typed into the reader's tab or returned to its call. */
  deliveredAt?: number;
  /** --took question: what the reader is doing ("Getting more context…"). */
  status?: string;
  /** The person's fix of how it was taken, if they made one. */
  fixed?: 'answer' | 'question';
}

export interface NotifyReplyReader {
  kind: 'asker' | 'orchestrator' | 'autopilot';
  /** The tab that reads it; absent when it went back to the asker's open call. */
  panelId?: string;
  /** Who, as the approval names it: "doozy-overhaul", "the Doozy orchestrator", "Autopilot". */
  name: string;
}

/** An earlier version of an approval, kept on it (at most NOTIFY_VERSIONS_MAX in all, current included). */
export interface NotifyVersion {
  /** 1 for the first version. */
  version: number;
  title: string;
  context?: string;
  choices?: NotifyChoice[];
  questions?: NotifySubQuestion[];
  links?: NotifyLink[];
  /** Epoch ms when this version was asked. */
  at: number;
  /** How this version came to be, for v2 and later. */
  revision?: NotifyRevision;
}

/** Why a version exists: the person's question, and what the asker changed for it. */
export interface NotifyRevision {
  /** The person's question, as they typed it. */
  asked: string;
  /** The asker's own lines, one per change. */
  whatChanged: string[];
  /** Who changed it: the reader's name. */
  by: string;
  /** Epoch ms. */
  at: number;
}

/** An approval keeps at most this many versions, the current one included; older ones fold into the oldest. */
export const NOTIFY_VERSIONS_MAX = 10;

/** What the strip shows. Main decides; every surface renders the same thing. */
export type NotifyStripView =
  | { kind: 'question'; itemId: string }
  /** A quiet notice: an approval came back after the person's question (no chime). */
  | { kind: 'updated'; itemId: string; hideAt: number | null }
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
  /** Epoch ms; strips and sound are off until then. */
  pausedUntil: number | null;
  /** False when another app holds the answer-all shortcut. */
  shortcutRegistered: boolean;
  /** False where Pane can't float a window over other apps (native Wayland). */
  showOutsideSupported: boolean;
  /** Shown once: the first strip ever carries the "Click to answer" hint. */
  firstRun: boolean;
  /** Pane's Notify block in each agent's user-level instruction file. */
  instructionFiles: NotifyInstructionsFile[];
  /** Saved approvals couldn't be imported on this start: nothing was lost and it retries on the next. */
  importError?: { code: string; message: string; next: string };
}

/**
 * What a host shares with every connected screen and phone (`notify:remote-snapshot`, and the
 * `notify:shared-changed` event). Where the strip shows, focus and the round stay per screen.
 */
export interface NotifySharedState {
  /** The host's machine name, for the cards. */
  machine: string;
  /** Changes each time the host's Pane starts; with `revision`, orders a snapshot read against events. */
  epoch: string;
  /** Rises with every change; a screen ignores a state older than one it already applied. */
  revision: number;
  enabled: boolean;
  /** Each item's `answeredOn` names the device that answered it, the host's own screen included. */
  items: NotifyItem[];
  queue: string[];
  hidden: string[];
}

/** Commands a connected screen or phone sends the host (`notify:remote-command`). */
export type NotifyRemoteCommand =
  | { type: 'answer'; id: string; answer: NotifyAnswer }
  | { type: 'undo' | 'dismiss' | 'skip'; id: string }
  | { type: 'remind'; id: string; after: Exclude<NotifyRemindAfter, 'pane'> }
  /** A phone opens an item's link `index` beside its card, with the host's fallbacks (`paneId` is the Pane shown there). */
  | NotifyRemoteOpenLink
  /** The person closes an item, or undoes a close. A machine too old for these refuses them. */
  | { type: 'close'; id: string; reason?: string }
  | { type: 'reopen'; id: string }
  /** The person corrects an answer already sent. */
  | { type: 'override'; id: string; answer: NotifyAnswer }
  /** The person fixes how a reply was taken. A machine too old for it refuses it. */
  | NotifyFixCommand
  /** Autopilot on any machine acts on this machine's item, recorded as "by Autopilot" here. */
  | NotifyAgentAction;

/** What Autopilot does to an item, applied by the machine that holds it (D-165). */
export type NotifyAgentAction =
  | { type: 'agent-answer'; id: string; answer: NotifyAnswer; because: string; machine?: string }
  | { type: 'agent-close'; id: string; reason: string; machine?: string }
  /** `newId` names the rewrite, so the machine asking knows it without a reply. */
  | { type: 'agent-rewrite'; id: string; question: NotifyQuestion; reason?: string; machine?: string; newId?: string };

export interface NotifyRemoteOpenLink {
  type: 'open-link';
  id: string;
  index: number;
  paneId?: string;
}

/** Pane's Notify block in one agent's user-level instruction file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md). */
export interface NotifyInstructionsFile {
  agent: 'Claude Code' | 'Codex';
  file: string;
  /**
   * written: holds the current block. absent: holds none (Notify is off). not-found: the agent's
   * config folder doesn't exist. skipped: left as it was, for `reason`.
   */
  state: 'written' | 'absent' | 'not-found' | 'skipped';
  reason?: string;
}

/** Snooze takes 3m, 5m or 15m; the ✕ menu's reminders take 10m, 1h or pane. */
export type NotifyRemindAfter = '3m' | '5m' | '15m' | '10m' | '1h' | 'pane';

/**
 * A secret card is answered with `{ text }` (the value, saved on the host and dropped)
 * or declined with `{ approved: false }`.
 */
export type NotifyAnswer =
  /**
   * The approval column's one reply box: one pick per question (an empty string for none) and
   * anything typed. Picks alone are an answer; typed text is a reply its reader takes either way.
   */
  | { picks: string[]; text?: string }
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
  /** Approvals: open the item's link `index` as a tab of `paneId` (the Pane shown beside it), else of the asking Pane. */
  | { type: 'open-link'; id: string; index: number; paneId?: string }
  | { type: 'hover-info'; id: string; hovering: boolean }
  | { type: 'pause'; minutes: number }
  | { type: 'resume' }
  | { type: 'open-round'; id?: string }
  | { type: 'close-round' }
  | { type: 'open-inbox' }
  /** Show or Hide details on a pop-up card: the next card opens the same way. */
  | { type: 'show-details'; shown: boolean }
  /** Close: the item ends, and its asker is told. */
  | { type: 'close'; id: string; reason?: string }
  /** Reopen a closed item: it waits again. */
  | { type: 'reopen'; id: string }
  /** Override: the person's answer goes to the asker as a correction. */
  | { type: 'override'; id: string; answer: NotifyAnswer }
  /** The one-click fix of how a reply was taken: it was a question, or it was the answer. */
  | NotifyFixCommand;

/** "It was a question" on a reply taken as the answer, or "It was my answer" on one taken as a question. */
export interface NotifyFixCommand {
  type: 'fix-reply';
  id: string;
  as: 'answer' | 'question';
}

/** Where main sends the main window: Approvals (optionally on one item) or its settings. */
/**
 * Where main asks the window to go. `toggle-inbox` is the Notify shortcut
 * pressed while Pane is in front: Approvals, or back to where you were (D-251).
 */
export type NotifyNavigateTarget = 'inbox' | 'toggle-inbox' | 'settings' | { approval: string };

/** The floating windows report their card's size so main can fit and place them. */
export interface NotifyWindowSize {
  width: number;
  height: number;
}
