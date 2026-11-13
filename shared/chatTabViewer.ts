import { STREAM_FRAME_MS } from './constants/streamCadence';
import { applyChatTabEvent, type ChatTabClient, type ChatTabEvent, type ChatTabSend, type ChatTabTranscript, type ChatTabView } from './types/chatTab';

export interface ChatTabViewerState {
  view?: ChatTabView;
  transcript?: ChatTabTranscript;
  error?: string;
  draft: string;
  /** A send whose receipt has not come back; kept so it can be checked or retried with the same ID. */
  pendingDelivery?: ChatTabSend;
  loadingEarlier: boolean;
  /**
   * The window stops short of the newest message (it was trimmed while paging back).
   * Live events past its end only advance the revision; page forward with
   * loadNewer() or return with jumpToLatest().
   */
  hasNewer: boolean;
  loadingNewer: boolean;
}

/** Messages a viewer keeps mounted, in either direction. Others are paged in from the host when scrolled to. */
const WINDOW = 600;
const PAGE = 100;
const PENDING_LIMIT = 2000;

/**
 * A disposable subscription to one chat tab's host state. Detaching has no
 * effect on the agent; the draft and an unconfirmed send survive tab switches
 * and, through rebind(), a replaced connection to the same host.
 */
export class ChatTabViewer {
  private state: ChatTabViewerState = { draft: '', loadingEarlier: false, hasNewer: false, loadingNewer: false };
  private readonly listeners = new Set<() => void>();
  private detach?: () => void;
  private loading?: Promise<void>;
  /** A gap was found (or events were dropped) while a snapshot loaded: fetch again once it settles. */
  private resyncNeeded = false;
  private pending: ChatTabEvent[] = [];
  /** Bumped by rebind(); replies from an older transport are dropped. */
  private transport = 0;
  private frame?: ReturnType<typeof setTimeout>;
  private notifiedAt = 0;

  constructor(private chatClient: ChatTabClient, readonly panelId: string) {}

  snapshot = (): ChatTabViewerState => this.state;

  private publish(patch: Partial<ChatTabViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  /**
   * A live event updates the state at once but redraws at most once a stream frame: the
   * first event of a burst redraws immediately, the rest together at the frame's end.
   */
  private publishLive(patch: Partial<ChatTabViewerState>): void {
    this.state = { ...this.state, ...patch };
    if (this.frame) return;
    const wait = this.notifiedAt + STREAM_FRAME_MS - Date.now();
    if (wait <= 0) this.notify();
    else this.frame = setTimeout(() => this.notify(), wait);
  }

  private notify(): void {
    clearTimeout(this.frame);
    this.frame = undefined;
    this.notifiedAt = Date.now();
    this.listeners.forEach(listener => listener());
  }

  setDraft(draft: string): void { this.publish({ draft }); }
  setPendingDelivery(pendingDelivery?: ChatTabSend): void { this.publish({ pendingDelivery }); }
  setError(error?: string): void { this.publish({ error }); }

  /**
   * Moves this viewer to a new connection to the same host (host switched back,
   * URL or token replaced). Keeps the draft and the unconfirmed send; a live
   * subscription moves to the new client and reads the window again.
   */
  rebind(client: ChatTabClient): void {
    if (client === this.chatClient) return;
    this.chatClient = client;
    this.transport++;
    this.loading = undefined;
    this.resyncNeeded = false;
    this.pending = [];
    if (this.state.loadingEarlier || this.state.loadingNewer) this.publish({ loadingEarlier: false, loadingNewer: false });
    if (this.detach) {
      this.detach();
      this.attach();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) this.attach();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        clearTimeout(this.frame);
        this.frame = undefined;
        this.detach?.();
        this.detach = undefined;
        // Keep the draft and an unconfirmed send; release the heavy transcript.
        this.state = { ...this.state, transcript: undefined, hasNewer: false };
        this.pending = [];
      }
    };
  };

  private attach(): void {
    const client = this.chatClient;
    const events = client.onEvent(event => {
      if (event.panelId !== this.panelId) return;
      const transcript = this.state.transcript;
      if (this.loading || !transcript) {
        if (this.pending.length < PENDING_LIMIT) this.pending.push(event);
        else this.resyncNeeded = true;
        return;
      }
      if (this.state.hasNewer && event.generation === transcript.generation && event.index >= transcript.start + transcript.messages.length) {
        // Past the end of a window scrolled back from the newest: keep the window, track the revision.
        if (event.revision > transcript.revision + 1) { void this.refresh(); return; }
        if (event.revision === transcript.revision + 1) this.publishLive({ transcript: { ...transcript, revision: event.revision } });
        return;
      }
      const applied = applyChatTabEvent(transcript, event);
      if (applied.resync) { void this.refresh(); return; }
      this.publishLive({ transcript: this.state.hasNewer ? applied.transcript : this.bounded(applied.transcript) });
    });
    const states = client.onState(view => {
      if (view.panelId !== this.panelId) return;
      if (view.generation < (this.state.view?.generation ?? 0)) return;
      const newGeneration = view.generation !== this.state.transcript?.generation;
      // History replays while a tab starts; the window is only complete once it has.
      const finishedStarting = this.state.view?.status === 'starting' && view.status !== 'starting';
      this.publish({ view: { ...view, transcript: undefined } });
      if ((newGeneration || finishedStarting) && view.status !== 'starting') void this.refresh();
    });
    const reconnect = client.onReconnect?.(() => { void this.refresh(); });
    this.detach = () => { events(); states(); reconnect?.(); };
    void this.refresh();
  }

  /** A fresh snapshot of the newest window, then any events that arrived while it loaded. */
  refresh(): Promise<void> {
    if (this.loading) return this.loading;
    const transport = this.transport;
    const loading: Promise<void> = this.chatClient.get(this.panelId, PAGE * 2).then(view => {
      if (transport !== this.transport) return;
      let transcript = view.transcript;
      let gap = false;
      for (const event of this.pending) {
        if (!transcript) break;
        const applied = applyChatTabEvent(transcript, event);
        transcript = applied.transcript;
        gap ||= applied.resync;
      }
      this.pending = [];
      if (gap) this.resyncNeeded = true;
      this.publish({ view: { ...view, transcript: undefined }, transcript, hasNewer: false, error: gap ? this.state.error : this.state.pendingDelivery ? this.state.error : undefined });
    }).catch(error => {
      if (transport !== this.transport) return;
      this.resyncNeeded = false;
      this.setError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (this.loading !== loading) return;
      this.loading = undefined;
      // Only now does refresh() start a new fetch instead of returning this one.
      if (this.resyncNeeded) {
        this.resyncNeeded = false;
        if (this.detach) void this.refresh();
      }
    });
    this.loading = loading;
    return loading;
  }

  /** Back to the newest window and to following live events. */
  jumpToLatest(): Promise<void> { return this.refresh(); }

  /** Pages in older messages above the window, trimming the newest end to keep the window bounded. */
  async loadEarlier(): Promise<void> {
    const transcript = this.state.transcript;
    if (!transcript || transcript.start === 0 || this.state.loadingEarlier) return;
    const transport = this.transport;
    this.publish({ loadingEarlier: true });
    try {
      const older = await this.chatClient.history(this.panelId, transcript.start, PAGE);
      const current = this.state.transcript;
      if (transport !== this.transport || !current || current.generation !== transcript.generation || current.start !== transcript.start) return;
      let messages = [...older, ...current.messages];
      let hasNewer = this.state.hasNewer;
      if (messages.length > WINDOW + PAGE) { messages = messages.slice(0, WINDOW); hasNewer = true; }
      this.publish({ transcript: { ...current, start: current.start - older.length, messages }, hasNewer });
    } catch (error) {
      if (transport === this.transport) this.setError(error instanceof Error ? error.message : String(error));
    } finally { if (transport === this.transport) this.publish({ loadingEarlier: false }); }
  }

  /**
   * Pages in newer messages below a window that stops short of the newest,
   * trimming the oldest end. Reaching the newest message resumes following live events.
   */
  async loadNewer(): Promise<void> {
    const transcript = this.state.transcript;
    if (!transcript || !this.state.hasNewer || this.state.loadingNewer) return;
    const last = transcript.messages.at(-1);
    if (!last) { await this.refresh(); return; }
    const end = transcript.start + transcript.messages.length;
    const transport = this.transport;
    this.publish({ loadingNewer: true });
    try {
      // One message of overlap: history clips at the newest message, so finding the
      // window's last message later than the first slot means this page reached the end.
      const page = await this.chatClient.history(this.panelId, end + PAGE, PAGE + 1);
      const current = this.state.transcript;
      if (transport !== this.transport || !current || !this.state.hasNewer || current.generation !== transcript.generation
        || current.start !== transcript.start || current.messages.length !== transcript.messages.length) return;
      let overlap = page.length - 1;
      while (overlap >= 0 && page[overlap].id !== last.id) overlap--;
      if (overlap < 0) { await this.refresh(); return; }
      const newer = page.slice(overlap + 1);
      const reachedEnd = overlap > 0 || newer.length < PAGE;
      this.publish({ transcript: this.bounded({ ...current, messages: [...current.messages, ...newer] }), hasNewer: !reachedEnd });
    } catch (error) {
      if (transport === this.transport) this.setError(error instanceof Error ? error.message : String(error));
    } finally { if (transport === this.transport) this.publish({ loadingNewer: false }); }
  }

  /** Keeps the newest WINDOW messages mounted while following the end of the chat. */
  private bounded(transcript: ChatTabTranscript): ChatTabTranscript {
    const extra = transcript.messages.length - WINDOW;
    if (extra <= PAGE) return transcript;
    return { ...transcript, start: transcript.start + extra, messages: transcript.messages.slice(extra) };
  }
}

const viewers = new WeakMap<ChatTabClient, Map<string, ChatTabViewer>>();
/** A viewer per client object, for a surface whose client lives as long as the app (desktop, PWA). */
export function chatTabViewer(client: ChatTabClient, panelId: string): ChatTabViewer {
  let byPanel = viewers.get(client);
  if (!byPanel) { byPanel = new Map(); viewers.set(client, byPanel); }
  let viewer = byPanel.get(panelId);
  if (!viewer) { viewer = new ChatTabViewer(client, panelId); byPanel.set(panelId, viewer); }
  return viewer;
}

/**
 * Viewers per saved host and panel, for a surface that replaces its connection
 * (the phone: host A→B→A, a new URL or token). The draft and the unconfirmed
 * send's operation ID belong to the host, not to its replaceable client.
 */
export class ChatTabViewerRegistry {
  private readonly hosts = new Map<string, Map<string, ChatTabViewer>>();

  forPanel(hostId: string, panelId: string, client: ChatTabClient): ChatTabViewer {
    let panels = this.hosts.get(hostId);
    if (!panels) { panels = new Map(); this.hosts.set(hostId, panels); }
    let viewer = panels.get(panelId);
    if (!viewer) { viewer = new ChatTabViewer(client, panelId); panels.set(panelId, viewer); }
    else viewer.rebind(client);
    return viewer;
  }
}
